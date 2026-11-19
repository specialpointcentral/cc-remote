import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { privateDir, readPrivate, readPrivateJson, writePrivateJson } from "./setup/files";

/**
 * Redaction keeps this machine's identifiers off the central server. When it is on, everything
 * cc-remote sends there (claude's stream, the remote command, uploads, the host-file and Monitor
 * channels) has them replaced with placeholders, and whatever comes back has the placeholders
 * turned back into them. So the tools, the hooks and the app on this machine work with the real
 * values, while claude on the server, its transcripts and the model only ever see placeholders.
 *
 * What gets replaced:
 *
 * - this machine's host name, as os.hostname() gives it, and its first label, and its fully
 *   qualified name, as `hostname -f` gives it (on macOS and Linux);
 * - its machine id: /etc/machine-id, macOS's IOPlatformUUID or Windows' MachineGuid;
 * - its own addresses, IPv4 and IPv6, loopback aside;
 * - the user's login name, which is also what names their home folder;
 * - the names in ~/.config/cc-remote/redact.json: internal domains (a domain also covers its
 *   subdomains), other hosts, addresses, code names.
 *
 * Time zones, timestamps and locale are left as they are.
 *
 * A placeholder is `ccr-<kind>-<hmac>`; a domain's ends in the reserved `.invalid`. The HMAC key
 * (redact.key) never leaves this machine, so the same value always gets the same placeholder:
 * a session resumed tomorrow reads its transcript back. Each spelling of a value has a
 * placeholder of its own, so restoring gives back exactly what was there, which file paths need.
 *
 * Matching is case-insensitive and stops at word edges, so `dev1` is not found in `dev10`; an
 * escape such as `\n` right before a value is an edge too, as JSON writes a line break so.
 * Restoring uses the same edges as replacing, so whatever restoring puts back is found again by
 * the next replacement, wherever the model wrote the placeholder.
 *
 * This is a best-effort filter, not a security boundary. It leaves alone images and other binary
 * data, encoded forms (base64, URL encoding), a value split across lines, a name it was never
 * given, and whatever the model works out from the rest.
 */

export type Kind = "host" | "ip" | "ip6" | "mid" | "user" | "dom" | "name";
export type Value = { kind: Kind; text: string };

/** Values shorter than this would turn up inside ordinary words and code too often. */
export const MIN_LENGTH = 3;

const W = "A-Za-z0-9_";
/**
 * Right after a one-letter escape such as `\n` or `\t`: JSON (claude's stream, transcripts) and
 * source code write a line break or a tab so, and a value starting a line follows its letter.
 * An even run of backslashes before the letter is escaped backslashes, and the letter is a letter.
 */
const ESCAPE = String.raw`(?<=(?:^|[^\\])(?:\\\\)*\\[bfnrtv])`;
/** A value's start: not after what `not` matches, unless that is an escape's letter. */
const start = (not: string) => `(?:(?<!${not})|${ESCAPE})`;
const WORD: [string, string] = [start(`[${W}]`), `(?![${W}])`];
/** Where a value of each kind may start and end: not inside a longer word, number, address or name. */
const EDGES: Record<Kind, [string, string]> = {
  host: WORD,
  mid: WORD,
  user: WORD,
  name: WORD,
  ip: [start(`[${W}]|[0-9]\\.`), `(?![${W}]|\\.[0-9])`],
  ip6: [start(`[${W}:]`), `(?![${W}:])`],
  dom: [start(`[${W}-]`), `(?![${W}-]|\\.[${W}])`],
};
const KINDS = Object.keys(EDGES) as Kind[];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tail = (kind: Kind) => (kind === "dom" ? ".invalid" : "");

/** Every placeholder, at the same edges as the values it stands for. */
const RESTORE = new RegExp(KINDS.map((k) => `${EDGES[k][0]}ccr-${k}-[0-9a-f]{8,16}${escape(tail(k))}${EDGES[k][1]}`).join("|"), "g");
const PLACEHOLDER = /^ccr-[a-z0-9]+-[0-9a-f]{8,16}(?:\.invalid)?$/;

