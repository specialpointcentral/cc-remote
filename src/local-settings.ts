import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WINDOWS } from "./platform";

/**
 * Where a session's `.claude/settings.local.json` lives, as Claude Code 2.1.211 and later place it:
 * started anywhere in a git repository, Claude Code reads and writes that file at the repository
 * root (the main checkout's root, from a worktree), so an approval holds across the repository. It
 * stays beside `.claude/settings.json` outside a repository, when the root is the home directory, on
 * Windows, and when the root, its `.git` or its `.claude` isn't the user's own. A file an earlier
 * version left in the starting directory is still read, and both files' rules apply.
 */

const FILE = join(".claude", "settings.local.json");

/** The pattern Claude Code adds to the global git excludes, so the file stays out of every repository. */
export const IGNORE_PATTERN = "**/.claude/settings.local.json";

const git = (args: string[], cwd: string) => {
  try {
    // The current environment, not the one Bun started with, which spawn otherwise passes on.
    const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString().trim() };
  } catch {
    return { code: -1, out: "" }; // No git on PATH.
  }
};

/** The home directory as of now: $HOME, as git reads it. */
const home = () => process.env.HOME || homedir();

const real = (path: string) => {
  try { return realpathSync(path); } catch { return path; }
};

/** Owned by this user. A missing entry counts as owned: there is nothing for someone else to have put there. */
function own(path: string): boolean {
  try {
    return lstatSync(path).uid === process.getuid?.();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** The repository root whose settings.local.json counts for `root`, if any: the main checkout's, from a worktree. */
function repositoryRoot(root: string): string | undefined {
  if (WINDOWS) return undefined;
  const r = git(["rev-parse", "--show-toplevel", "--git-common-dir"], root);
  const [top, common] = r.code === 0 ? r.out.split("\n") : [];
  if (!top || !common) return undefined;
  // A worktree's common directory is the main checkout's `.git`. A bare repository's or a
  // submodule's is not, and then the worktree's own top level is the root.
  const commonDir = resolve(root, common);
  const repo = real(basename(commonDir) === ".git" ? dirname(commonDir) : top);
  if (repo === real(home())) return undefined;
  if (!own(repo) || !own(join(repo, ".git")) || !own(join(repo, ".claude"))) return undefined;
  return repo;
}

const roots = new Map<string, string | undefined>();

/**
 * The directory whose `.claude/settings.local.json` holds this session's local settings. Found once
 * per session root; a folder that becomes a repository later is picked up by the next session.
 */
export function localSettingsDir(root: string): string {
  if (!roots.has(root)) roots.set(root, repositoryRoot(root));
  return roots.get(root) ?? root;
}

/** Forgets what localSettingsDir found. For tests. */
export function resetLocalSettings() {
  roots.clear();
}

/** The local settings files to read for a session root: the starting directory's, then the repository root's. */
export function localSettingsFiles(root: string): string[] {
  const dir = localSettingsDir(root);
  return real(dir) === real(root) ? [join(root, FILE)] : [join(root, FILE), join(dir, FILE)];
}

/** The file "always allow" writes to. */
export const localSettingsFile = (root: string) => join(localSettingsDir(root), FILE);

/** Whether git tracks the file, so a rule saved in it would go to everyone who clones the repository. */
export function tracked(file: string): boolean {
  return git(["ls-files", "--error-unmatch", "--", basename(file)], dirname(file)).code === 0;
}

/** The global excludes file, as Claude Code picks it: core.excludesFile when absolute or `~`-prefixed, else git's default. */
export function globalExcludesFile(cwd: string): string {
  const set = git(["config", "--global", "--get", "core.excludesFile"], cwd).out;
  if (set === "~" || set.startsWith("~/")) return join(home(), set.slice(1));
  if (set && isAbsolute(set)) return set;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home(), ".config"), "git", "ignore");
}

/**
 * Keeps a settings.local.json in a git repository out of commits, as Claude Code does the first time
 * it writes one: unless git already ignores it, `**\/.claude/settings.local.json` goes into the
 * global excludes file, once. Returns the excludes file when it was changed.
 */
export function ignoreGlobally(file: string): string | undefined {
  const dir = dirname(dirname(file));
  if (git(["rev-parse", "--is-inside-work-tree"], dir).out !== "true") return undefined;
  // check-ignore needs the path inside the repository; it need not exist yet.
  if (git(["check-ignore", "-q", "--no-index", "--", FILE], dir).code === 0) return undefined;
  const excludes = globalExcludesFile(dir);
  let text = "";
  try { text = readFileSync(excludes, "utf8"); } catch {}
  if (text.split(/\r?\n/).some((line) => line.trim() === IGNORE_PATTERN)) return undefined;
  mkdirSync(dirname(excludes), { recursive: true });
  appendFileSync(excludes, `${text && !text.endsWith("\n") ? "\n" : ""}${IGNORE_PATTERN}\n`);
  return excludes;
}
