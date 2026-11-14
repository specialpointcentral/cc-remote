import { createHash } from "node:crypto";
import source from "./relay.py" with { type: "text" };

/**
 * The relay (relay.py) keeps a stream session's claude running on the host when the ssh link
 * drops: a daemon there runs claude with pipes and keeps its output until cc-remote has it, and
 * cc-remote keeps claude's input until the daemon has it. After a reconnect each side replays what
 * the other lacks, so the SDK sees exactly the bytes claude wrote, once, and claude the SDK's.
 *
 * The script goes to the host like a plugin, under a name that changes with its content.
 */
export const RELAY_SOURCE = new TextEncoder().encode(source);
export const RELAY_HASH = createHash("sha256").update(RELAY_SOURCE).digest("hex").slice(0, 16);
/** Where the script lives on the host, relative to its home. */
export const RELAY_PATH = `.cc-remote/bin/relay-${RELAY_HASH}.py`;
/** What `relay attach` prints on stderr, and exits with, when the host has no daemon for it. */
export const GONE_TOKEN = "cc-remote-relay-v1-gone";

/** Frame types, as relay.py has them. */
export const F = {
  // Daemon to cc-remote.
  OUT: 1, ERR: 2, IN_ACK: 3, PONG: 4, HELLO: 5, EXIT: 6, RESULT: 7, FATAL: 8,
  WATCH: 9, WATCH_ACK: 10, WATCH_CLOSED: 11,
  // cc-remote to daemon.
  IN: 16, OUT_ACK: 17, PING: 18, HELLO_CLIENT: 19, CLOSE_IN: 20, TERM: 21, BYE: 22, EXEC: 23,
  WATCH_OUT: 24, WATCH_ERR: 25, WATCH_END: 26,
  // A monitor process on the host to the daemon.
  WATCH_OPEN: 32,
} as const;

const HEADER = 13;
const EMPTY = new Uint8Array(0);
/** Input goes out in frames of at most this; the daemon takes up to 64 MiB in one. */
const IN_CHUNK = 256 << 10;
/** Acknowledge claude's output after this much, besides with every ping. */
const ACK_EVERY = 512 << 10;
const MAX_FRAME = 64 << 20;

export type Frame = { type: number; value: number; payload: Uint8Array };

/** One frame: type, value and payload length, big-endian, then the payload, in one buffer to write at once. */
export function frame(type: number, value = 0, payload: Uint8Array = EMPTY): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, Math.floor(value / 2 ** 32));
  view.setUint32(5, value >>> 0);
  view.setUint32(9, payload.length);
  out.set(payload, HEADER);
  return out;
}

/** Frames from a byte stream, however it's cut. */
export class FrameReader {
  private buf: Uint8Array = EMPTY;

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    let at = 0;
    while (this.buf.length - at >= HEADER) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + at, HEADER);
      const length = view.getUint32(9);
      if (length > MAX_FRAME) throw new ProtocolError(`a frame of ${length} bytes`);
      if (this.buf.length - at < HEADER + length) break;
      const value = view.getUint32(1) * 2 ** 32 + view.getUint32(5);
      frames.push({ type: view.getUint8(0), value, payload: this.buf.slice(at + HEADER, at + HEADER + length) });
      at += HEADER + length;
    }
    this.buf = at ? this.buf.slice(at) : this.buf;
    return frames;
  }
}

export class ProtocolError extends Error {}

/** A watch's end: where its output ends, and its exit status. */
function watchEnd(id: number, total: number, code: number): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, Math.floor(total / 2 ** 32));
  view.setUint32(4, total >>> 0);
  view.setInt32(8, code);
  return frame(F.WATCH_END, id, payload);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** What a command run on the host over the relay (see host-fs.ts) returned. */
export type ExecResult = { code: number; out: Uint8Array<ArrayBuffer>; err: string };