/**
 * Fields whose string values, in a message's envelope, are words of claude's protocol and never
 * this machine's: a message's type and role, a model, a permission mode, a JSON-RPC method. A listed
 * name that happens to be such a word stays there. Inside DATA they are data like any other field.
 */
const PROTOCOL = new Set(["type", "subtype", "role", "model", "stop_reason", "behavior", "mode", "permissionMode", "hook_event_name", "method", "apiKeySource"]);
/**
 * Fields holding data of any shape rather than more of the envelope: a tool's input (as asked, or
 * as a permission answer changes it), a JSON-RPC call's parameters, a tool's result as a
 * transcript keeps it, metadata.
 */
const DATA = new Set(["input", "updatedInput", "updated_input", "tool_input", "arguments", "params", "toolUseResult", "tool_use_result", "metadata", "_meta", "structuredContent"]);
/** A key that is a plain identifier names a field, part of the format; any other (a path, a host) is data. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Flags whose value stays as it is: a word of claude's, such as a model or a format, or a path on
 * the host that cc-remote made, placeholders and all, such as a plugin's.
 */
const KEPT_FLAGS = new Set(["--model", "--fallback-model", "--permission-mode", "--input-format", "--output-format", "--setting-sources", "--effort", "--plugin-dir", "--plugin-dir-no-mcp"]);
const FLAG = /^--?[A-Za-z][A-Za-z0-9-]*(?:=|$)/;
/** Longer than any placeholder, `ccr-name-` and 16 hex digits and `.invalid`. */
const PLACEHOLDER_MAX = 40;
/** How much of what went before a part of a long line is read with it, for the edges of its first values. */
const CONTEXT = 32;

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** `f` applied to bytes that are UTF-8 text; anything else passes unchanged. */
function viaText(b: Uint8Array, f: (s: string) => string): Uint8Array {
  let s: string;
  try {
    s = strict.decode(b);
  } catch {
    return b;
  }
  const t = f(s);
  return t === s ? b : encoder.encode(t);
}

/** The streamed delta fields that carry text the model writes. */
const FIELDS: Record<string, string> = { text_delta: "text", input_json_delta: "partial_json", thinking_delta: "thinking" };

/** Whether `t` could still grow into a placeholder, or is one whose end is not known yet. */
function partial(t: string): boolean {
  for (const k of KINDS) {
    const head = `ccr-${k}-`;
    if (t.length <= head.length) {
      if (head.startsWith(t)) return true;
      continue;
    }
    if (!t.startsWith(head)) continue;
    const rest = t.slice(head.length);
    const hex = /^[0-9a-f]*/.exec(rest)![0];
    if (hex.length === rest.length && hex.length <= 16) return true;
    if (k === "dom" && hex.length >= 8 && ".invalid".startsWith(rest.slice(hex.length))) return true;
  }
  return false;
}

/** Where a streamed text stops being safe to restore yet: from there on it could still be a placeholder. */
function holdFrom(text: string): number {
  let cut = text.length;
  for (let i = Math.max(0, text.length - 40); i < text.length; i++) {
    if (text[i] === "c" && partial(text.slice(i))) {
      cut = i;
      break;
    }
  }
  // A placeholder right before the held part: what follows it, which decides whether it is one, isn't known yet.
  for (;;) {
    const end = /(?:^|[^A-Za-z0-9_])(ccr-[a-z0-9]+-[0-9a-f]{8,16}(?:\.invalid)?)$/.exec(text.slice(0, cut));
    if (!end) break;
    cut -= end[1]!.length;
  }
  return cut;
}

type JsonString = { t: "string"; start: number; end: number; value: string };
type Json = JsonString | { t: "object"; entries: [JsonString, Json][] } | { t: "array"; items: Json[] } | { t: "literal" };
const LITERAL = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;

/**
 * A JSON text's structure, with where each string is. Numbers stay text, so one too big for a
 * JavaScript number is never rounded. Throws when it isn't JSON.
 */
