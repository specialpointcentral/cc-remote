import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Claude Code's read-only shell commands, for the local shell: `ls`, `cat`, `git status` and the
 * like run without asking in the default, acceptEdits, plan and dontAsk modes, as Claude Code's own
 * Bash runs them ("Read-only commands" in its permissions docs). claude can't tell that of an MCP
 * tool, so without this every `ls` would ask.
 *
 * Deliberately narrower than Claude Code's set, and only for commands read in full:
 *
 * - plain words and quotes; no expansion (`$`, backticks), subshell, brace, comment, history or
 *   background `&`, and nothing on more than one line;
 * - simple commands joined by `|`, `&&`, `||` or `;`, each of them an allowed command whose
 *   arguments carry no flag that writes, runs a program or opens a pager;
 * - redirection only to `/dev/null`, between streams (`2>&1`), or from a file;
 * - unquoted globs only for commands without a flag a glob could turn into a write;
 * - `cd` only into the working directories, and then no `git` in the same command, since git in
 *   another directory runs that directory's hooks and config;
 * - no leading `VAR=value` assignment, and no wrapper such as `sudo`, `env` or `xargs`.
 *
 * Deny and ask rules, and the critical-path check, are applied before this (rules.ts).
 */

/** Where a command runs: the session's directories, and the shell's current one. */
export type Place = { root: string; cwd?: string; dirs?: string[] };

type Word = { text: string; glob: boolean };
type Check = (args: Word[], place: Place) => boolean;

