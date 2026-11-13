/**
 * The simple commands in a POSIX shell command, the way Claude Code's Bash permission rules see
 * them. A lexical pass, not a shell: it keeps quoted arguments, comments and here-document text out
 * of command positions, follows `$(...)`, backticks and `<(...)` into the commands they run, and
 * skips the wrappers that run their arguments as the actual command (`sudo`, `env`, `timeout`, ...).
 * Ported from remote-harness's check_command_policy in run-on-project-host.sh.
 */

export type SimpleCommand = {
  /** The words from the command word on, quotes removed. A word holding a substitution ends in `$()`. */
  words: string[];
  /** The wrapper words skipped before the command word, such as `sudo -u root`. */
  wrappers: string[];
};

/** Incomplete quoting, substitution or here-document, or a command word only the shell can decode. */
export class ShellSyntaxError extends Error {}

/** Claude Code's stripped wrappers, plus remote-harness's (`env`, `exec`, `sudo`). */
const WRAPPERS = new Set(["builtin", "command", "env", "exec", "nice", "noglob", "nohup", "stdbuf", "sudo", "time", "timeout", "xargs"]);

/** A wrapper's options that take the next word as their value. */
const OPTION_VALUES: Record<string, RegExp> = {
  env: /^(-u|--unset|-C|--chdir)$/,
  exec: /^-a$/,
  nice: /^(-n|--adjustment)$/,
  stdbuf: /^(-[ioe]|--(input|output|error))$/,
  sudo: /^(-[acCDghpRrtTUu]|--(auth-type|login-class|close-from|chdir|group|host|prompt|chroot|role|type|other-user|command-timeout|user))$/,
  time: /^(-[fo]|--(format|output))$/,
  timeout: /^(-[sk]|--(signal|kill-after))$/,
  xargs: /^(-[adEILnPs]|--(arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var))$/,
};

/** Words that start a command list without being a command. */
const KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const ANSI: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

type Quote = "" | "'" | '"' | "ansi";

/** What a substitution saves of the command around it, to pick up again when it closes. */
type Frame = {
  kind: "(" | "`";
  /** Opened in here-document text, where the command around it is data. */
  here: boolean;
  word: string; present: boolean; quoted: boolean; opaque: boolean; quote: Quote;
  expect: boolean; redirection: "" | "file" | "here";
  wrapper: string; wrapperValue: boolean; positional: number; wrapped: string[]; wrapperStart: number;
  record: SimpleCommand | null; depth: number; arithmetic: number;
};

