import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { missingIn, type Tokens } from "./host-files";
import { WINDOWS } from "./platform";
import { type ExecResult, GONE_TOKEN, RelayClient } from "./relay";

/**
 * How a session under the relay (relay.ts) keeps going after the link drops: heartbeats, the
 * reconnect, and what a reconnect runs.
 */
export type RelayPlan = {
  /** ssh's argv that attaches to the relay again: always a connection of its own. */
  attach(): string[];
  /** The line the attach command prints before the relay's frames, after anything the host's shell says. */
  token: string;
  /** A heartbeat this often. */
  pingMs: number;
  /** The link counts as dead after this long without a frame. */
  linkTimeoutMs: number;
  /** How long the host keeps claude without a connection; reconnecting stops when it runs out. */
  graceMs: number;
  /** The link went silent: a shared connection to the host may be just as stuck. */
  silent?(): void;
};

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
   * Gets what follows the token on the ready line (see Ready in host-files.ts), and says why
   * claude must not go on, if it mustn't, and whether claude started under the relay.
   */
  ready?(rest: string): { problem?: string; relay?: boolean };
  /** Why nothing may start at all, such as a host claude known to be too old. */
  refuse?: string;
  signal?: AbortSignal;
  /** When the start may come up under the relay, how to keep it going. */
  relay?: RelayPlan;
};

/** After a SIGTERM, how long the host has to report claude's exit before cc-remote goes anyway. */
export const STOP_WAIT_MS = 2_000;

/** Reconnect attempts after the first, which is immediate: then 1, 2, 4, 8 and every 15 seconds. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Sessions under the relay, to stop as cc-remote exits. */
const live = new Set<HostProcess>();

/**
 * Asks every session under the relay to stop claude, and waits for their exits, each at most
 * STOP_WAIT_MS: an exiting cc-remote that only dropped its connections would leave claude running
 * on the host for the grace period.
 */
export async function stopRelays(): Promise<void> {
  await Promise.all([...live].map((h) => new Promise<void>((done) => {
    h.once("exit", () => done());
    if (!h.kill("SIGTERM")) done();
  })));
}

/**
 * What ssh says, exiting with 255, when sshd refuses the multiplexing master another session (its
 * MaxSessions, 10 by default): a sign to try once more on a connection of our own.
 */
export const REFUSED = /administratively prohibited|session request failed|session open refused/i;

/** Output kept from a channel before claude starts: shown when it fails, or once claude is up. */
const HELD_BYTES = 64 << 10;

/**
 * Stops a claude that started under the relay but must not go on: connects, asks for the end,
 * and closes the channel once it comes (or after a few seconds).
 */