function parseJson(s: string): Json {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`not JSON at ${i}`);
  };
  const space = () => {
    while (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r") i++;
  };
  const string = (): JsonString => {
    const start = i++;
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail();
      i += c === 0x5c ? 2 : 1;
    }
    i++;
    return { t: "string", start, end: i, value: JSON.parse(s.slice(start, i)) as string };
  };
  const value = (): Json => {
    space();
    const open = s[i];
    if (open === '"') return string();
    if (open === "{" || open === "[") {
      const close = open === "{" ? "}" : "]";
      const entries: [JsonString, Json][] = [];
      const items: Json[] = [];
      i++;
      space();
      if (s[i] === close) i++;
      else {
        for (;;) {
          if (open === "{") {
            space();
            if (s[i] !== '"') fail();
            const key = string();
            space();
            if (s[i++] !== ":") fail();
            entries.push([key, value()]);
          } else items.push(value());
          space();
          const next = s[i++];
          if (next === close) break;
          if (next !== ",") fail();
        }
      }
      return open === "{" ? { t: "object", entries } : { t: "array", items };
    }
    LITERAL.lastIndex = i;
    if (!LITERAL.test(s)) fail();
    i = LITERAL.lastIndex;
    return { t: "literal" };
  };
  const root = value();
  space();
  if (i < s.length) fail();
  return root;
}

/**
 * Filters a part of a long line: `text`, read after `context`, the end of what went before it, so
 * that a value's edges are judged as in the whole line. Gives the part's filtered text, and how
 * much of `text` that is: all of it when `last`, else only as far as no value could go on past it.
 */
export type PieceFilter = (context: string, text: string, last: boolean) => { out: string; used: number };

/**
 * Applies a filter to a byte stream a line at a time, so a value is never split between two
 * chunks. A line longer than `max` goes in parts, which `piece` filters each after what went
 * before; a part ends on a whole character, which a filter needs to read it as text.
 */
export class Lines {
  private held: Uint8Array[] = [];
  private size = 0;
  /** The end of the current line's parts already filtered, while it has some. */
  private context = "";
  constructor(private readonly f: (b: Uint8Array) => Uint8Array, private readonly max = 64 * 1024, private readonly piece?: PieceFilter) {}

  push(chunk: Uint8Array): Uint8Array {
    const nl = chunk.lastIndexOf(10);
    if (nl < 0) {
      this.hold(chunk);
      return this.size > this.max ? this.part() : EMPTY;
    }
    const out = this.rest(Buffer.concat([...this.held, chunk.subarray(0, nl + 1)]));
    this.keep(chunk.subarray(nl + 1));
    return out;
  }

  flush(): Uint8Array {
    const all = Buffer.concat(this.held);
    this.keep(EMPTY);
    return this.rest(all);
  }

  /** The rest of a line (and whole lines after it), read after its parts already filtered. */
  private rest(b: Uint8Array): Uint8Array {
    const context = this.context;
    this.context = "";
    if (!b.length) return EMPTY;
    if (!context || !this.piece) return this.f(b);
    let s: string;
    try {
      s = strict.decode(b);
    } catch {
      return this.f(b);
    }
    return encoder.encode(this.piece(context, s, true).out);
  }

  /** A long line's next part: whole characters, as far as the filter can go; the rest waits for more. */
  private part(): Uint8Array {
    const all = Buffer.concat(this.held);
    const end = wholeChars(all);
    let s: string;
    try {
      s = strict.decode(all.subarray(0, end));
    } catch {
      // Not text: it passes as it is.
      this.keep(EMPTY);
      this.context = "";
      return this.f(all);
    }
    if (!this.piece) {
      this.keep(all.subarray(end));
      return this.f(all.subarray(0, end));
    }
    const { out, used } = this.piece(this.context, s, false);
    this.context = (this.context + s.slice(0, used)).slice(-CONTEXT);
    this.keep(Buffer.concat([encoder.encode(s.slice(used)), all.subarray(end)]));
    return encoder.encode(out);
  }

  private hold(b: Uint8Array) {
    this.held.push(b.slice());
    this.size += b.length;
  }

  private keep(b: Uint8Array) {
    this.held = b.length ? [b.slice()] : [];
    this.size = b.length;
  }
}

