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
 * - literal paths, `~` and `$HOME`, relative ones against the working directory, with a trailing `/*`
 * - a glob or trailing slash directly under another variable (`"$DIR"/*`), which removes from the
 *   root when the variable is empty
 * - a recursive removal of a target that is only a command substitution's output (`"$(pwd)"`)
 * - removals nested in substitutions and subshells (the lexer's), and in `sh -c` style scripts
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

const home = () => process.env.HOME || homedir();

const base = (word: string | undefined) => word?.slice(word.lastIndexOf("/") + 1);

/** Whether a removal target names a critical path, for a session working in `cwd`. */
function critical(target: string, recursive: boolean, cwd: string): boolean {
  // `~/$(cmd)` is checked as what is left if the substitution prints nothing.
  let t = target.replace(/(\$\(\))+$/, "");
  if (t === "") return recursive && target !== "";
  t = t.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home());
  // An empty variable turns `$DIR/*` or `$DIR/` into a removal from the root.
  if (/^\$\{?\w+\}?\/(\*?)$/.test(t)) return true;
  if (t.includes("$")) return false;
  // A glob directly under a directory removes what that directory holds: `*` is the working directory's.
  const path = resolve(cwd, t === "*" ? "." : t.replace(/\/\*\/?$/, "") || "/");
  if (!isAbsolute(path)) return false;
  if (path === "/" || dirname(path) === "/") return true;
  if (path === resolve(home())) return true;
  // The working directory and its parents; a glob under the working directory is one of them too.
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (path === dir) return true;
    if (dir === dirname(dir)) return false;
  }
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

/** The critical path a command removes, if any. Nested `sh -c` scripts are checked too. */
export function criticalRemoval(command: string, cwd: string, depth = 0): string | undefined {
  let commands: SimpleCommand[];
  try {
    commands = simpleCommands(command);
  } catch (e) {
    if (e instanceof ShellSyntaxError) return undefined; // Left to the rules, which deny what they can't split.
    throw e;
  }
  for (const c of commands) {
    const r = removal(c);
    if (r) {
      const hit = r.targets.find((t) => critical(t, r.recursive, cwd));
      if (hit !== undefined) return hit;
    }
    const script = SHELLS.has(base(c.words[0]) ?? "") ? c.words[c.words.indexOf("-c") + 1] : undefined;
    if (script && c.words.includes("-c") && depth < 3) {
      const hit = criticalRemoval(script, cwd, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
