import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { missingIn, type Tokens } from "./host-files";

/**
 * How one session start goes, as launch() in ssh.ts plans it. The start's remote command checks
 * the host first (see checkScript), so claude starts only once the host has what it needs.
 */
export type Plan = {
  /** ssh's argv for the start: the check, then claude. Without `shared`, a connection of its own. */
  start(shared: boolean): string[];
  /** ssh's argv and stdin for copying the needs the check found missing, by index. */
  upload(missing: number[], shared: boolean): { argv: string[]; input: Uint8Array };
  tokens: Tokens;
  /**
   * Gets what follows the token on the ready line, claude's version when the start asked for it,
   * and returns why claude must not go on, if it mustn't.
   */
  ready?(rest: string): string | undefined;
  /** Why nothing may start at all, such as a host claude known to be too old. */
  refuse?: string;
  signal?: AbortSignal;
};

/**
 * What ssh says, exiting with 255, when sshd refuses the multiplexing master another session (its
 * MaxSessions, 10 by default): a sign to try once more on a connection of our own.
 */
export const REFUSED = /administratively prohibited|session request failed|session open refused/i;

/** Output kept from a channel before claude starts: shown when it fails, or once claude is up. */
const HELD_BYTES = 64 << 10;

/** Takes a stream's output a line at a time. */
function lines(onLine: (line: string) => void) {
  let rest = "";
  return {
    push(chunk: Buffer | string) {
      rest += chunk.toString();
      for (let nl = rest.indexOf("\n"); nl >= 0; nl = rest.indexOf("\n")) {
        onLine(rest.slice(0, nl).replace(/\r$/, ""));
        rest = rest.slice(nl + 1);
      }
    },
    flush() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}

/**
 * claude's stdin across attempts: what the SDK writes before claude is up waits here, and goes to
 * the claude that started, once, followed by everything after it.
 */
class Gate extends Writable {
  private held: Buffer[] = [];
  private target?: Writable;
  private ended = false;

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    if (!this.target) {
      this.held.push(chunk);
      return done();
    }
    // A claude that went away shows up as the exit event; a write racing it is dropped.
    this.target.write(chunk, () => done());
  }

  override _final(done: (error?: Error | null) => void) {
    if (this.target) this.target.end();
    else this.ended = true;
    done();
  }

  open(target: Writable) {
    target.on("error", () => {});
    for (const chunk of this.held) target.write(chunk);
    this.held = [];
    this.target = target;
    if (this.ended) target.end();
  }
}

type Outcome =
  | { kind: "started" }
  | { kind: "error" }
  | { kind: "stopped"; code: number | null; signal: NodeJS.Signals | null; held: string; missing?: number[]; refused: boolean; rejected: boolean };

/**
 * claude on the host, as one process with one stdin and one stdout, though getting it started may
 * take more than one ssh: when the check finds something missing, it goes up and the start runs
 * again; when sshd refuses the shared connection another session, the start runs on a connection
 * of its own. Offers what the SDK and the proxy use of a ChildProcess.
 */
export class HostProcess extends EventEmitter {
  readonly stdin = new Gate();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** How many ssh processes this start ran, for tests and diagnostics. */
  channels = 0;
  private current?: ChildProcess;
  private stopping = false;
  private started = false;
  private done = false;

