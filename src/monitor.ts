import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import type { Watcher, WatchLink } from "./host-process";
import { SHELL, WINDOWS } from "./platform";
import { refusal, type ShellTool } from "./rules";
import { quote } from "./sh";
import { loginLaunch } from "./tools/login";
import { groups, stop } from "./tools/shell";
import type { Workspace } from "./tools/util";

/** Monitor's input, as claude's own tool takes it. */
export type MonitorInput = {
  command?: string;
  ws?: { url: string; protocols?: string[] };
  description?: string;
  timeout_ms?: number;
  [key: string]: unknown;
};

/**
 * What a Monitor command becomes on the host: relay.py's `monitor`, through the variables the
 * relay daemon gives claude, with a one-time token and, for whoever reads the command line
 * (a person asked to approve it, auto mode's classifier), the command it stands for.
 */
const RELAY_MONITOR = '"$CC_REMOTE_PYTHON" -S "$CC_REMOTE_RELAY" monitor';
const TOKEN = /^"\$CC_REMOTE_PYTHON" -S "\$CC_REMOTE_RELAY" monitor ([0-9a-f]{32})(?: |$)/;

/** Approvals kept for a monitor process to claim; one that never comes (the call was refused) goes in time. */
const KEEP = 64;

/** Output the host has yet to take before reading a command's stdout pauses, which pauses the command. */
const MAX_PENDING = 1 << 20;

/** After a command exits, how long a child it left in the background may keep its output open. */
const DRAIN_MS = 500;

export type Approval = {
  /** What the model asked for. */
  input: MonitorInput;
  /** What claude runs instead. */
  rewritten: MonitorInput;
  /** The shell's directory when the model asked: the command runs there, as a Bash command would. */
  cwd: string;
  /** Whether the user's rules say a person must approve it. */
  ask: boolean;
};

type Running = {
  stopped: boolean;
  pid?: number;
  socket?: WebSocket;
  /** Reading stdout waits on this while the host has too much of it. */
  resume?: () => void;
  readers: ReadableStreamDefaultReader<Uint8Array>[];
};

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * claude's Monitor, run on this machine. claude on the host runs Monitor in its own shell, so
 * cc-remote's PreToolUse hook (policy.ts) rewrites the call: the command becomes a monitor process
 * of relay.py's, which asks the relay daemon to have cc-remote run what the model asked for here,
 * under a token only that call carries. The command runs in the user's login shell, in the
 * directory the session's shell is in, and its stdout and stderr go back to the monitor process,
 * whose stdout lines are claude's events; when it exits, the monitor process exits with its status.
 * When the monitor process goes (claude stopped the watch, or its time ran out), the command is
 * stopped here, its whole process group. A WebSocket watch (`ws`) is opened here too: each text
 * frame is a line, newlines escaped.
 *
 * Output waits here while the link is down, and reading pauses, which pauses the command, while
 * the host is behind by more than MAX_PENDING.
 */
export class Monitors implements Watcher {
  private approvals = new Map<string, Approval>();
  private running = new Map<number, Running>();

  constructor(private readonly ws: Workspace, private readonly link: WatchLink) {
    link.serve(this);
  }

  /** The input claude runs in place of `input`, approved under a token of its own. */
  approve(input: MonitorInput, ask = false): MonitorInput {
    const token = randomUUID().replaceAll("-", "");
    const shown = typeof input.command === "string" ? input.command : String(input.ws?.url ?? "");
    const { ws: _ws, command: _command, ...rest } = input;
    const rewritten: MonitorInput = { ...rest, command: `${RELAY_MONITOR} ${token} ${quote(shown)}` };
    this.approvals.set(token, { input, rewritten, cwd: this.ws.cwd, ask });
    while (this.approvals.size > KEEP) this.approvals.delete(this.approvals.keys().next().value!);
    return rewritten;
  }

  /** The approval a rewritten input carries, as a permission request shows it. */
  find(input: unknown): Approval | undefined {
    const command = (input as MonitorInput | undefined)?.command;
    const token = typeof command === "string" ? TOKEN.exec(command)?.[1] : undefined;
    return token ? this.approvals.get(token) : undefined;
  }

  /**
   * After a person approved `answered` where the request showed what the model asked for: the
   * rewritten input to run, a new one when they changed what they were shown.
   */
  answered(approval: Approval, answered: unknown): MonitorInput {
    if (!answered || JSON.stringify(answered) === JSON.stringify(approval.input)) return approval.rewritten;
    return this.approve(answered as MonitorInput, approval.ask);
  }