export type RelayEvents = {
  /** claude's stdout, in order, each byte once. */
  output(chunk: Uint8Array): void;
  /** claude's stderr. A reconnect may lose some of it, never claude's output. */
  stderr(chunk: Uint8Array): void;
  /** claude has exited and all of its output has come through `output`. */
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  /** The daemon has taken up the current connection. */
  hello?(): void;
  /** The daemon refuses to go on with this session. */
  fatal?(message: string): void;
  /**
   * A Monitor command of claude's for this machine to run (monitor.ts): its id with this daemon,
   * and the token cc-remote approved it under. Once per id, however often the daemon asks.
   */
  watch?(id: number, token: string): void;
  /** The daemon has taken some of the output of watch `id`: there may be room for more. */
  watchAcked?(id: number): void;
  /** The daemon is done with watch `id`, its monitor process gone or its end delivered: stop it and forget it. */
  watchClosed?(id: number): void;
};

/** A watch's output not yet acknowledged, from `base` on, and its exit status once it has one. */
type WatchState = { base: number; total: number; queue: Uint8Array[]; end?: number };

/**
 * cc-remote's side of the relay protocol, apart from any connection: what has arrived of claude's
 * output, what the daemon still lacks of its input, and what to say on a new connection. The
 * caller feeds it the bytes a connection brings (`receive`) and gives it a way to send (`connect`).
 */
export class RelayClient {
  /** Bytes of claude's output delivered so far. */
  outReceived = 0;
  private outAcked = 0;
  /** Bytes of claude's input taken from the SDK so far. */
  inTotal = 0;
  /** Where the input not yet acknowledged starts, and those bytes. */
  private inBase = 0;
  private inQueue: Uint8Array[] = [];
  private inEnded = false;
  private terminating = false;
  private exited = false;
  /** When the last frame arrived, as Date.now(). */
  lastFrame = Date.now();
  /** Whether the daemon has said hello on the current connection. */
  connected = false;
  private send?: (bytes: Uint8Array) => void;
  private reader = new FrameReader();
  private execs = new Map<number, { request: Uint8Array; resolve(r: ExecResult): void; reject(e: Error): void }>();
  private nextExec = 1;
  private watches = new Map<number, WatchState>();

  constructor(private readonly events: RelayEvents) {}

  /**
   * A new connection to the daemon: says how much output arrived, then sends again what the
   * daemon may lack, from the last acknowledged byte; the daemon skips what it already has.
   */
  connect(send: (bytes: Uint8Array) => void) {
    this.send = send;
    this.reader = new FrameReader();
    this.connected = false;
    this.lastFrame = Date.now();
    send(frame(F.HELLO_CLIENT, this.outReceived));
    let offset = this.inBase;
    for (const chunk of this.inQueue) {
      this.sendInput(offset, chunk);
      offset += chunk.length;
    }
    if (this.inEnded) send(frame(F.CLOSE_IN, this.inTotal));
    if (this.terminating) send(frame(F.TERM));
    for (const { request } of this.execs.values()) send(request);
    for (const [id, w] of this.watches) {
      let at = w.base;
      for (const chunk of w.queue) {
        this.sendWatch(id, at, chunk);
        at += chunk.length;
      }
      if (w.end !== undefined) send(watchEnd(id, w.total, w.end));
    }
  }

  /** The connection is gone; nothing more is sent until the next one. */
  disconnect() {
    this.send = undefined;
    this.connected = false;
  }

  /** Bytes from the current connection. Throws a ProtocolError on a stream that can't be the daemon's. */
  receive(chunk: Uint8Array) {
    for (const f of this.reader.push(chunk)) this.handle(f);
  }

