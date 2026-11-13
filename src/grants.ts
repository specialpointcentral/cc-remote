import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform";
import { argument } from "./ssh";
import { versionCache } from "./version";

/**
 * "Allow for this session" approvals of shell commands (`Bash(npm test:*)`), kept per session in a
 * private file, so that they outlive the claude process that got them. Orca starts claude again,
 * resuming the same session, whenever the user switches a chat's mode or model; without this the
 * chat would ask again for everything approved so far. A claude process for a session takes up the
 * file when it starts, and adds to it with every approval. A file nobody has used for `ttlMs` is
 * removed.
 *
 * The format is in the folder's name and the file's content: cc-remotes of other formats keep
 * their own folders, and a file this one can't read counts as no approvals.
 */
export const grantStore = { dir: join(versionCache.dir, "grants", "v1"), ttlMs: 3 * 24 * 60 * 60_000 };

const FORMAT = 1;

/** Session ids are UUIDs; anything that could leave the folder is refused. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The session a claude command line starts or resumes, when it says: not a fork's new one, which claude names. */
export function grantsSession(args: string[]): string | undefined {
  const id = argument(args, "--session-id") ?? (args.includes("--fork-session") ? undefined : argument(args, "--resume", "-r"));
  return id && SESSION.test(id) ? id : undefined;
}

const file = (sessionId: string) => join(grantStore.dir, `${sessionId}.json`);

let swept = false;

/** Removes the files nobody has used for the TTL, once per process. */
function sweep(now: number) {
  if (swept) return;
  swept = true;
  try {
    for (const name of readdirSync(grantStore.dir)) {
      const path = join(grantStore.dir, name);
      try {
        if (now - statSync(path).mtimeMs >= grantStore.ttlMs) rmSync(path, { force: true });
      } catch {}
    }
  } catch {}
}

/** The approvals this session got in this directory, in an earlier claude process too. Using them keeps the file. */
export function loadGrants(sessionId: string, cwd: string, now = Date.now()): string[] {
  if (!SESSION.test(sessionId)) return [];
  sweep(now);
  const path = file(sessionId);
  try {
    if (now - statSync(path).mtimeMs >= grantStore.ttlMs) return [];
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.format !== FORMAT || saved.sessionId !== sessionId || saved.cwd !== cwd || !Array.isArray(saved.grants)) return [];
    utimesSync(path, now / 1000, now / 1000);
    return saved.grants.filter((g: unknown): g is string => typeof g === "string");
  } catch {
    return [];
  }
}

/**
 * Adds these approvals to the session's file, with those another process for the session saved
 * meanwhile. The new file replaces the old in one rename; one that can't be written is no file.
 */
export function saveGrants(sessionId: string, cwd: string, grants: Iterable<string>, now = Date.now()) {
  if (!SESSION.test(sessionId)) return;
  sweep(now);
  try {
    mkdirSync(grantStore.dir, { recursive: true, mode: 0o700 });
    if (!WINDOWS) chmodSync(grantStore.dir, 0o700);
    const all = [...new Set([...loadGrants(sessionId, cwd, now), ...grants])];
    const path = file(sessionId);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ format: FORMAT, sessionId, cwd, grants: all, at: now }), { mode: 0o600 });
    if (!WINDOWS) chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (e) {
    console.error(`cc-remote: could not keep this session's approvals for later: ${(e as Error).message}`);
  }
}

/** Forgets that this process swept the folder. For tests. */
export function resetGrants() {
  swept = false;
}