/** How many of the bytes are whole UTF-8 characters: a character they end inside of waits for its other bytes. */
function wholeChars(b: Uint8Array): number {
  for (let i = b.length - 1; i >= 0 && i >= b.length - 4; i--) {
    const x = b[i]!;
    if (x < 0x80) break;
    if (x >= 0xc0) return b.length - i < (x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : 2) ? i : b.length;
  }
  return b.length;
}

const highSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

export type RedactorOptions = {
  /** Whether to replace values in what goes out; restoring works whenever there is a key. */
  on: boolean;
  /** Placeholders seen before, for spellings this process wouldn't think of. */
  table?: Record<string, string>;
  /** Keeps a new spelling's placeholder, so a later process can restore it. */
  persist?: (entries: Record<string, string>) => void;
  /** Values too short to replace, for the notice. */
  skipped?: Value[];
};

export class Redactor {
  readonly on: boolean;
  readonly values: Value[];
  readonly skipped: Value[];
  private readonly forward?: RegExp;
  private readonly probe?: RegExp;
  private readonly kinds = new Map<string, Kind>();
  private readonly toPlaceholder = new Map<string, string>();
  private readonly fromPlaceholder = new Map<string, string>();
  private readonly persist?: (entries: Record<string, string>) => void;
  /** The longest value's length: a piece of a long line keeps that much back. */
  private readonly longest: number;

  constructor(private readonly key: Uint8Array, values: Value[], o: RedactorOptions) {
    this.on = o.on;
    this.persist = o.persist;
    this.skipped = o.skipped ?? [];
    const seen = new Set<string>();
    this.values = values
      .filter((v) => v.text.length >= MIN_LENGTH && !seen.has(v.text.toLowerCase()) && seen.add(v.text.toLowerCase()))
      .sort((a, b) => b.text.length - a.text.length);
    this.longest = this.values[0]?.text.length ?? 0;
    for (const v of this.values) {
      this.kinds.set(v.text.toLowerCase(), v.kind);
      for (const spelling of new Set([v.text, v.text.toLowerCase(), v.text.toUpperCase()])) this.register(v.kind, spelling);
    }
    // They go in the table too, so that a session's placeholders still read back once an address
    // has changed or a name is no longer listed.
    if (this.on && this.persist) {
      const fresh = Object.fromEntries([...this.fromPlaceholder].filter(([placeholder, text]) => o.table?.[placeholder] !== text));
      if (Object.keys(fresh).length) this.persist(fresh);
    }
    for (const [placeholder, text] of Object.entries(o.table ?? {})) {
      if (PLACEHOLDER.test(placeholder) && !this.fromPlaceholder.has(placeholder)) this.fromPlaceholder.set(placeholder, text);
    }
    if (this.on && this.values.length) {
      const source = this.values.map((v) => `${EDGES[v.kind][0]}${escape(v.text)}${EDGES[v.kind][1]}`).join("|");
      this.forward = new RegExp(source, "giu");
      this.probe = new RegExp(source, "iu");
    }
  }

  /**
   * A name for what it replaces, which changes whenever any of it does: copies on the host filtered
   * with it, such as a plugin's, are named with it, so another filter makes another copy.
   */
  get stamp(): string {
    const all = this.values.map((v) => `${v.kind}\0${v.text}`).sort().join("\n");
    return createHmac("sha256", this.key).update(`stamp\0${all}`).digest("hex").slice(0, 16);
  }

  /** Whether anything passes through it changed: it replaces, or it has placeholders to restore. */
  get active(): boolean {
    return this.forward !== undefined || this.fromPlaceholder.size > 0;
  }

  /** The text with this machine's values replaced. */
  text(s: string): string {
    if (!this.forward || !this.probe!.test(s)) return s;
    return s.replace(this.forward, (m) => this.placeholder(this.kinds.get(m.toLowerCase()) ?? "name", m));
  }

  /** The text with the placeholders turned back into the values. */
  restore(s: string): string {
    if (!this.fromPlaceholder.size || !s.includes("ccr-")) return s;
    return s.replace(RESTORE, (m) => this.fromPlaceholder.get(m) ?? m);
  }

  /** A JSON line for the server: as JSON (json()), or as text when it isn't JSON. */
  jsonLine(line: string): string {
    if (!this.forward || !this.probe!.test(line)) return line;
    try {
      return this.json(line);
    } catch {
      return this.text(line);
    }
  }

