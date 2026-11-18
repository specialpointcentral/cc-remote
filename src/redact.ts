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

/** Lines that may carry base64 data, whose bytes are left alone. */
const BINARY = /"(?:base64|mimeType|media_type)"/;

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

/**
 * Applies a filter to a byte stream a line at a time, so a value is never split between two
 * chunks; a very long line is filtered in pieces.
 */
export class Lines {
  private held: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly f: (b: Uint8Array) => Uint8Array, private readonly max = 64 * 1024) {}

  push(chunk: Uint8Array): Uint8Array {
    const nl = chunk.lastIndexOf(10);
    if (nl < 0) {
      this.hold(chunk);
      return this.size > this.max ? this.flush() : EMPTY;
    }
    const out = this.f(Buffer.concat([...this.held, chunk.subarray(0, nl + 1)]));
    this.held = [];
    this.size = 0;
    if (nl + 1 < chunk.length) this.hold(chunk.subarray(nl + 1));
    return out;
  }

  flush(): Uint8Array {
    if (!this.size) return EMPTY;
    const all = Buffer.concat(this.held);
    this.held = [];
    this.size = 0;
    return this.f(all);
  }

  private hold(b: Uint8Array) {
    this.held.push(b.slice());
    this.size += b.length;
  }
}

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

  constructor(private readonly key: Uint8Array, values: Value[], o: RedactorOptions) {
    this.on = o.on;
    this.persist = o.persist;
    this.skipped = o.skipped ?? [];
    const seen = new Set<string>();
    this.values = values
      .filter((v) => v.text.length >= MIN_LENGTH && !seen.has(v.text.toLowerCase()) && seen.add(v.text.toLowerCase()))
      .sort((a, b) => b.text.length - a.text.length);
    for (const v of this.values) {
      this.kinds.set(v.text.toLowerCase(), v.kind);
      for (const spelling of new Set([v.text, v.text.toLowerCase(), v.text.toUpperCase()])) this.register(v.kind, spelling);
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

  /** A JSON line for the server, its base64 data left as it is. */
  jsonLine(line: string): string {
    if (!this.forward || !this.probe!.test(line)) return line;
    if (!BINARY.test(line)) return this.text(line);
    try {
      return JSON.stringify(this.walk(JSON.parse(line)));
    } catch {
      return this.text(line);
    }
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
    return new Lines(direction === "redact" ? (b) => this.bytes(b) : (b) => this.restoreBytes(b));
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

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const binary = o.type === "base64" || o.type === "image" || "mimeType" in o || "media_type" in o;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[this.text(k)] = binary && k === "data" && typeof x === "string" ? x : this.walk(x);
    return out;
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
