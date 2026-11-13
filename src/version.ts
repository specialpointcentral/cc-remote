import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform";
import { home } from "./tools/util";

/**
 * The oldest host claude cc-remote starts. Every session leaves out claude's dynamic prompt
 * sections (`excludeDynamicSections`), which describe the host; before 2.1.268 that broke prompt
 * caching and extended thinking mid-session. The rest cc-remote relies on (the transcript mirror,
 * tool aliases, SDK servers in `initialize`) has worked since 2.1.248 at least.
 */
export const MIN_CLAUDE = "2.1.268";

/** Whether version `a` comes before `b`, comparing major.minor.patch. */
export function older(a: string, b: string): boolean {
  const [x, y] = [a, b].map((s) => s.split(/[.-]/).map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! < y![i]!;
  return false;
}

/** The version number in what `claude --version` prints, such as `2.1.323 (Claude Code)`. */
export const versionNumber = (output: string) => output.trim().match(/^\d+\.\d+\.\d+/)?.[0];

/** Why a host claude that printed this can't be used, or undefined when it can (or can't be told). */
export function tooOld(host: string, output: string): string | undefined {
  const version = versionNumber(output);
  if (!version || !older(version, MIN_CLAUDE)) return undefined;
  return `claude on ${host} is ${version}, older than the ${MIN_CLAUDE} cc-remote needs. Run \`claude update\` on ${host}, then \`cc-remote doctor\`.`;
}

function cacheRoot(): string {
  if (WINDOWS) return Bun.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  if (process.platform === "darwin") return join(home, "Library", "Caches");
  return Bun.env.XDG_CACHE_HOME || join(home, ".cache");
}

/**
 * Each host's `claude --version`, remembered for a while. An app such as Orca asks for the version
 * before every chat, and every session start checks it; neither needs an ssh round trip for that.
 */
export const versionCache = { dir: join(cacheRoot(), "cc-remote"), ttlMs: 10 * 60_000 };

/**
 * The cache file's format. Older and newer cc-remotes may run side by side and share the cache
 * folder: the format is in the name and the content, and anything else reads as no cache.
 */
const FORMAT = 1;

/** The same host through a different ssh command may be another machine. */
const file = (host: string) => join(versionCache.dir, `claude-version-v${FORMAT}-${Bun.hash(`${host}\n${Bun.env.CC_REMOTE_SSH ?? ""}`).toString(36)}.json`);

/**
 * CC_REMOTE_NO_VERSION_CACHE=1 turns the cache off both ways, so every answer comes live from the
 * host: for setup's end-to-end check, for `update` checking the host with a new version, and for
 * debugging.
 */
const disabled = () => Bun.env.CC_REMOTE_NO_VERSION_CACHE === "1";

/** What the host's claude printed for --version, if that was less than the TTL ago. */
export function cachedVersion(host: string, now = Date.now()): string | undefined {
  if (disabled()) return undefined;
  try {
    const { format, output, at } = JSON.parse(readFileSync(file(host), "utf8"));
    const fresh = typeof at === "number" && now - at >= 0 && now - at < versionCache.ttlMs;
    return format === FORMAT && typeof output === "string" && fresh ? output : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers what the host's claude printed for --version. A cache that can't be written is no cache. */
export function rememberVersion(host: string, output: string, now = Date.now()) {
  if (!versionNumber(output) || disabled()) return;
  try {
    mkdirSync(versionCache.dir, { recursive: true, mode: 0o700 });
    const path = file(host);
    const temp = `${path}.${process.pid}`;
    writeFileSync(temp, JSON.stringify({ format: FORMAT, output: output.trim(), at: now }), { mode: 0o600 });
    if (!WINDOWS) chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch {}
}