  /** A string that may hold JSON, such as a `--settings` value: an object or a list as JSON, anything else as text. */
  value(s: string): string {
    if (!this.forward || !this.probe!.test(s)) return s;
    if (/^\s*[[{]/.test(s)) {
      try {
        return this.json(s);
      } catch {}
    }
    return this.text(s);
  }

  /**
   * claude's arguments for the server: the flags as they are, and so the values of KEPT_FLAGS (a
   * model, a format, a plugin's path on the host); every other value filtered, JSON as JSON.
   */
  args(args: string[]): string[] {
    if (!this.forward) return args;
    return args.map((a, i) => {
      if (FLAG.test(a)) {
        const eq = a.indexOf("=");
        return eq < 0 || KEPT_FLAGS.has(a.slice(0, eq)) ? a : a.slice(0, eq + 1) + this.value(a.slice(eq + 1));
      }
      return KEPT_FLAGS.has(args[i - 1] ?? "") ? a : this.value(a);
    });
  }

  /** A file's bytes for the server: JSON (by its name) as JSON, other text as text, binary data as it is. */
  file(path: string, data: Uint8Array): Uint8Array {
    if (!this.forward) return data;
    if (!/\.json$/i.test(path)) return this.bytes(data);
    return viaText(data, (s) => {
      if (!this.probe!.test(s)) return s;
      try {
        return this.json(s);
      } catch {
        return this.text(s);
      }
    });
  }

  /** Text bytes for the server; binary data passes unchanged. */
  bytes(b: Uint8Array): Uint8Array {
    return this.forward ? viaText(b, (s) => this.text(s)) : b;
  }

  /** Text bytes from the server, restored; binary data passes unchanged. */
  restoreBytes(b: Uint8Array): Uint8Array {
    return this.fromPlaceholder.size ? viaText(b, (s) => this.restore(s)) : b;
  }

  /** A JSON-lines file, such as a transcript, for the server. */
  jsonLines(b: Uint8Array): Uint8Array {
    return this.forward ? viaText(b, (s) => s.split("\n").map((l) => this.jsonLine(l)).join("\n")) : b;
  }

  /** A filter for a byte stream, a line at a time. */
  lines(direction: "redact" | "restore"): Lines {
    return new Lines(direction === "redact" ? (b) => this.bytes(b) : (b) => this.restoreBytes(b), undefined, this.piece(direction));
  }

  /**
   * Lines' filter for a part of a long line, going out or coming back. A value (a placeholder) is
   * replaced only once it is whole and its edges are known: one that starts within the longest
   * value's length of the end waits for more, as does one the cut would split.
   */
  private piece(direction: "redact" | "restore"): PieceFilter {
    const re = direction === "redact" ? this.forward : this.fromPlaceholder.size ? RESTORE : undefined;
    const swap = direction === "redact"
      ? (m: string) => this.placeholder(this.kinds.get(m.toLowerCase()) ?? "name", m)
      : (m: string) => this.fromPlaceholder.get(m) ?? m;
    const hold = (direction === "redact" ? this.longest : PLACEHOLDER_MAX) + 2;
    return (context, text, last) => {
      const s = context + text;
      const from = context.length;
      let cut = last ? s.length : Math.max(from, s.length - hold);
      if (cut > from && cut < s.length && highSurrogate(s.charCodeAt(cut - 1))) cut--;
      let out = "";
      let at = from;
      for (const m of re ? s.matchAll(re) : []) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (end <= from) continue; // In what went before.
        if (start >= cut) break;
        if (end > cut) {
          cut = Math.max(start, from);
          break;
        }
        if (start < from) continue;
        out += s.slice(at, start) + swap(m[0]);
        at = end;
      }
      return { out: out + s.slice(at, cut), used: cut - from };
    };
  }

  /** The same, as a Node stream. */
  transform(direction: "redact" | "restore"): Transform {
    const lines = this.lines(direction);
    return new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const out = lines.push(chunk);
        done(null, out.length ? out : undefined);
      },
      flush(done) {
        const out = lines.flush();
        done(null, out.length ? out : undefined);
      },
    });
  }

  /**
   * Restores claude's stream-json lines. A text delta of a streamed message (partial messages)
   * may end inside a placeholder: its tail waits for the next delta of the same block, and what
   * is still held when the block stops goes out as one more delta just before the stop.
   */
  stream(): (line: string) => string[] {
    if (!this.fromPlaceholder.size) return (line) => [line];
    const carry = new Map<string, { type: string; field: string; before: string; text: string }>();
    /** The held text restored, with the two characters before it there for the edges. */
    const restoreHeld = (before: string, text: string) => this.restore(before + text).slice(before.length);
    return (line) => {
      if (!line.includes('"stream_event"')) return [this.restore(line)];
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return [this.restore(line)];
      }
      const ev = m?.event;
      if (m?.type !== "stream_event" || !ev || typeof ev !== "object") return [this.restore(line)];
      const key = `${m.session_id ?? ""}\0${m.parent_tool_use_id ?? ""}\0${ev.index}`;
      const field = ev.type === "content_block_delta" ? FIELDS[ev.delta?.type] : undefined;
      if (field && typeof ev.delta[field] === "string") {
        const held = carry.get(key);
        const before = held?.before ?? "";
        const text = (held?.text ?? "") + ev.delta[field];
        const cut = holdFrom(text);
        ev.delta[field] = restoreHeld(before, text.slice(0, cut));
        const emitted = before + text.slice(0, cut);
        if (cut < text.length) carry.set(key, { type: ev.delta.type, field, before: emitted.slice(-2), text: text.slice(cut) });
        else carry.delete(key);
        return [this.restore(JSON.stringify(m))];
      }
      if (ev.type === "content_block_stop") {
        const held = carry.get(key);
        if (held) {
          carry.delete(key);
          const delta = { type: held.type, [held.field]: restoreHeld(held.before, held.text) };
          const flush = { ...m, uuid: crypto.randomUUID(), event: { type: "content_block_delta", index: ev.index, delta } };
          return [JSON.stringify(flush), this.restore(line)];
        }
      }
      return [this.restore(line)];
    };
  }

  /**
   * A JSON text with its strings filtered and all else as it was, byte for byte: what is part of the
   * format stays, field names that are identifiers, protocol words in a message's envelope, base64
   * data, and numbers of any size. Throws when it isn't JSON.
   */
  private json(text: string): string {
    const edits: [number, number, string][] = [];
    const filter = (n: JsonString) => {
      const out = this.text(n.value);
      if (out !== n.value) edits.push([n.start, n.end, JSON.stringify(out)]);
    };
    const visit = (n: Json, field: string | undefined, envelope: boolean) => {
      if (n.t === "string") {
        if (!envelope || field === undefined || !PROTOCOL.has(field)) filter(n);
      } else if (n.t === "array") {
        for (const x of n.items) visit(x, undefined, envelope);
      } else if (n.t === "object") {
        const get = (k: string) => n.entries.find(([key]) => key.value === k)?.[1];
        const type = get("type");
        const kind = type?.t === "string" ? type.value : undefined;
        const binary = kind === "base64" || kind === "image" || get("mimeType") !== undefined || get("media_type") !== undefined;
        for (const [key, v] of n.entries) {
          if (!FIELD.test(key.value)) filter(key);
          if (binary && key.value === "data" && v.t === "string") continue;
          visit(v, key.value, envelope && !DATA.has(key.value));
        }
      }
    };
    visit(parseJson(text), undefined, true);
    if (!edits.length) return text;
    let out = "";
    let at = 0;
    for (const [start, end, replacement] of edits.sort((a, b) => a[0] - b[0])) {
      out += text.slice(at, start) + replacement;
      at = end;
    }
    return out + text.slice(at);
  }

  private placeholder(kind: Kind, text: string): string {
    const known = this.toPlaceholder.get(text);
    if (known) return known;
    const placeholder = this.register(kind, text);
    this.persist?.({ [placeholder]: text });
    return placeholder;
  }

  private register(kind: Kind, text: string): string {
    const mac = createHmac("sha256", this.key).update(`${kind}\0${text}`).digest("hex");
    let placeholder = "";
    for (let n = 8; n <= 16; n += 2) {
      placeholder = `ccr-${kind}-${mac.slice(0, n)}${tail(kind)}`;
      const other = this.fromPlaceholder.get(placeholder);
      if (other === undefined || other === text) break;
    }
    this.toPlaceholder.set(text, placeholder);
    this.fromPlaceholder.set(placeholder, text);
    return placeholder;
  }
}

