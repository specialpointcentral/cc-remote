import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform";
import { remoteCommand, rsh, runRemote } from "./ssh";
import { versionCache } from "./version";

/**
 * `claude auth status`, remembered per host for a minute. claude-agent-acp asks for it through the
 * `--cli` shim two or three times as each session starts, giving each answer five seconds, and
 * each is an ssh round trip; Orca may ask through `cc-remote claude auth status` too. Probes that
 * start together, as claude-agent-acp's do, wait for the first one's answer. Any `auth login` or
 * `auth logout` through cc-remote forgets the host's answers.
 *
 * Like the version cache, the format is in the file's name and content: older and newer cc-remotes
 * may share the folder, and a file this one can't read counts as no cache.
 */
export const authCache = { dir: versionCache.dir, ttlMs: 60_000, waitMs: 4_000 };

/** A probe that has held the lock this long was killed: the next one takes over. */
const STALE_MS = 15_000;

const FORMAT = 1;

type Entry = { out: string; code: number; at: number };

/** The same host through a different ssh command may be another machine. */
const file = (host: string) => join(authCache.dir, `auth-status-v${FORMAT}-${Bun.hash(`${host}\n${Bun.env.CC_REMOTE_SSH ?? ""}`).toString(36)}.json`);

/** What a claude command line does to the login: `status` asks, `change` logs in or out. Global `--settings` may come first. */
export function authCommand(args: string[]): "status" | "change" | undefined {
  const rest = args[0] === "--settings" ? args.slice(2) : args[0]?.startsWith("--settings=") ? args.slice(1) : args;
  if (rest[0] !== "auth") return undefined;
  if (rest[1] === "status") return "status";
  return rest[1] === "login" || rest[1] === "logout" ? "change" : undefined;
}

function entries(host: string): Record<string, Entry> {
  try {
    const saved = JSON.parse(readFileSync(file(host), "utf8"));
    return saved?.format === FORMAT && saved.entries && typeof saved.entries === "object" ? saved.entries : {};
  } catch {
    return {};
  }
}

/** The host's answer to these arguments, if it is less than the TTL old. */
export function cachedAuth(host: string, args: string[], now = Date.now()): Entry | undefined {
  const hit = entries(host)[JSON.stringify(args)];
  const fresh = typeof hit?.at === "number" && now - hit.at >= 0 && now - hit.at < authCache.ttlMs;
  return fresh && typeof hit.out === "string" && typeof hit.code === "number" ? hit : undefined;
}

/** Remembers an answer; the file is private, and replaced in one rename. One that can't be written is no cache. */
export function rememberAuth(host: string, args: string[], out: string, code: number, now = Date.now()) {
  try {
    mkdirSync(authCache.dir, { recursive: true, mode: 0o700 });
    const fresh = Object.entries(entries(host)).filter(([, e]) => now - e.at < authCache.ttlMs);
    const path = file(host);
    const temp = `${path}.${process.pid}`;
    const all = { ...Object.fromEntries(fresh), [JSON.stringify(args)]: { out, code, at: now } };
    writeFileSync(temp, JSON.stringify({ format: FORMAT, entries: all }), { mode: 0o600 });
    if (!WINDOWS) chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch {}
}

/** Forgets the host's answers. */
export const forgetAuth = (host: string) => rmSync(file(host), { force: true });

/** Runs claude on the host with stdout captured, stderr passed through and no stdin. */
function captured(host: string, args: string[], cwd: string): Promise<{ out: string; code: number }> {
  const [ssh, ...flags] = rsh();
  const child = spawn(ssh!, [...flags, "-T", host, remoteCommand(args, {}, cwd)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => (out += chunk));
  return new Promise((done) => {
    child.on("error", () => done({ out, code: 255 }));
    child.on("close", (code) => done({ out, code: code ?? 1 }));
  });
}

/**
 * The host's answer, asked once for the probes that start together: the first takes the host's
 * lock and asks, the others wait up to `waitMs` for what it remembers, then ask themselves.
 */
async function probe(host: string, args: string[], cwd: string): Promise<{ out: string; code: number }> {
  const lock = `${file(host)}.lock`;
  let held = false;
  try {
    mkdirSync(authCache.dir, { recursive: true, mode: 0o700 });
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { force: true });
    closeSync(openSync(lock, "wx", 0o600));
    held = true;
  } catch {}
  if (!held) {
    for (const until = Date.now() + authCache.waitMs; Date.now() < until;) {
      await Bun.sleep(50);
      const hit = cachedAuth(host, args);
      if (hit) return hit;
      if (!existsSync(lock)) break;
    }
  }
  try {
    const { out, code } = await captured(host, args, cwd);
    // Logged out is an answer too: claude says so with status 1. ssh's own failures are not.
    if ((code === 0 || code === 1) && out.trim()) rememberAuth(host, args, out, code);
    return { out, code };
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

/**
 * `claude <args>` on the host, for `cc-remote --cli` and claude's subcommands under `cc-remote
 * claude`: an auth status from the cache when it can be, any other command as it is.
 */
export async function runClaude(host: string, args: string[], cwd: string): Promise<number> {
  const kind = authCommand(args);
  if (kind === "change") {
    forgetAuth(host);
    try {
      return await runRemote(host, args, cwd);
    } finally {
      forgetAuth(host);
    }
  }
  if (kind !== "status") return runRemote(host, args, cwd);
  const { out, code } = cachedAuth(host, args) ?? (await probe(host, args, cwd));
  await new Promise((written) => process.stdout.write(out, written));
  return code;
}