  private handle(f: Frame) {
    this.lastFrame = Date.now();
    switch (f.type) {
      case F.OUT: {
        const end = f.value + f.payload.length;
        if (f.value > this.outReceived) throw new ProtocolError(`claude's output skips from byte ${this.outReceived} to ${f.value}`);
        if (end <= this.outReceived) return;
        this.events.output(f.payload.subarray(this.outReceived - f.value));
        this.outReceived = end;
        if (this.outReceived - this.outAcked >= ACK_EVERY) this.ack();
        return;
      }
      case F.ERR:
        return this.events.stderr(f.payload);
      case F.HELLO: {
        this.acknowledged(f.value);
        this.connected = true;
        // The daemon's monitors still running: any other was closed while the link was down.
        let live: unknown;
        try {
          live = JSON.parse(new TextDecoder().decode(f.payload)).watches;
        } catch {}
        if (Array.isArray(live)) for (const id of [...this.watches.keys()]) if (!live.includes(id)) this.closeWatch(id);
        return this.events.hello?.();
      }
      case F.IN_ACK:
        return this.acknowledged(f.value);
      case F.PONG:
        return;
      case F.EXIT: {
        if (this.exited) return;
        this.exited = true;
        this.ack();
        this.send?.(frame(F.BYE));
        const signal = new TextDecoder().decode(f.payload);
        this.failExecs(new Error("claude on the host has exited"));
        for (const id of [...this.watches.keys()]) this.closeWatch(id);
        return this.events.exit(signal ? null : f.value, (signal || null) as NodeJS.Signals | null);
      }
      case F.RESULT: {
        const pending = this.execs.get(f.value);
        if (!pending || f.payload.length < 8) return;
        this.execs.delete(f.value);
        const view = new DataView(f.payload.buffer, f.payload.byteOffset, 8);
        const length = view.getUint32(4);
        const out = f.payload.slice(8, 8 + length);
        return pending.resolve({ code: view.getInt32(0), out, err: new TextDecoder().decode(f.payload.subarray(8 + length)) });
      }
      case F.FATAL:
        return this.events.fatal?.(new TextDecoder().decode(f.payload));
      case F.WATCH: {
        if (this.watches.has(f.value) || this.exited) return;
        this.watches.set(f.value, { base: 0, total: 0, queue: [] });
        return this.events.watch?.(f.value, new TextDecoder().decode(f.payload));
      }
      case F.WATCH_ACK: {
        const w = this.watches.get(f.value);
        if (!w || f.payload.length < 8) return;
        const view = new DataView(f.payload.buffer, f.payload.byteOffset, 8);
        const offset = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
        if (offset > w.total) throw new ProtocolError(`the daemon acknowledges byte ${offset} of ${w.total} of monitor ${f.value}`);
        while (w.base < offset && w.queue.length) {
          const first = w.queue[0]!;
          const drop = Math.min(first.length, offset - w.base);
          if (drop === first.length) w.queue.shift();
          else w.queue[0] = first.subarray(drop);
          w.base += drop;
        }
        return this.events.watchAcked?.(f.value);
      }
      case F.WATCH_CLOSED:
        return this.closeWatch(f.value);
      default:
        throw new ProtocolError(`an unknown frame type ${f.type}`);
    }
  }

  /** The daemon has the input up to `offset`: it no longer needs keeping here. */
  private acknowledged(offset: number) {
    if (offset > this.inTotal) throw new ProtocolError(`the daemon acknowledges input byte ${offset} of ${this.inTotal}`);
    while (this.inBase < offset && this.inQueue.length) {
      const first = this.inQueue[0]!;
      const drop = Math.min(first.length, offset - this.inBase);
      if (drop === first.length) this.inQueue.shift();
      else this.inQueue[0] = first.subarray(drop);
      this.inBase += drop;
    }
  }

  private sendInput(offset: number, chunk: Uint8Array) {
    for (let at = 0; at < chunk.length; at += IN_CHUNK) {
      this.send?.(frame(F.IN, offset + at, chunk.subarray(at, at + IN_CHUNK)));
    }
  }

  /** Input for claude, kept until the daemon acknowledges it. */
  write(chunk: Uint8Array) {
    if (!chunk.length || this.inEnded) return;
    const copy = new Uint8Array(chunk);
    this.inQueue.push(copy);
    this.sendInput(this.inTotal, copy);
    this.inTotal += copy.length;
  }