  constructor(private readonly plan: Plan) {
    super();
    if (plan.signal?.aborted) this.stopping = true;
    plan.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
    // After the caller has had its turn to listen.
    queueMicrotask(() => void this.run());
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.done) return false;
    this.stopping = true;
    this.killed = true;
    return this.current ? this.current.kill(signal) : true;
  }

  private async run() {
    if (this.plan.refuse) {
      process.stderr.write(`cc-remote: ${this.plan.refuse}\n`);
      return this.finish(1, null);
    }
    let shared = true;
    let uploaded = false;
    for (;;) {
      if (this.stopping) return this.finish(null, "SIGTERM");
      const r = await this.attempt(shared);
      if (r.kind !== "stopped") return;
      if (r.rejected) {
        process.stderr.write(r.held);
        return this.finish(1, null);
      }
      if (!this.stopping && r.refused && r.code === 255 && shared) {
        shared = false;
        continue;
      }
      if (!this.stopping && r.missing?.length && !uploaded) {
        uploaded = true;
        const up = await this.upload(r.missing, shared);
        shared = up.shared;
        if (up.ok) continue;
        process.stderr.write(up.held);
        if (!this.stopping) process.stderr.write("cc-remote: could not copy what claude needs to the host\n");
        return this.finish(up.code ?? 1, up.signal);
      }
      process.stderr.write(r.held);
      if (r.missing?.length) process.stderr.write("cc-remote: the host still lacks what was just copied to it\n");
      return this.finish(r.code, r.signal);
    }
  }

  private spawn(argv: string[]): ChildProcess {
    this.channels++;
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.current = child;
    child.stdin!.on("error", () => {});
    return child;
  }

  /** One run of the start: claude is up once the ready line arrives, and not before. */
  private attempt(shared: boolean): Promise<Outcome> {
    const { tokens } = this.plan;
    const child = this.spawn(this.plan.start(shared));
    return new Promise((settle) => {
      let held = "";
      let missing: number[] | undefined;
      let refused = false;
      let rejected = false;
      let up = false;
      const hold = (line: string) => {
        if (held.length < HELD_BYTES) held += `${line}\n`;
      };
      const errors = lines((line) => {
        const found = missingIn(line, tokens);
        if (found) return void (missing = found);
        if (REFUSED.test(line)) refused = true;
        hold(line);
      });
      child.stderr!.on("data", (chunk: Buffer) => (up ? process.stderr.write(chunk) : errors.push(chunk)));

      // Before the ready line, stdout is the host's: a chatty login shell, say. It's shown as
      // diagnostics, and never reaches the SDK.
      let pending = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (let nl = pending.indexOf(10); nl >= 0; nl = pending.indexOf(10)) {
          const line = pending.subarray(0, nl).toString().replace(/\r$/, "");
          pending = pending.subarray(nl + 1);
          if (line.startsWith(tokens.ready)) return ready(line.slice(tokens.ready.length).trim());
          hold(line);
        }
      };
      const ready = (rest: string) => {
        child.stdout!.off("data", onData);
        const problem = this.plan.ready?.(rest);
        if (problem) {
          // claude has just started on the host; without its input it ends with the channel.
          this.stopping = rejected = true;
          held += `cc-remote: ${problem}\n`;
          child.kill("SIGTERM");
          return;
        }
        up = this.started = true;
        errors.flush();
        process.stderr.write(held);
        if (pending.length) this.stdout.write(pending);
        child.stdout!.pipe(this.stdout);
        this.stdin.open(child.stdin!);
        const exited = () => this.finish(child.exitCode, child.signalCode);
        if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(exited);
        else child.once("exit", exited);
        child.on("error", (e) => this.emit("error", e));
        settle({ kind: "started" });
      };
      child.stdout!.on("data", onData);

      child.once("error", (e) => {
        if (up) return;
        this.fail(e);
        settle({ kind: "error" });
      });
      // close, not exit: everything it printed has been read by then.
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (up || this.done) return;
        errors.flush();
        if (pending.length) hold(pending.toString());
        settle({ kind: "stopped", code: child.exitCode ?? code, signal: child.signalCode ?? signal, held, missing, refused, rejected });
      });
      if (this.stopping) child.kill("SIGTERM");
    });
  }

  /** Copies the missing needs to the host over one more channel, or two when sshd refuses it one. */
  private async upload(missing: number[], shared: boolean) {
    for (;;) {
      const { argv, input } = this.plan.upload(missing, shared);
      const child = this.spawn(argv);
      let held = "";
      child.stdout!.on("data", (chunk: Buffer) => { if (held.length < HELD_BYTES) held += chunk; });
      child.stderr!.on("data", (chunk: Buffer) => { if (held.length < HELD_BYTES) held += chunk; });
      child.stdin!.end(input);
      if (this.stopping) child.kill("SIGTERM");
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
        child.once("error", (e) => {
          held += `cc-remote: ${e.message}\n`;
          settle({ code: 1, signal: null });
        });
        child.once("close", (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }));
      });
      if (result.code === 255 && shared && !this.stopping && REFUSED.test(held)) {
        shared = false;
        continue;
      }
      return { ok: result.code === 0, shared, held, ...result };
    }
  }

  private fail(error: Error) {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.emit("error", error);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.signalCode = signal;
    if (!this.started) this.stdout.end();
    this.emit("exit", code, signal);
  }
}