// --- Configuration -------------------------------------------------------------------------------

/** cc-remote's folder of settings on this machine, beside the host file. */
export const configDir = () => join(homedir(), ".config", "cc-remote");
export const CONFIG_FILE = "redact.json";
const KEY_FILE = "redact.key";
const TABLE_FILE = "redact-table.json";
const TABLE_MAX = 10_000;

/** redact.json: whether redaction is on, and the names to replace besides this machine's own. */
export type Config = { enabled: boolean; names: string[] };

/** A problem with the redaction settings: sessions don't start until it's fixed, so nothing goes out unfiltered. */
export class RedactionError extends Error {}

const NAME = /^[\p{L}\p{N}](?:[^\p{Cc}"'`\\$/]*[\p{L}\p{N}])?$/u;

/** Why a name can't be used, if it can't. */
export function nameProblem(name: unknown): string | undefined {
  if (typeof name !== "string") return "not a string";
  if (name.length < MIN_LENGTH || name.length > 128) return `must be ${MIN_LENGTH} to 128 characters`;
  if (!NAME.test(name)) return "must start and end with a letter or digit, and have no quotes, backslash, slash, $ or control characters";
  return undefined;
}

/** What a name in redact.json stands for: an address, a domain (with its subdomains), or a word. */
export function kindOf(name: string): Kind {
  const ip = isIP(name);
  if (ip === 4) return "ip";
  if (ip === 6) return "ip6";
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(name) && /[A-Za-z]/.test(name) ? "dom" : "name";
}

/** redact.json, undefined when there is none. Throws when it's there but unusable. */
export function readConfig(dir = configDir()): Config | undefined {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  const raw = readPrivateJson(path);
  if (!raw) throw new RedactionError(`${path} must be a JSON object that only you can read (chmod 600)`);
  if (typeof raw.enabled !== "boolean") throw new RedactionError(`${path}: "enabled" must be true or false`);
  const names = raw.names ?? [];
  if (!Array.isArray(names)) throw new RedactionError(`${path}: "names" must be a list`);
  for (const n of names) {
    const problem = nameProblem(n);
    if (problem) throw new RedactionError(`${path}: the name ${JSON.stringify(n)} ${problem}`);
  }
  return { enabled: raw.enabled, names: names as string[] };
}

export function writeConfig(config: Config, dir = configDir()) {
  writePrivateJson(join(dir, CONFIG_FILE), config);
}

function readKey(path: string): Uint8Array | undefined {
  const text = readPrivate(path)?.trim();
  if (text && /^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (text !== undefined && text !== "") throw new RedactionError(`${path} is not cc-remote's key (64 hex digits)`);
  if (text === undefined && existsSync(path)) throw new RedactionError(`${path} must be a file that only you can read (chmod 600)`);
  return undefined;
}

/** The HMAC key, made once with O_EXCL so that sessions starting together agree on it. */
export function ensureKey(dir = configDir()): Uint8Array {
  const path = join(dir, KEY_FILE);
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = readKey(path);
    if (key) return key;
    if (!existsSync(path)) {
      privateDir(dir);
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          writeSync(fd, `${randomBytes(32).toString("hex")}\n`);
        } finally {
          closeSync(fd);
        }
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    // Another process made it and hasn't written it yet.
    Bun.sleepSync(20);
  }
  throw new RedactionError(`could not read ${path}`);
}

function readTable(path: string): Record<string, string> {
  const entries = readPrivateJson(path)?.entries;
  if (!entries || typeof entries !== "object") return {};
  return Object.fromEntries(Object.entries(entries).filter(([k, v]) => PLACEHOLDER.test(k) && typeof v === "string"));
}

function saveTable(path: string, entries: Record<string, string>) {
  try {
    const all = Object.entries({ ...readTable(path), ...entries });
    writePrivateJson(path, { version: 1, entries: Object.fromEntries(all.slice(-TABLE_MAX)) });
  } catch (e) {
    console.error(`cc-remote: could not save ${path}: ${(e as Error).message}`);
  }
}

// --- This machine's values ------------------------------------------------------------------------

const GENERIC = new Set(["localhost", "localhost.localdomain", "localdomain"]);

function machineId(): string | undefined {
  try {
    if (process.platform === "linux") {
      for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const t = readFileSync(f, "utf8").trim();
          if (/^[0-9a-f]{32}$/i.test(t)) return t;
        } catch {}
      }
    } else if (process.platform === "darwin") {
      const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 2_000 });
      return /"IOPlatformUUID" = "([0-9A-F-]{36})"/i.exec(r.stdout ?? "")?.[1];
    } else if (process.platform === "win32") {
      const r = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
      return /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(r.stdout ?? "")?.[1];
    }
  } catch {}
  return undefined;
}