/** Splits a command into simple commands, or undefined when it holds anything this doesn't allow. */
export function plainCommands(command: string): Word[][] | undefined {
  if (command.length > 10_000) return undefined;
  const commands: Word[][] = [[]];
  let text = "", started = false, glob = false;
  const finish = () => {
    if (started) commands.at(-1)!.push({ text, glob });
    text = ""; started = false; glob = false;
  };
  const separate = () => {
    finish();
    if (!commands.at(-1)!.length) return false; // `&& x`, `x ;;`
    commands.push([]);
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!, next = command[i + 1] ?? "";
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      text += command.slice(i + 1, close); started = true; i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!;
        if (d === "$" || d === "`") return undefined;
        if (d === "\\" && /[\\"]/.test(command[j + 1] ?? "")) { text += command[++j]; continue; }
        if (d === "\\" && /[$`\n]/.test(command[j + 1] ?? "")) return undefined;
        text += d;
      }
      if (j >= command.length) return undefined;
      started = true; i = j;
    } else if (c === "\\") {
      if (!next || next === "\n" || next === "\r") return undefined;
      text += next; started = true; i++;
    } else if (c === " " || c === "\t") finish();
    else if (c === "|") {
      if (next === "&") return undefined;
      if (next === "|") i++;
      if (!separate()) return undefined;
    } else if (c === "&") {
      if (next !== "&" || !separate()) return undefined;
      i++;
    } else if (c === ";") {
      if (next === ";" || !separate()) return undefined;
    } else if (c === ">" || c === "<") {
      // The stream number before it, if any, belongs to the redirection.
      if (started && !/^\d$/.test(text)) finish();
      text = ""; started = false; glob = false;
      const target = redirection(command, i);
      if (!target) return undefined;
      i = target.end - 1;
    } else if ("$`(){}#!\n\r".includes(c)) return undefined;
    else {
      if ("*?[".includes(c)) glob = true;
      text += c; started = true;
    }
  }
  finish();
  if (!commands.at(-1)!.length) return undefined; // empty, or ending in an operator
  return commands;
}

/**
 * The redirection at `i`, if it is one this allows: to /dev/null (`>`, `>>`), between streams
 * (`>&1`, `>&2`), or from a plain file (`<`). Returns where it ends.
 */
function redirection(command: string, i: number): { end: number } | undefined {
  const input = command[i] === "<";
  let j = i + 1;
  if (!input && command[j] === ">") j++;
  else if (!input && command[j] === "&") {
    const m = /^&[12](?=[\s;|&]|$)/.exec(command.slice(j));
    return m ? { end: j + m[0].length } : undefined;
  } else if (input && /[<>&(]/.test(command[j] ?? "")) return undefined;
  while (command[j] === " " || command[j] === "\t") j++;
  const m = /^[\p{L}\p{N}\-_./:=,@%+~]+/u.exec(command.slice(j));
  if (!m) return undefined;
  if (!input && m[0] !== "/dev/null") return undefined;
  // bash opens these as network connections.
  if (input && /^\/dev\/(tcp|udp)\//.test(m[0])) return undefined;
  return { end: j + m[0].length };
}

/** Any arguments, globs included: none of these has a flag that writes or runs anything. */
const ANY: Check = () => true;
/** Any arguments but no globs: a glob could turn into a flag. */
const plain: Check = (args) => args.every((a) => !a.glob);
/**
 * Whether `arg` is one of these long options, also abbreviated: getopt_long and git's parser take
 * any unambiguous prefix, so `sort --o=x` is `sort --output=x`.
 */
const long = (arg: string, names: string[]) => {
  const name = /^--([^=]+)/.exec(arg)?.[1];
  return name !== undefined && names.some((n) => n.startsWith(name));
};
/**
 * Any arguments but no globs, nor a flag `short` matches (match a whole cluster of short flags,
 * `-[^-]*o`, since `-ro` is `-r -o`), nor one of the `longs`, however abbreviated.
 */
const unless = (short: RegExp | undefined, longs: string[] = []): Check => (args) => plain(args, { root: "" })
  && args.every((a) => !a.text.startsWith("-") || !((short?.test(a.text) ?? false) || long(a.text, longs)));
/** The commands whose arguments may be unquoted globs: all their flags only read. */
const GLOBS_OK = new Set(["ls", "cat", "head", "tail", "wc", "nl", "stat", "du", "grep", "egrep", "fgrep", "diff", "cmp"]);

/** git options before the subcommand that can't run or redirect anything. */
const GIT_GLOBAL = /^(--no-pager|-P|--no-optional-locks|--literal-pathspecs|--no-replace-objects)$/;

/** Diff and log output can go to a file, and an external diff program can run. */
const DIFF_WRITES = unless(undefined, ["output", "ext-diff"]);

/** `git branch` lists: only these flags, and names only as --list's patterns or a flag's value. */
const branch: Check = (args) => {
  let list = false, names = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (args[i]!.glob) return false;
    if (/^--(contains|no-contains|merged|no-merged|points-at|sort|format)$/.test(a)) i++;
    else if (a === "-l" || a === "--list") list = true;
    else if (!a.startsWith("-")) names = true;
    else if (!/^(-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|-i|--ignore-case|--omit-empty|--no-column|--column(=.*)?|--(contains|no-contains|merged|no-merged|points-at|sort|format|color)=.*|--color)$/.test(a)) return false;
  }
  return list || !names;
};

/** `git config` reads: one getting action (also as git 2.46's get and list), scope and output flags. */
const config: Check = (args) => {
  if (!plain(args, { root: "" })) return false;
  if (args[0]?.text === "get" || args[0]?.text === "list") args = args.slice(1);
  else if (!args.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a.text))) return false;
  return args.every((a) => !a.text.startsWith("-")
    || /^(--get|--get-all|--get-regexp|--list|-l|--global|--system|--local|--worktree|--show-origin|--show-scope|--null|-z|--name-only|--includes|--no-includes|--all|--type=.*|--default=.*)$/.test(a.text));
};

/** git subcommands, by what they may be given. */
const GIT: Record<string, Check> = {
  status: plain, log: DIFF_WRITES, show: DIFF_WRITES, diff: DIFF_WRITES, shortlog: DIFF_WRITES,
  "rev-parse": plain, "rev-list": DIFF_WRITES, "ls-files": plain, "ls-tree": plain, "cat-file": plain, "show-ref": plain,
  "for-each-ref": plain, blame: DIFF_WRITES, describe: plain, version: plain,
  // -O runs a program (its value, or the pager) on the matching files.
  grep: unless(/^-[^-]*O/, ["open-files-in-pager"]),
  branch,
  config,
  // Without a name `remote show` lists too, but with one it asks the remote over the network.
  remote: (args) => args.every((a) => /^(-v|--verbose)$/.test(a.text)) || (args[0]?.text === "get-url" && plain(args, { root: "" })),
  stash: (args) => args[0]?.text === "list" && DIFF_WRITES(args.slice(1), { root: "" }),
  worktree: (args) => args[0]?.text === "list" && args.slice(1).every((a) => /^(--porcelain|-v|--verbose|-z)$/.test(a.text)),
  // Shows the log; `reflog expire` and `reflog delete` change it.
  reflog: (args) => (args.length === 0 || args[0]!.text === "show" || args[0]!.text.startsWith("-")) && DIFF_WRITES(args, { root: "" }),
};

const git: Check = (args, place) => {
  let i = 0;
  while (i < args.length && args[i]!.text.startsWith("-")) {
    if (!GIT_GLOBAL.test(args[i]!.text)) return false;
    i++;
  }
  const sub = args[i]?.text;
  return sub !== undefined && Object.hasOwn(GIT, sub) && !args[i]!.glob && GIT[sub]!(args.slice(i + 1), place);
};

/** uniq's second operand is its output file. */
const uniq: Check = (args) => {
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.text;
    if (args[i]!.glob) return false;
    if (/^-[fsw]$|^--(skip-fields|skip-chars|check-chars)$/.test(a)) i++;
    else if (!a.startsWith("-") || a === "-") operands++;
  }
  return operands <= 1;
};

const COMMANDS: Record<string, Check> = {
  ls: ANY, cat: ANY, head: ANY, tail: ANY, wc: ANY, nl: ANY, stat: ANY, du: ANY, df: ANY, pwd: ANY, echo: ANY,
  grep: ANY, egrep: ANY, fgrep: ANY, diff: ANY, cmp: ANY, comm: plain, cut: plain,
  realpath: plain, readlink: plain, dirname: plain, basename: plain,
  whoami: ANY, id: ANY, uname: ANY, nproc: ANY, true: ANY, type: plain,
  // Lookup and display only: other flags read alias and function definitions from stdin.
  which: unless(/^(?!(-a|-s)$)/),
  file: unless(/^-[^-]*[Cmf]/, ["compile", "magic-file", "files-from"]),
  tree: unless(/^-[^-]*[oR]/, ["output", "fromfile"]),
  rg: unless(undefined, ["pre", "hostname-bin"]),
  find: (args) => args.every((a) => !a.glob)
    && args.every((a) => !/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from)$/.test(a.text)),
  sort: unless(/^-[^-]*o/, ["output", "compress-program"]),
  uniq,
  git,
};

const home = () => process.env.HOME || homedir();

/** Where a `cd` with these arguments goes from `at`, when that is a literal directory inside the working directories. */
function cdInside(args: Word[], place: Place, at: string): string | undefined {
  const targets = args.filter((a) => a.text !== "--");
  if (targets.length !== 1 || targets[0]!.glob || targets[0]!.text.startsWith("-")) return undefined;
  const path = resolve(at, targets[0]!.text.replace(/^~(?=\/|$)/, home()));
  const inside = [place.root, ...(place.dirs ?? [])].some((dir) => {
    const rel = relative(dir, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  return inside ? path : undefined;
}

/** Whether a shell command only reads, as the commands above are read. */
export function readOnly(command: string, place: Place): boolean {
  const commands = plainCommands(command);
  if (!commands) return false;
  let at = place.cwd ?? place.root;
  let moved = false;
  for (const [name, ...args] of commands) {
    const word = name!.text;
    if (name!.glob || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return false;
    if (word === "cd") {
      const next = cdInside(args, place, at);
      if (next === undefined) return false;
      moved ||= next !== at;
      at = next;
      continue;
    }
    if (!Object.hasOwn(COMMANDS, word)) return false;
    if (word === "git" && moved) return false;
    if (!GLOBS_OK.has(word) && args.some((a) => a.glob)) return false;
    if (!COMMANDS[word]!(args, place)) return false;
  }
  return true;
}