  start(id: number, token: string) {
    const approval = this.approvals.get(token);
    this.approvals.delete(token);
    if (!approval) return this.fail(id, "cc-remote: this Monitor command was not approved here, or was run already");
    if (approval.input.ws) return this.socket(id, approval.input.ws);
    const command = String(approval.input.command ?? "");
    // The user's deny rules hold in every mode, as for Bash.
    const denied = refusal(command, this.ws.root, SHELL as ShellTool);
    if (denied) return this.fail(id, `cc-remote: ${denied}`);
    void this.spawn(id, command, approval.cwd).catch((e) => this.fail(id, `cc-remote: could not run the command: ${(e as Error).message}`));
  }

  acked(id: number) {
    const r = this.running.get(id);
    const resume = r?.resume;
    if (r) r.resume = undefined;
    resume?.();
  }

  closed(id: number) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    r.stopped = true;
    if (r.pid !== undefined) stop(r.pid);
    r.socket?.close();
    r.resume?.();
    for (const reader of r.readers) void reader.cancel().catch(() => {});
  }

  closeAll() {
    for (const id of [...this.running.keys()]) this.closed(id);
  }

  private fail(id: number, message: string) {
    this.running.delete(id);
    this.link.stderr(id, encode(`${message}\n`));
    this.link.end(id, 1);
  }

  private async spawn(id: number, command: string, cwd: string) {
    const r: Running = { stopped: false, readers: [] };
    this.running.set(id, r);
    // A login shell snapshot that failed to load means the command never started: one more launch.
    for (let attempt = 0; ; attempt++) {
      const launch = await loginLaunch(`${this.ws.envFile ? `. ${quote(this.ws.envFile)}\n` : ""}${command}`, cwd);
      if (r.stopped) return void launch.done?.();
      const proc = Bun.spawn(launch.argv, {
        cwd, detached: !WINDOWS, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: Bun.env,
      });
      r.pid = proc.pid;
      groups.add(proc.pid);
      const piping = Promise.all([this.pipe(id, r, proc.stdout, true), this.pipe(id, r, proc.stderr, false)]);
      await proc.exited;
      groups.delete(proc.pid);
      // A child left in the background (`cmd &`) can hold the pipes open after the shell exits. It
      // gets DRAIN_MS; reading paused for the host doesn't count, or the last output would be lost.
      for (;;) {
        const drained = await Promise.race([piping.then(() => true), Bun.sleep(DRAIN_MS).then(() => false)]);
        if (drained || r.stopped || !r.resume) break;
      }
      for (const reader of r.readers.splice(0)) void reader.cancel().catch(() => {});
      const never = launch.done?.() === true;
      if (r.stopped) return;
      if (never && attempt === 0) continue;
      this.running.delete(id);
      const signal = proc.signalCode ? constants.signals[proc.signalCode as keyof typeof constants.signals] : undefined;
      return this.link.end(id, proc.exitCode ?? 128 + (signal ?? 9));
    }
  }

  /** Passes a stream on to the host; stdout only as fast as the host takes it. */
  private async pipe(id: number, r: Running, stream: ReadableStream<Uint8Array>, stdout: boolean) {
    const reader = stream.getReader();
    r.readers.push(reader);
    try {
      for (;;) {
        while (stdout && !r.stopped && this.link.pending(id) > MAX_PENDING) await new Promise<void>((go) => (r.resume = go));
        if (r.stopped) return;
        const { done, value } = await reader.read();
        if (done || r.stopped) return;
        if (stdout) this.link.output(id, value);
        else this.link.stderr(id, value);
      }
    } catch {
      // Cancelled: the command was stopped, or left a child holding its output.
    }
  }

  private socket(id: number, spec: NonNullable<MonitorInput["ws"]>) {
    let socket: WebSocket;
    try {
      socket = new WebSocket(String(spec.url), Array.isArray(spec.protocols) ? spec.protocols : []);
    } catch (e) {
      return this.fail(id, `cc-remote: could not open ${spec.url}: ${(e as Error).message}`);
    }
    const r: Running = { stopped: false, socket, readers: [] };
    this.running.set(id, r);
    socket.binaryType = "arraybuffer";
    const line = (text: string) => this.link.output(id, encode(`${text}\n`));
    socket.addEventListener("message", (e) => {
      if (r.stopped) return;
      if (typeof e.data === "string") line(e.data.replace(/\r?\n/g, "\\n"));
      else line(`[binary frame, ${(e.data as ArrayBuffer).byteLength} bytes]`);
    });
    socket.addEventListener("close", (e) => {
      if (r.stopped) return;
      this.running.delete(id);
      const clean = e.code === 1000 || e.code === 1005;
      if (!clean) this.link.stderr(id, encode(`cc-remote: ${spec.url} closed: ${e.code}${e.reason ? ` ${e.reason}` : ""}\n`));
      this.link.end(id, clean ? 0 : 1);
    });
  }
}