/**
 * The host's fully qualified name, when the system knows one beyond os.hostname(): a cloud VM's
 * domain names its project. `hostname -f` asks the resolver, so it gets a time limit.
 */
function fullName(name: string): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  try {
    const r = spawnSync("hostname", ["-f"], { encoding: "utf8", timeout: 2_000 });
    const full = r.status === 0 ? r.stdout.trim() : "";
    return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(full) && full.toLowerCase() !== name.toLowerCase() ? full : undefined;
  } catch {
    return undefined;
  }
}

/** This machine's own identifiers, and those too short to replace. */
export function machineValues(): { values: Value[]; skipped: Value[] } {
  const values: Value[] = [];
  const skipped: Value[] = [];
  const add = (kind: Kind, text: string | undefined) => {
    const t = text?.trim();
    if (!t || GENERIC.has(t.toLowerCase())) return;
    (t.length < MIN_LENGTH ? skipped : values).push({ kind, text: t });
  };
  const name = hostname();
  add("host", name);
  if (name.includes(".")) add("host", name.split(".")[0]);
  add("host", fullName(name));
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      const v6 = a.family === "IPv6" || (a.family as unknown) === 6;
      if (!v6 && (a.address.startsWith("127.") || a.address === "0.0.0.0")) continue;
      if (v6 && (a.address === "::" || a.address === "::1")) continue;
      add(v6 ? "ip6" : "ip", a.address);
    }
  }
  try {
    add("user", userInfo().username);
  } catch {}
  add("mid", machineId());
  return { values, skipped };
}