function stopAtOnce(child: ChildProcess, pending: Buffer) {
  const end = () => child.stdin!.end();
  const client = new RelayClient({ output() {}, stderr() {}, exit: end });
  client.connect((bytes) => child.stdin!.writable && child.stdin!.write(bytes));
  client.terminate();
  const feed = (chunk: Buffer) => {
    try {
      client.receive(chunk);
    } catch {
      end();
    }
  };
  child.stdout!.on("data", feed);
  if (pending.length) feed(pending);
  setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
}

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
  /** Under the relay: the protocol's state, the connection it uses now, and its timers. */
  private client?: RelayClient;
  private conn?: ChildProcess;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopTimer?: ReturnType<typeof setTimeout>;
  private reconnecting = false;
  private onHello?: () => void;
  private wakers = new Set<() => void>();
  private lastError = "";
  /** Whether the ssh running now is a start, which may come up under the relay. */
  private starting = false;
  private stopSignal: NodeJS.Signals = "SIGTERM";

  constructor(private readonly plan: Plan) {
    super();
    if (plan.signal?.aborted) this.stopping = true;
    plan.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
    // After the caller has had its turn to listen.
    queueMicrotask(() => void this.run());
  }

  /** The pid of the ssh that carries the relay now, for tests and diagnostics. */
  get link(): number | undefined {
    return this.conn?.pid;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.done) return false;
    this.stopping = true;
    this.killed = true;
    this.stopSignal = signal;
    if (this.plan.relay && !this.client && this.starting && this.current) {
      // The start may have claude running under the relay already, which would outlive the
      // channel: its ready line gets a moment to come, and then the relay stops claude.
      const start = this.current;
      this.stopTimer ??= setTimeout(() => start.kill("SIGKILL"), STOP_WAIT_MS);
      return true;
    }
    if (this.client) {
      // Dropping the connection would leave claude running on the host; the relay stops it.
      this.client.terminate();
      this.stopTimer ??= setTimeout(() => this.endRelay(null, signal, true), STOP_WAIT_MS);
      return true;
    }
    return this.current ? this.current.kill(signal) : true;
  }

  /**
   * Runs a shell script on the host over the relay's connection, in claude's folder there, when
   * claude runs under the relay. Rejects at once otherwise, and when the session ends first.
   */
  exec(script: string, input?: Uint8Array): Promise<ExecResult> {
    if (!this.client || this.done) return Promise.reject(new Error("no relay"));
    return this.client.exec(script, input);
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
      if (this.killed) return this.finish(null, this.stopSignal);
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
    // Under the relay, ssh gets a process group of its own: a signal to cc-remote's group, as Orca
    // sends to stop a chat, must leave the connection up for cc-remote to stop claude through it.
    const detached = !!this.plan.relay && !WINDOWS;
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached });
    this.current = child;
    child.stdin!.on("error", () => {});
    return child;
  }

  /** One run of the start: claude is up once the ready line arrives, and not before. */
  private attempt(shared: boolean): Promise<Outcome> {
    const { tokens } = this.plan;
    const child = this.spawn(this.plan.start(shared));
    this.starting = true;
    child.once("close", () => (this.starting = false));
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
          if (line.startsWith(tokens.ready)) return ready(line.slice(tokens.ready.length));
          hold(line);
        }
      };
      const ready = (rest: string) => {
        child.stdout!.off("data", onData);
        const answer = this.plan.ready?.(rest) ?? {};
        const relay = !!answer.relay && !!this.plan.relay;
        if (answer.problem || this.stopping) {
          rejected = !!answer.problem;
          this.stopping = true;
          if (answer.problem) held += `cc-remote: ${answer.problem}\n`;
          // claude has just started on the host. Without its input it ends with the channel, but
          // under the relay it would outlive it: there the relay stops it.
          if (relay) stopAtOnce(child, pending);
          else child.kill("SIGTERM");
          return;
        }
        up = this.started = true;
        errors.flush();
        process.stderr.write(held);
        if (relay) {
          this.startRelay(child, pending);
          return settle({ kind: "started" });
        }
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
      if (this.stopping && !this.plan.relay) child.kill("SIGTERM");
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

  /** claude is up under the relay, on the start's channel: from here on, the relay protocol. */
  private startRelay(first: ChildProcess, pending: Buffer) {
    const relay = this.plan.relay!;
    const client = (this.client = new RelayClient({
      output: (chunk) => this.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
      exit: (code, signal) => {
        // The client said bye; ending the channel ends the host's side of it.
        this.conn?.stdin?.end();
        this.endRelay(code, signal);
      },
      hello: () => this.onHello?.(),
      fatal: (message) => this.relayFailed(`cc-remote: ${message}`),
    }));
    this.stdin.open(new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        client.write(chunk);
        done();
      },
      final: (done) => {
        client.end();
        done();
      },
    }));
    if (this.stopping) client.terminate();
    live.add(this);
    this.timers.push(setInterval(() => client.ping(), relay.pingMs));
    this.timers.push(setInterval(() => this.watch(), Math.min(1_000, relay.linkTimeoutMs / 4)));
    void this.connection(first, { initial: pending }).then((r) => {
      if (r !== "up") void this.reconnect();
    });
  }

  /**
   * A link silent past the timeout is dead: its ssh goes, which starts a reconnect. Only a
   * connection the daemon has taken up counts; one still connecting has its own time limit.
   */
  private watch() {
    const relay = this.plan.relay!;
    const conn = this.conn;
    if (!conn || this.done || !this.client?.connected || Date.now() - this.client.lastFrame <= relay.linkTimeoutMs) return;
    process.stderr.write(`cc-remote: no word from the host for ${Math.round(relay.linkTimeoutMs / 1000)}s\n`);
    this.conn = undefined;
    this.client.disconnect();
    relay.silent?.();
    // A frozen ssh may never get to a SIGTERM.
    conn.kill("SIGKILL");
  }

  /**
   * One connection to the relay, the start's or a reconnect's: settles "up" once the daemon has
   * said hello on it, "gone" when the host has no daemon for this session any more, and "failed"
   * when the connection ends before either. A connection that was up and drops starts a reconnect.
   */
  private connection(child: ChildProcess, how: { initial?: Buffer; token?: string }): Promise<"up" | "gone" | "failed"> {
    const client = this.client!;
    const relay = this.plan.relay!;
    this.conn = child;
    return new Promise((settle) => {
      let framing = !how.token;
      let up = false;
      let ran = false;
      let err = "";
      let lines = Buffer.alloc(0);
      const timer = setTimeout(() => { if (!up) child.kill("SIGKILL"); }, relay.linkTimeoutMs);
      const frames = (chunk: Buffer) => {
        try {
          client.receive(chunk);
        } catch (e) {
          process.stderr.write(`cc-remote: ${(e as Error).message}\n`);
          child.kill("SIGKILL");
        }
      };
      const begin = () => {
        framing = true;
        client.connect((bytes) => {
          if (this.conn === child && child.stdin!.writable) child.stdin!.write(bytes);
        });
      };
      this.onHello = () => {
        if (this.conn !== child || up) return;
        up = true;
        clearTimeout(timer);
        settle("up");
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (framing) return frames(chunk);
        lines = Buffer.concat([lines, chunk]);
        for (let nl = lines.indexOf(10); nl >= 0; nl = lines.indexOf(10)) {
          const line = lines.subarray(0, nl).toString().replace(/\r$/, "");
          lines = lines.subarray(nl + 1);
          if (line !== how.token) continue; // The host's shell talking.
          ran = true;
          begin();
          if (lines.length) frames(lines);
          return;
        }
      });
      if (how.token) {
        child.stderr!.on("data", (chunk: Buffer) => {
          if (up) process.stderr.write(chunk);
          else if (err.length < HELD_BYTES) err += chunk;
        });
      } else {
        begin();
        if (how.initial?.length) frames(how.initial);
      }
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (this.conn === child) {
          this.conn = undefined;
          client.disconnect();
        }
        if (up) {
          if (!this.done) void this.reconnect();
          return;
        }
        this.lastError = err.trim().split("\n").filter((l) => !l.includes(GONE_TOKEN)).pop() ?? "";
        // The host ran the attach and it found no daemon, or the daemon never answered.
        settle(err.includes(GONE_TOKEN) || ran ? "gone" : "failed");
      };
      child.once("close", close);
      child.once("error", (e) => {
        err += `${e.message}\n`;
        close();
      });
    });
  }

  /**
   * Attaches to the relay again, over connections of its own: at once, then with a growing pause,
   * for as long as the host keeps claude without a connection.
   */
  private async reconnect() {
    if (this.reconnecting || this.done || !this.client) return;
    this.reconnecting = true;
    const relay = this.plan.relay!;
    if (!this.stopping) process.stderr.write("cc-remote: lost the connection to the host; reconnecting\n");
    const deadline = this.client.lastFrame + relay.graceMs;
    for (let attempt = 0; !this.done; attempt++) {
      const wait = attempt ? BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]! : 0;
      if (Date.now() + wait > deadline) {
        const why = this.lastError ? ` (${this.lastError})` : "";
        return this.relayFailed(`cc-remote: could not reconnect to the host${why}; this claude is gone, and the next message resumes the session`);
      }
      if (wait) await this.sleep(wait);
      if (this.done) return;
      const child = this.spawn(relay.attach());
      const r = await this.connection(child, { token: relay.token });
      // One that came up and dropped at once asked for a reconnect while this one still ran.
      if (r === "up" && this.conn !== child) continue;
      if (r === "up") {
        this.reconnecting = false;
        if (!this.stopping) process.stderr.write("cc-remote: reconnected\n");
        return;
      }
      if (r === "gone") {
        return this.relayFailed("cc-remote: claude on the host is gone (the host restarted, or the session was taken up elsewhere); the next message resumes the session");
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((done) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        done();
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }

  private relayFailed(message: string) {
    if (this.done) return;
    // Asked to stop, it reports the stop, as a session that got there would.
    if (this.killed) return this.endRelay(null, this.stopSignal, true);
    process.stderr.write(`${message}\n`);
    this.endRelay(255, null);
  }

  /**
   * The end of a session under the relay: everything it wrote is out, its timers and connection
   * go; at once when `abandon`, since nothing more will come over it.
   */
  private endRelay(code: number | null, signal: NodeJS.Signals | null, abandon = false) {
    if (this.done) return;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.stopTimer);
    for (const wake of [...this.wakers]) wake();
    live.delete(this);
    this.client?.failExecs(new Error("the session has ended"));
    const conn = this.conn;
    this.conn = undefined;
    // After an exit the channel closes by itself, once the host has the bye.
    if (conn && abandon) conn.kill("SIGKILL");
    else if (conn) setTimeout(() => conn.kill("SIGKILL"), 5_000).unref();
    this.stdout.end();
    this.finish(code, signal);
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
    clearTimeout(this.stopTimer);
    this.exitCode = code;
    this.signalCode = signal;
    if (!this.started) this.stdout.end();
    this.emit("exit", code, signal);
  }
}