  /** The end of claude's input: claude sees it once the daemon has written everything before it. */
  end() {
    if (this.inEnded) return;
    this.inEnded = true;
    this.send?.(frame(F.CLOSE_IN, this.inTotal));
  }

  /** Asks the daemon to stop claude: SIGTERM, then SIGKILL after five seconds. The exit follows. */
  terminate() {
    if (this.terminating || this.exited) return;
    this.terminating = true;
    this.send?.(frame(F.TERM));
  }

  /** A heartbeat; the daemon answers it, which tells that the link is alive. */
  ping() {
    if (!this.send) return;
    this.send(frame(F.PING, Date.now()));
    if (this.outReceived > this.outAcked) this.ack();
  }

  private ack() {
    if (!this.send) return;
    this.send(frame(F.OUT_ACK, this.outReceived));
    this.outAcked = this.outReceived;
  }

  /** Runs a shell script on the host, in claude's folder there, sent again after a reconnect until it's answered. */
  exec(script: string, input: Uint8Array = EMPTY): Promise<ExecResult> {
    if (this.exited) return Promise.reject(new Error("claude on the host has exited"));
    const id = this.nextExec++;
    const text = new TextEncoder().encode(script);
    const payload = new Uint8Array(4 + text.length + input.length);
    new DataView(payload.buffer).setUint32(0, text.length);
    payload.set(text, 4);
    payload.set(input, 4 + text.length);
    const request = frame(F.EXEC, id, payload);
    return new Promise<ExecResult>((resolve, reject) => {
      this.execs.set(id, { request, resolve, reject });
      this.send?.(request);
    });
  }

  private closeWatch(id: number) {
    if (this.watches.delete(id)) this.events.watchClosed?.(id);
  }

  private sendWatch(id: number, offset: number, chunk: Uint8Array) {
    for (let at = 0; at < chunk.length; at += IN_CHUNK) {
      const part = chunk.subarray(at, at + IN_CHUNK);
      const payload = new Uint8Array(8 + part.length);
      const view = new DataView(payload.buffer);
      view.setUint32(0, Math.floor((offset + at) / 2 ** 32));
      view.setUint32(4, (offset + at) >>> 0);
      payload.set(part, 8);
      this.send?.(frame(F.WATCH_OUT, id, payload));
    }
  }

  /** stdout of watch `id`, kept until the daemon acknowledges it. */
  watchOutput(id: number, chunk: Uint8Array) {
    const w = this.watches.get(id);
    if (!w || w.end !== undefined || !chunk.length) return;
    const copy = new Uint8Array(chunk);
    w.queue.push(copy);
    this.sendWatch(id, w.total, copy);
    w.total += copy.length;
  }

  /** stderr of watch `id`: passed on while connected, and not kept. */
  watchStderr(id: number, chunk: Uint8Array) {
    if (this.watches.has(id) && chunk.length) this.send?.(frame(F.WATCH_ERR, id, chunk));
  }

  /** Watch `id` has exited with `code`, after all of its output. */
  watchEnd(id: number, code: number) {
    const w = this.watches.get(id);
    if (!w || w.end !== undefined) return;
    w.end = code;
    this.send?.(watchEnd(id, w.total, code));
  }

  /** Output of watch `id` the daemon has yet to acknowledge. */
  watchPending(id: number): number {
    const w = this.watches.get(id);
    return w ? w.total - w.base : 0;
  }

  /** Fails the commands still waiting for an answer, as the session ends. */
  failExecs(error: Error) {
    for (const pending of this.execs.values()) pending.reject(error);
    this.execs.clear();
  }

  /** Bytes of input the daemon has yet to acknowledge, for tests and diagnostics. */
  get unacknowledged(): number {
    return this.inTotal - this.inBase;
  }
}
