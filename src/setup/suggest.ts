import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * Where the central-server prompt finds its suggestions and Tab completions: `Host` names from
 * ~/.ssh/config and the files it includes, unhashed ~/.ssh/known_hosts entries, and the prompt's
 * own history. Only what is already on this machine; nothing is looked up on the network.
 */
export type Source = "history" | "ssh config" | "known_hosts";
export type Candidate = { value: string; source: Source };

/** A Host pattern rather than a name: `*`, `?` or a negation. */
const PATTERN = /[*?!]/;

/** The words of a config line, keeping "quoted words" together; `Key=value` splits at the `=`. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  const head = line.trim().replace(/^(\w+)\s*=\s*/, "$1 ");
  for (let m = re.exec(head); m; m = re.exec(head)) out.push(m[1] ?? m[2]!);
  return out;
}

/** The files an Include pattern names: a `*` or `?` in the last part of the path only, as is usual. */
function expand(pattern: string, home: string): string[] {
  const path = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(home, ".ssh", pattern);
  if (!/[*?[]/.test(basename(path))) return [path];
  try {
    const glob = new Bun.Glob(basename(path));
    return readdirSync(dirname(path)).filter((f) => glob.match(f)).sort().map((f) => join(dirname(path), f));
  } catch {
    return [];
  }
}

/**
 * The Host names in an ssh config file and the ones it includes, in order. Patterns are skipped,
 * and so is everything about Match blocks: they don't name hosts.
 */
export function sshConfigHosts(home: string, file = join(home, ".ssh", "config"), depth = 0, seen = new Set<string>()): string[] {
  if (depth > 16 || seen.has(file)) return [];
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [key, ...args] = words(line.replace(/(^|\s)#.*$/, ""));
    const keyword = key?.toLowerCase();
    if (keyword === "host") hosts.push(...args.filter((a) => !PATTERN.test(a)));
    else if (keyword === "include") for (const a of args) for (const f of expand(a, home)) hosts.push(...sshConfigHosts(home, f, depth + 1, seen));
  }
  return [...new Set(hosts)];
}

/**
 * The host names in known_hosts text: hashed (`|1|`) lines, revoked keys, CA keys and patterns are
 * skipped, and `[host]:port` becomes `ssh://host:port`.
 */
export function knownHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@") || line.startsWith("|")) continue;
    for (const name of line.split(/\s+/)[0]!.split(",")) {
      if (!name || PATTERN.test(name) || name.startsWith("|")) continue;
      const bracket = name.match(/^\[([^\]]+)\]:(\d+)$/);
      hosts.push(bracket ? (bracket[2] === "22" ? bracket[1]! : `ssh://${bracket[1]}:${bracket[2]}`) : name);
    }
  }
  return [...new Set(hosts)];
}

/** Every candidate, history first, then ssh config, then known_hosts, each value once. */
export function candidates(home: string, history: string[]): Candidate[] {
  let known: string[] = [];
  try {
    known = knownHosts(readFileSync(join(home, ".ssh", "known_hosts"), "utf8"));
  } catch {}
  const all: Candidate[] = [
    ...history.map((value) => ({ value, source: "history" as const })),
    ...sshConfigHosts(home).map((value) => ({ value, source: "ssh config" as const })),
    ...known.map((value) => ({ value, source: "known_hosts" as const })),
  ];
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.value) && seen.add(c.value));
}

/**
 * Tab completion: candidates that start with what was typed, and after `user@` the host part, so
 * `wei@cen<Tab>` gives `wei@central`.
 */
export function completer(list: Candidate[]): (line: string) => [string[], string] {
  return (line) => {
    const at = line.lastIndexOf("@");
    const user = at >= 0 && !line.startsWith("ssh://") ? line.slice(0, at + 1) : "";
    const typed = line.slice(user.length);
    const hosts = list.map((c) => (user ? c.value.replace(/^[^@/]*@/, "") : c.value));
    const hits = [...new Set(hosts.filter((h) => h.startsWith(typed)))].map((h) => user + h);
    return [hits, line];
  };
}

/**
 * What the user typed or pasted, cleaned: a leading `ssh `, and blanks around it, ASCII and the
 * kinds input methods and copy-paste bring along (no-break, ideographic and zero-width spaces, a
 * byte-order mark). Ported from remote-harness's trim_via and trim_blanks.
 */
export function cleanHost(raw: string): string {
  const trimmed = raw.replace(/^[\s 　​﻿]+|[\s 　​﻿]+$/g, "");
  return trimmed.replace(/^ssh[\s 　]+/, "").replace(/^[\s 　​﻿]+/, "");
}

/** A destination typed with ssh flags (`-p 2222 me@h`), taken apart; undefined when it has none. */
export type Flagged = { user?: string; host: string; port?: string; identity?: string; jump?: string; unsupported: string[] };

export function parseFlagged(input: string): Flagged | undefined {
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.length < 2 && !parts[0]?.startsWith("-")) return undefined;
  const out: Flagged = { host: "", unsupported: [] };
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const value = (flag: string) => (a.length > flag.length ? a.slice(flag.length) : parts[++i]);
    if (a.startsWith("-p")) out.port = value("-p");
    else if (a.startsWith("-l")) out.user = value("-l");
    else if (a.startsWith("-i")) out.identity = value("-i");
    else if (a.startsWith("-J")) out.jump = value("-J");
    else if (a.startsWith("-")) out.unsupported.push(a);
    else if (!out.host) {
      const at = a.lastIndexOf("@");
      if (at > 0) [out.user, out.host] = [a.slice(0, at), a.slice(at + 1)];
      else out.host = a;
    } else out.unsupported.push(a);
  }
  return out.host ? out : undefined;
}

/** Edit distance, for "did you mean" after a name that doesn't resolve. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/** The candidates closest to a name, at most `n`, for a host name that didn't resolve. */
export function closest(name: string, list: Candidate[], n = 3): string[] {
  const host = name.replace(/^[^@]*@/, "");
  return list
    .map((c) => ({ value: c.value, d: distance(host, c.value.replace(/^[^@]*@/, "")) }))
    .filter((c) => c.value !== name && c.d <= Math.max(2, Math.floor(host.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((c) => c.value);
}