/** Each simple command in `source`, inner substitutions before the command holding them. */
export function simpleCommands(source: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let word = "", present = false, quoted = false, opaque = false, quote: Quote = "";
  let redirection: "" | "file" | "here" = "", tabs = false;
  // Command position: wrappers seen so far, whether the next word is a wrapper option's value, and
  // how many plain arguments the wrapper takes before its command (timeout's duration).
  let expect = true, wrapper = "", wrapperValue = false, positional = 0, wrapped: string[] = [], wrapperStart = 0;
  let record: SimpleCommand | null = null;
  let depth = 0, arithmetic = 0, invalid = false, continued = false;
  const frames: Frame[] = [];
  const documents: { delimiter: string; stripTabs: boolean; literal: boolean; level: number }[] = [];
  let body = 0; // 1-based: the here-document whose body the next line belongs to

  function commandWord() {
    const name = word.slice(word.lastIndexOf("/") + 1);
    if (wrapperValue) { wrapperValue = false; wrapped.push(word); }
    else if (ASSIGNMENT.test(word)) { /* a leading assignment */ }
    else if (opaque) invalid = true;
    else if (positional && !word.startsWith("-")) { positional--; wrapped.push(word); }
    else if (WRAPPERS.has(name)) {
      wrapper = name; wrapperStart = wrapped.length; positional = name === "timeout" ? 1 : 0;
      wrapped.push(word);
    } else if (wrapper && word.startsWith("-")) {
      wrapped.push(word);
      if (wrapper === "command" && /^-[vV]$/.test(word)) {
        // A lookup, not a run: it is the `command` command itself.
        record = { words: wrapped.slice(wrapperStart), wrappers: wrapped.slice(0, wrapperStart) };
        expect = false; wrapper = "";
      } else if (OPTION_VALUES[wrapper]?.test(word)) wrapperValue = true;
    } else if (!quoted && KEYWORDS.has(word)) wrapper = "";
    else {
      record = { words: [word], wrappers: wrapped };
      wrapped = []; expect = false; wrapper = ""; positional = 0;
    }
  }

  function finishWord() {
    if (!present) return;
    if (redirection) {
      if (redirection === "here") {
        if (opaque) invalid = true;
        documents.push({ delimiter: word, stripTabs: tabs, literal: quoted, level: frames.length });
      }
      redirection = "";
    } else if (expect) commandWord();
    else record?.words.push(word);
    word = ""; present = quoted = opaque = false;
  }

  /** Ends the simple command; wrappers with no command after them (`exec >log`) are one too. */
  function endCommand() {
    finishWord();
    if (!record && wrapped.length) record = { words: wrapped, wrappers: [] };
    if (record) commands.push(record);
    record = null; expect = true; wrapper = ""; wrapperValue = false; positional = 0; wrapped = [];
  }

  function begin(kind: Frame["kind"], here = false) {
    frames.push({ kind, here, word, present, quoted, opaque, quote, expect, redirection, wrapper, wrapperValue, positional, wrapped, wrapperStart, record, depth, arithmetic });
    word = ""; present = quoted = opaque = false; quote = ""; redirection = "";
    expect = true; wrapper = ""; wrapperValue = false; positional = 0; wrapped = []; record = null;
    depth = arithmetic = 0;
  }

  function end() {
    endCommand();
    const f = frames.pop()!;
    ({ quoted, opaque, quote, expect, redirection, wrapper, wrapperValue, positional, wrapped, wrapperStart, record, depth, arithmetic } = f);
    // In here-document text the substitution's result is data, not a word of any command.
    word = f.here ? f.word : `${f.word}$()`;
    present = f.here ? f.present : true;
  }

  for (const line of source.split("\n")) {
    let hereText = false, hereLevel = 0;
    if (body) {
      const doc = documents[body - 1]!;
      if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
        if (++body > documents.length) { body = 0; documents.length = 0; }
        continue;
      }
      if (doc.literal) continue;
      hereText = true; hereLevel = doc.level;
    }
    continued = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!, next = line[i + 1] ?? "";
      if (hereText && frames.length === hereLevel && !arithmetic) {
        // An unquoted here-document's text is data, apart from the substitutions in it.
        if (c === "\\") i++;
        else if (c === "$" && next === "(") {
          if (line[i + 2] === "(") { arithmetic = 2; i += 2; }
          else { begin("(", true); i++; }
        } else if (c === "`") begin("`", true);
        continue;
      }
      if (quote === "'") {
        if (c === "'") quote = ""; else word += c;
        continue;
      }
      if (quote === "ansi") {
        if (c === "'") quote = "";
        else if (c === "\\" && i < line.length - 1) {
          if (next === "'" || next === "\\" || next === '"' || next === "?") word += next;
          else if (next in ANSI) word += ANSI[next];
          // Leave other escapes (\x63, \0, \u...) to the shell; they can't name a command or delimiter here.
          else { opaque = true; word += c + next; }
          i++;
        } else word += c;
        continue;
      }
      if (c === "\\") {
        present = quoted = true;
        if (i === line.length - 1) { continued = true; break; }
        if (quote === '"' && !/[$`"\\]/.test(next)) word += c;
        word += next; i++;
        continue;
      }
      if (c === "$" && next === "(") {
        if (line[i + 2] === "(") { arithmetic += 2; present = true; word += "$ARITH"; i += 2; }
        else { begin("("); i++; }
        continue;
      }
      if (c === "`") {
        if (frames.at(-1)?.kind === "`" && quote === "") end();
        else begin("`");
        continue;
      }
      if (arithmetic) {
        if (c === "(") arithmetic++;
        if (c === ")") arithmetic--;
        continue;
      }
      if (quote === '"') {
        if (c === '"') quote = ""; else word += c;
        continue;
      }
      if (c === "$" && next === "'") { quote = "ansi"; present = quoted = true; i++; continue; }
      if (c === "'" || c === '"') { quote = c; present = quoted = true; continue; }
      if (c === "#" && !present) break;
      if (c === " " || c === "\t" || c === "\r") { finishWord(); continue; }
      if (c === "<" || c === ">") {
        if (next === "(") { begin("("); i++; continue; }
        if (/^[0-9]+$/.test(word)) { word = ""; present = false; }
        finishWord();
        redirection = "file"; tabs = false;
        if (c === "<" && next === "<") {
          i++; redirection = "here";
          if (line[i + 1] === "-") { tabs = true; i++; }
          else if (line[i + 1] === "<") { redirection = "file"; i++; }
        } else if (next === c || next === "&" || next === "|") i++;
        continue;
      }
      if (c === "&" && next === ">") {
        // `&>file` and `&>>file` send both streams to a file; they don't end the command.
        finishWord(); redirection = "file"; tabs = false; i++;
        if (line[i + 1] === ">") i++;
        continue;
      }
      if (c === ")" && frames.at(-1)?.kind === "(" && !depth) { end(); continue; }
      if (";&|()".includes(c)) {
        endCommand();
        if (frames.length && c === "(") depth++;
        if (frames.length && c === ")") depth--;
        continue;
      }
      present = true; word += c;
    }
    if (!continued && !quote) {
      endCommand();
      if (documents.length && !body) body = 1;
    } else if (!continued) word += "\n";
  }
  if (record) commands.push(record);
  if (invalid || quote || frames.length || arithmetic || continued || body || redirection === "here") {
    throw new ShellSyntaxError("incomplete shell quoting, substitution or here-document, or an encoded command word");
  }
  return commands;
}