// --- The process's redactor -----------------------------------------------------------------------

let current: Redactor | undefined;
let told = false;

/**
 * A redactor from the settings in `dir`. Off when redaction was never turned on; restoring only
 * when it was turned off again, so the placeholders of earlier sessions still read back. Makes the
 * key when redaction is on and there is none yet, unless `create` is false: then it stays off.
 * Throws RedactionError for unusable settings.
 */
export function loadRedactor(dir = configDir(), create = true): Redactor {
  const config = readConfig(dir);
  const on = config?.enabled === true;
  const key = on && create ? ensureKey(dir) : readKey(join(dir, KEY_FILE));
  if (!key) return new Redactor(new Uint8Array(32), [], { on: false });
  const table = join(dir, TABLE_FILE);
  const mine = machineValues();
  const names = (config?.names ?? []).map((text) => ({ kind: kindOf(text), text }));
  return new Redactor(key, [...mine.values, ...names], { on, table: readTable(table), persist: (e) => saveTable(table, e), skipped: mine.skipped });
}

/** The redactor for this process, read from ~/.config/cc-remote the first time it's asked for. */
export function redaction(): Redactor {
  if (current) return current;
  current = loadRedactor();
  if (current.on && current.skipped.length && !told) {
    told = true;
    console.error(`cc-remote: redaction leaves ${current.skipped.map((v) => JSON.stringify(v.text)).join(", ")} as they are: shorter than ${MIN_LENGTH} characters`);
  }
  return current;
}

/** Sets the process's redactor (tests), or forgets it so the next call reads the settings again. */
export function resetRedaction(r?: Redactor) {
  current = r;
}
