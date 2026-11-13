import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { ShellSyntaxError, simpleCommands, type SimpleCommand } from "./lexer";

/**
 * Claude Code's critical-path removal check, for the local shell: an `rm` or `rmdir` of the
 * filesystem root, a top-level directory, the home directory, or the working directory or one of
 * its parents (also as a glob under one of them) is never approved by a rule, a grant or a mode.
 * claude applies it only to its own Bash, so without this an allow rule or bypassPermissions would
 * run `rm -rf ~` through the local one. It covers the common forms, not every target the native
 * check knows (see "Which paths are critical" in Claude Code's permission modes):
 *
 * - literal paths, `~` and `$HOME`, relative ones against the shell's current directory, with a
 *   trailing `/*`
 * - a glob or trailing slash directly under another variable (`"$DIR"/*`), which removes from the
 *   root when the variable is empty
 * - a recursive removal of a target that is only a command substitution's output (`"$(pwd)"`)
 * - removals nested in substitutions and subshells (the lexer's), and in `sh -c` style scripts
 *
 * The working directory counts twice: the session's, where the shell started, and the one the
 * shell is in now, with the parents of both. A relative target resolves against the shell's current
 * directory, and against every directory a `cd` (or `pushd`, or `env -C`, `sudo -D`) in the command
 * may have moved it to: the lexer doesn't say which commands run, or in which subshell, so a `cd`
 * adds a place rather than replacing one. After a `cd` to somewhere not written out (`cd "$DIR"`,
 * `cd -`, `popd`), every relative target counts as critical.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** More places than this after the `cd`s, and they count as unknown. */
const MAX_PLACES = 16;

const home = () => process.env.HOME || homedir();

const base = (word: string | undefined) => word?.slice(word.lastIndexOf("/") + 1);

/** `~` and `$HOME` at the start of a word, as the shell expands them. */
const expandHome = (word: string) => word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home());

/** The directories a command may run in, or null when one of them isn't known. */
type Places = string[] | null;

/** Whether a removal target names a critical path, run from `cwd`, with `guarded` the working directories. */
function critical(target: string, recursive: boolean, cwd: string | null, guarded: string[]): boolean {
  // `~/$(cmd)` is checked as what is left if the substitution prints nothing.
  let t = target.replace(/(\$\(\))+$/, "");
  if (t === "") return recursive && target !== "";
  t = expandHome(t);
  // An empty variable turns `$DIR/*` or `$DIR/` into a removal from the root.
  if (/^\$\{?\w+\}?\/(\*?)$/.test(t)) return true;
  if (t.includes("$")) return false;
  if (cwd === null && !isAbsolute(t)) return true;
  // A glob directly under a directory removes what that directory holds: `*` is the current directory's.
  const path = resolve(cwd ?? "/", t === "*" ? "." : t.replace(/\/\*\/?$/, "") || "/");
  if (!isAbsolute(path)) return false;
  if (path === "/" || dirname(path) === "/") return true;
  if (path === resolve(home())) return true;
  // The working directories and their parents; a glob under one is one of them too.
  return guarded.some((start) => {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      if (path === dir) return true;
      if (dir === dirname(dir)) return false;
    }
  });
}

/** The removal targets of one simple command, if it is `rm` or `rmdir`, and whether it is recursive. */
function removal(command: SimpleCommand): { targets: string[]; recursive: boolean } | undefined {
  const name = base(command.words[0]);
  if (name !== "rm" && name !== "rmdir") return undefined;
  const targets: string[] = [];
  let recursive = false, options = true;
  for (const word of command.words.slice(1)) {
    if (options && word === "--") { options = false; continue; }
    if (options && /^-[A-Za-z]+$/.test(word)) { if (/[rR]/.test(word)) recursive = true; continue; }
    if (options && word.startsWith("--")) { if (word === "--recursive") recursive = true; continue; }
    targets.push(word);
  }
  return { targets, recursive };
}

/** Where `target` (undefined: the home directory, as for a bare `cd`) is from each of `places`. */
function into(places: Places, target: string | undefined): Places {
  if (places === null) return null;
  const to = target === undefined ? home() : expandHome(target);
  // `cd -`, a variable, a substitution, a glob or `~user`: where it goes isn't written out.
  if (to === "-" || /[$`*?[~]/.test(to)) return null;
  return places.map((p) => resolve(p, to));
}

/** The places after a `cd`: where it went, and where it was, since the cd may be in a subshell or not run at all. */
function move(places: Places, target: string | undefined): Places {
  const to = into(places, target);
  if (places === null || to === null) return null;
  const next = [...new Set([...places, ...to])];
  return next.length > MAX_PLACES ? null : next;
}

/** The directory a `cd`-like command moves to, or undefined for its home directory; null when it is no such command. */
function cdTarget(command: SimpleCommand): string | undefined | null {
  const name = base(command.words[0]);
  if (name !== "cd" && name !== "pushd" && name !== "chdir") return null;
  const args = command.words.slice(1);
  const at = args.findIndex((w) => w === "--" || !/^-[LPe@]+$/.test(w));
  const word = at < 0 ? undefined : args[at] === "--" ? args[at + 1] : args[at];
  return word;
}

/** Each wrapper's option that runs its command in another directory. */
const CHDIR: Record<string, RegExp> = { env: /^(-C|--chdir)$/, sudo: /^(-D|--chdir)$/ };

/** The directory a wrapper such as `env -C dir` or `sudo -D dir` runs its command in; null when there is none. */
function wrapperDir(command: SimpleCommand): string | null {
  const w = command.wrappers;
  let wrapper = "";
  for (let i = 0; i < w.length; i++) {
    const word = w[i]!;
    if (!word.startsWith("-")) wrapper = base(word) ?? "";
    else if (CHDIR[wrapper]?.test(word)) return w[i + 1] ?? "$";
    else if (CHDIR[wrapper] && word.startsWith("--chdir=")) return word.slice("--chdir=".length);
  }
  return null;
}

function scan(command: string, root: string, start: string, places: Places, depth: number): string | undefined {
  let commands: SimpleCommand[];
  try {
    commands = simpleCommands(command);
  } catch (e) {
    if (e instanceof ShellSyntaxError) return undefined; // Left to the rules, which deny what they can't split.
    throw e;
  }
  const guarded = [...new Set([root, start])];
  for (const c of commands) {
    if (base(c.words[0]) === "popd") { places = null; continue; }
    const target = cdTarget(c);
    if (target !== null) { places = move(places, target); continue; }
    const dir = wrapperDir(c);
    const here = dir === null ? places : into(places, dir);
    const r = removal(c);
    if (r) {
      const hit = r.targets.find((t) => (here === null ? [null] : here).some((cwd) => critical(t, r.recursive, cwd, guarded)));
      if (hit !== undefined) return hit;
    }
    const script = SHELLS.has(base(c.words[0]) ?? "") ? c.words[c.words.indexOf("-c") + 1] : undefined;
    if (script && c.words.includes("-c") && depth < 3) {
      const hit = scan(script, root, start, here, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * The critical path a command removes, if any, for a session rooted at `root` whose shell is now in
 * `cwd`. Nested `sh -c` scripts are checked too.
 */
export function criticalRemoval(command: string, root: string, cwd = root): string | undefined {
  return scan(command, root, cwd, [cwd], 0);
}
