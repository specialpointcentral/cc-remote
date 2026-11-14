import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { criticalRemoval } from "./critical";
import { ShellSyntaxError, simpleCommands, type SimpleCommand } from "./lexer";
import { ignoreGlobally, localSettingsDir, localSettingsFiles, tracked } from "./local-settings";
import { type Place, readOnly } from "./readonly";
import { home } from "./tools/util";

/**
 * The user's Claude Code permission rules for the local shell tool. claude matches `Bash(...)` rules
 * only against its own built-in Bash, and reads them on the host, so neither the project's rules
 * nor the user's on this machine would reach our Bash. These are read here, from the managed, user,
 * project and local settings Claude Code itself would read on this machine; the host's are not
 * merged. Ported from remote-harness's route-command.py.
 */

/** The local shell tool, whose name is also its rules' name: `Bash(...)`, or `PowerShell(...)` on Windows. */
export type ShellTool = "Bash" | "PowerShell";
/** `invalid` names the settings files that are there but can't be used, and why: their rules are unknown. */
export type Rules = { allow: string[]; ask: string[]; deny: string[]; invalid?: string[] };
export type Decision = "deny" | "ask" | "allow" | "none";
export type Verdict = { decision: Decision; rule?: string; reason?: string };

/** Modes in which an allow rule approves a call outright. Auto mode does too, for narrow rules only (see broad). */
const ALLOW_MODES = ["default", "acceptEdits", "dontAsk"];

/**
 * Modes in which a read-only command (readonly.ts) runs without asking, as Claude Code runs its own
 * "in every mode". Auto mode leaves it to the classifier, which Claude Code may also consult there.
 */
const READ_ONLY_MODES = ["default", "acceptEdits", "plan", "dontAsk"];

/** Where an administrator puts managed-settings.json. A field, so tests can point it elsewhere. */
export const settingsLocations = {
  managed: process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode"
    : "/etc/claude-code",
};

const userSettings = () => join(Bun.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");

/**
 * Claude Code's managed settings files (the file, then its drop-ins in name order), then the user
 * and project ones and the local ones (the starting directory's and the repository root's, see
 * local-settings.ts). MDM and server-managed settings are not files here, and not read.
 */
export function settingsPaths(root: string): { managed: string[]; others: string[] } {
  const dir = settingsLocations.managed;
  const managed = [join(dir, "managed-settings.json")];
  try {
    const dropIns = join(dir, "managed-settings.d");
    managed.push(...readdirSync(dropIns).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort().map((n) => join(dropIns, n)));
  } catch {}
  return { managed, others: [userSettings(), join(root, ".claude", "settings.json"), ...localSettingsFiles(root)] };
}

/** Whether a settings entry is a rule for this tool. Deny and ask rules may also name it with a glob (`*`). */
function forTool(entry: string, tool: ShellTool, behavior: keyof Rules): boolean {
  if (entry === tool || (entry.startsWith(`${tool}(`) && entry.endsWith(")"))) return true;
  return behavior !== "allow" && !entry.includes("(") && entry.includes("*") && wildcard(entry, "").test(tool);
}

type Settings = { permissions?: Record<string, unknown>; allowManagedPermissionRulesOnly?: unknown };

/** A settings file's content; nothing for a missing or empty one; why it can't be used otherwise. */
function readSettings(path: string): { settings?: Settings; problem?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? {} : { problem: `${path} can't be read (${code ?? (e as Error).message})` };
  }
  if (!text.trim()) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    return { problem: `${path} is not valid JSON (${(e as Error).message})` };
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { problem: `${path} is not a JSON object` };
  return { settings: settings as Settings };
}

/** What's wrong with the settings files that count for a session root: one line per file that can't be used. */
export function settingsProblems(root: string): string[] {
  const { managed, others } = settingsPaths(root);
  return [...managed, ...others].flatMap((path) => readSettings(path).problem ?? []);
}

/**
 * The tool's rules in these files, per behavior. A file that is there but can't be read or parsed
 * goes in `invalid`: claude skips such a file, but its deny rules would then be lost without a word.
 */
export function loadRules(managed: string[], others: string[], tool: ShellTool): Rules {
  const rules: Rules = { allow: [], ask: [], deny: [] };
  let managedOnly = false;
  for (const path of [...managed, ...others]) {
    const { settings, problem } = readSettings(path);
    if (problem) (rules.invalid ??= []).push(problem);
    if (!settings) continue;
    const isManaged = managed.includes(path);
    if (isManaged && settings.allowManagedPermissionRulesOnly === true) managedOnly = true;
    const permissions = settings.permissions;
    if (!permissions || typeof permissions !== "object") continue;
    for (const behavior of ["allow", "ask", "deny"] as const) {
      // Under managed-only rules Claude ignores the others; keeping their deny rules is stricter.
      if (managedOnly && !isManaged && behavior !== "deny") continue;
      const entries = permissions[behavior];
      if (!Array.isArray(entries)) continue;
      rules[behavior].push(...entries.filter((e): e is string => typeof e === "string" && forTool(e, tool, behavior)));
    }
  }
  return rules;
}

const cache = new Map<string, { identity: string; rules: Rules }>();

/** The files' identities: a changed, added or removed file changes it, and stat needs no read. */
function identity(paths: string[]): string {
  return JSON.stringify(paths.map((path) => {
    try {
      const s = statSync(path, { bigint: true });
      return [path, String(s.ino), String(s.size), String(s.mtimeNs)];
    } catch {
      return [path];
    }
  }));
}

/** The rules in effect for a session root, read again only when one of the files changes. */
export function rulesFor(root: string, tool: ShellTool): Rules {
  const { managed, others } = settingsPaths(root);
  const key = `${tool}\0${root}`;
  const id = identity([...managed, ...others]);
  const hit = cache.get(key);
  if (hit?.identity === id) return hit.rules;
  const rules = loadRules(managed, others, tool);
  cache.set(key, { identity: id, rules });
  return rules;
}

/** Splits on blanks and quotes; a backslash is literal. Undefined for an unclosed quote. */
function splitQuoted(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "", inWord = false, quote = "";
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = ""; else word += c;
    } else if (c === "'" || c === '"') { quote = c; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) words.push(word); word = ""; inWord = false; }
    else { word += c; inWord = true; }
  }
  if (quote) return undefined;
  if (inWord) words.push(word);
  return words;
}

/** Python's shlex.split, which Claude's rule contents follow: POSIX quotes and backslashes. */
function shlexSplit(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "", inWord = false, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = ""; else word += c; continue; }
    if (c === "\\" && quote !== "'") {
      if (i === text.length - 1) return undefined;
      const next = text[++i]!;
      // In double quotes only \\ and \" are escapes.
      word += quote === '"' && next !== "\\" && next !== '"' ? c + next : next;
      inWord = true;
      continue;
    }
    if (quote === '"') { if (c === '"') quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) words.push(word); word = ""; inWord = false; }
    else { word += c; inWord = true; }
  }
  if (quote) return undefined;
  if (inWord) words.push(word);
  return words;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A text with `*` wildcards, then `tail`, as an anchored regular expression. */
const wildcard = (text: string, tail: string, flags = "s") =>
  new RegExp(`^(?:${text.split("*").map(escapeRegex).join(".*")}${tail})$`, flags);

/**
 * A rule as a regular expression over a command's words joined by single spaces. `npm test:*` and
 * `npm test *` match `npm test` and `npm test ...`, not `npm testing`; a trailing ` *` matches the
 * bare command only when it is the rule's one wildcard. PowerShell rules ignore case.
 */
export function rulePattern(rule: string, tool: ShellTool): RegExp {
  const open = rule.indexOf("(");
  const content = open >= 0 && rule.endsWith(")") ? rule.slice(open + 1, -1) : "*";
  const split = tool === "PowerShell" ? splitQuoted(content) : shlexSplit(content);
  const text = (split ?? content.split(/\s+/).filter(Boolean)).join(" ");
  const flags = tool === "PowerShell" ? "si" : "s";
  if (text === "" || text === "*") return /^[\s\S]*$/;
  if (!text.endsWith(":*") && !text.endsWith(" *")) return wildcard(text, "", flags);
  const head = text.slice(0, -2).trimEnd();
  if (!head) return /^[\s\S]*$/;
  return wildcard(head, head.includes("*") ? " .*" : "(?: .*)?", flags);
}

/** The forms of a simple command a rule may match: as written, by basename, and with its wrappers. */
function forms(command: SimpleCommand, basenames: boolean): string[][] {
  const { words, wrappers } = command;
  const out = [words];
  const name = words[0]?.split(/[\\/]/).pop();
  if (basenames && name !== undefined && name !== words[0]) out.push([name, ...words.slice(1)]);
  if (wrappers.length) out.push([...wrappers, ...words]);
  return out;
}

/** The first rule that matches any of these simple commands. */
export function matchingRule(rules: string[], commands: SimpleCommand[], tool: ShellTool, basenames: boolean): string | undefined {
  for (const rule of rules) {
    const pattern = rulePattern(rule, tool);
    if (commands.some((c) => forms(c, basenames).some((words) => pattern.test(words.join(" "))))) return rule;
  }
  return undefined;
}

/**
 * The words of a command that is one plain simple command, else undefined: only letters, digits,
 * blanks, quotes and `-_./:=,@%+` (and `\` in PowerShell, where it's a path separator, not an
 * escape). No operator, redirection, expansion, glob or comment can hide in such a command.
 */
export function plainWords(command: string, tool: ShellTool = "Bash"): string[] | undefined {
  const plain = tool === "PowerShell" ? /^[\p{L}\p{N} \-_./:=,@%+'"\\]*$/u : /^[\p{L}\p{N} \-_./:=,@%+'"]*$/u;
  if (!plain.test(command)) return undefined;
  const words = splitQuoted(command);
  return words?.length ? words : undefined;
}

/**
 * The simple commands a deny or ask rule is checked against. PowerShell isn't parsed: only a plain
 * command is understood there, and anything else is left to the user.
 */
function commandsIn(command: string, tool: ShellTool): SimpleCommand[] | undefined {
  if (tool === "PowerShell") {
    const words = plainWords(command, tool);
    return words && [{ words, wrappers: [] }];
  }
  try {
    return simpleCommands(command);
  } catch (e) {
    if (e instanceof ShellSyntaxError) return undefined;
    throw e;
  }
}

/**
 * What the user's rules say about a command in this permission mode. Deny, then ask, rules match
 * any simple command in it (wrappers such as sudo and env skipped, a path's basename too); dontAsk
 * mode refuses what an ask rule covers. Then, given where the command runs (the session's root, or
 * a Place that also says where the shell is now), removing a critical path asks, or is refused in
 * auto and dontAsk mode (critical.ts). Allow rules match only a plain single command, in modes where
 * Claude would let them approve outright; in auto mode only narrow ones. A read-only Bash command
 * (readonly.ts) is approved in the modes where Claude Code runs its own without asking. While a
 * settings file can't be used, nothing is approved, and everything not refused is asked about. A Bash
 * command the lexer can't split is denied when deny rules exist, since none can be ruled out; a
 * PowerShell command that isn't plain is asked about instead.
 */
export function evaluate(command: string, mode: string | undefined, rules: Rules, tool: ShellTool = "Bash", where?: string | Place): Verdict {
  const place = typeof where === "string" ? { root: where } : where;
  if (rules.deny.length || rules.ask.length) {
    const commands = commandsIn(command, tool);
    if (!commands) {
      if (tool === "Bash" && rules.deny.length) {
        return { decision: "deny", reason: "cc-remote could not split this command into simple commands to check it against your deny rules" };
      }
      return asks(mode, { reason: `cc-remote checks your ${tool} rules only against commands it can split` });
    }
    const deny = matchingRule(rules.deny, commands, tool, true);
    if (deny) return { decision: "deny", rule: deny, reason: `the permission rule ${deny} denies this command` };
    const ask = matchingRule(rules.ask, commands, tool, true);
    if (ask) return asks(mode, { rule: ask, reason: `the permission rule ${ask} asks first` });
  }
  const target = tool === "Bash" && place ? criticalRemoval(command, place.root, place.cwd) : undefined;
  if (target !== undefined) {
    // As Claude Code does outside its terminal: asks where it can, else refuses; no rule approves it.
    const reason = `${JSON.stringify(target)} is a critical path (the filesystem root, a top-level directory, the home directory, or the working directory or one of its parents)`;
    return mode === "auto" || mode === "dontAsk"
      ? { decision: "deny", reason: `${reason}, and ${mode} mode doesn't ask before removing one. Remove the specific files instead, or ask the user to run the command` }
      : { decision: "ask", reason: `${reason}, so removing it needs the user's approval` };
  }
  if (rules.invalid?.length) {
    // The broken file may hold deny rules, so nothing runs on the strength of the rest alone.
    const files = rules.invalid.join("; ");
    return asks(mode, { reason: `${files}, so cc-remote can't apply your permission rules; until that's fixed, each ${tool} command needs the user's approval` });
  }
  if (mode && (ALLOW_MODES.includes(mode) || mode === "auto") && rules.allow.length) {
    const words = plainWords(command, tool);
    // Auto mode keeps only narrow rules; the classifier judges what the broad ones would approve.
    const allowed = mode === "auto" ? rules.allow.filter((r) => !broad(r, tool)) : rules.allow;
    const allow = words && matchingRule(allowed, [{ words, wrappers: [] }], tool, false);
    if (allow) return { decision: "allow", rule: allow, reason: `allowed by the permission rule ${allow}` };
  }
  if (mode && READ_ONLY_MODES.includes(mode) && tool === "Bash" && place && readOnly(command, place)) {
    return { decision: "allow", reason: "a read-only command, which Claude Code runs without asking" };
  }
  return { decision: "none" };
}

/** An ask, or in dontAsk mode, where nobody is asked, a refusal, as Claude Code refuses there. */
const asks = (mode: string | undefined, v: Omit<Verdict, "decision">): Verdict =>
  mode === "dontAsk" ? { ...v, decision: "deny", reason: `${v.reason}, and dontAsk mode doesn't ask` } : { ...v, decision: "ask" };

/** Commands that run whatever their arguments say: interpreters, shells, and wrappers that run another command. */
const RUNNERS = /^(python[\d.]*|pypy[\d.]*|node(js)?|deno|bun|bunx|npx|pnpx|uvx|ruby|perl|php|lua(jit)?|julia|r|rscript|java|osascript|(ba|z|da|k|mk|fi|c|tc|a)?sh|pwsh|powershell|cmd|env|sudo|doas|su|eval|exec|xargs|nohup|time|timeout|nice|command|builtin|watch|ssh|docker|podman|kubectl|make|just|task|gradle|gradlew|mvn|mvnw)$/i;

/** Package managers' "run a script or a package" subcommands. */
const RUN = /^(npm|pnpm|yarn|bun|uv|poetry|pipx|pdm|hatch|cargo|go|dotnet|deno|mix|swift) (run|exec|x|dlx|tool)$/i;

/**
 * Whether an allow rule is one of those Claude Code suspends in auto mode because it grants
 * arbitrary code execution: the whole tool, a wildcard in the command word, an interpreter or
 * wrapper with any arguments, or a package manager's run command with any script. Approximated on
 * the safe side: what isn't plainly narrow goes to the classifier.
 */
export function broad(rule: string, tool: ShellTool): boolean {
  const open = rule.indexOf("(");
  if (open < 0 || !rule.endsWith(")")) return true;
  const words = (tool === "PowerShell" ? splitQuoted : shlexSplit)(rule.slice(open + 1, -1).trim().replace(/:\*$/, " *")) ?? ["*"];
  const wild = words.at(-1) === "*";
  if (wild) words.pop();
  if (!words.length || words.some((w) => w.includes("*"))) return true;
  const name = words[0]!.split(/[\\/]/).pop()!;
  if (RUNNERS.test(name)) return wild;
  return RUN.test(`${name} ${words[1] ?? ""}`) && wild && words.length === 2;
}

export const decide = (command: string, mode: string | undefined, rules: Rules, tool: ShellTool = "Bash"): Decision =>
  evaluate(command, mode, rules, tool).decision;

/**
 * Why a command must not run, if a deny rule says so. The shell tool checks this before every
 * command: in bypassPermissions mode claude runs tools without asking, so nothing else would.
 */
export function refusal(command: string, root: string, tool: ShellTool): string | undefined {
  const verdict = evaluate(command, undefined, rulesFor(root, tool), tool);
  return verdict.decision === "deny" ? `Permission to use ${tool} with this command has been denied: ${verdict.reason}. It was not run.` : undefined;
}

/** Rules plus the session's own grants, which count as allow rules (`Bash(npm test:*)`). */
export const withGrants = (rules: Rules, grants: Iterable<string>): Rules => {
  const extra = [...grants];
  return extra.length ? { ...rules, allow: [...rules.allow, ...extra] } : rules;
};

/** What a PreToolUse hook answers for a local shell command: the rules' decision in the hook's mode, or nothing. */
export function shellHookOutput(command: unknown, mode: string | undefined, rules: Rules, tool: ShellTool, where?: string | Place): HookJSONOutput {
  if (typeof command !== "string") return {};
  const verdict = evaluate(command, mode, rules, tool, where);
  if (verdict.decision === "none") return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: `cc-remote: ${verdict.reason}` } };
}

/**
 * A PreToolUse hook that applies the rules to the local shell tool, for the SDK's `hooks` option.
 * The hook runs in this process, in every mode: deny blocks, ask makes claude prompt even where it
 * wouldn't (bypassPermissions, auto), and allow approves where Claude's own allow rule would, which
 * dontAsk mode needs because there claude refuses an unapproved MCP tool without asking. The proxy
 * answers the same hook on the stream itself (policy.ts), so this form is for an SDK in this process.
 */
export function rulesHook(root: string, tool: ShellTool, toolName: string): HookCallbackMatcher {
  return {
    matcher: toolName,
    hooks: [async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      return shellHookOutput((input.tool_input as { command?: unknown } | undefined)?.command, input.permission_mode, rulesFor(root, tool), tool, root);
    }],
  };
}

/** Where an "always allow" goes: Claude Code's permission update destinations that name a file. */
export type Destination = "localSettings" | "projectSettings" | "userSettings";

/** The file is tracked by git, so a rule saved there would reach everyone who clones the repository. */
export class TrackedSettingsError extends Error {}

/**
 * Keeps an "always allow" rule, such as `Bash(npm test:*)`, where Claude Code keeps its own: by
 * default the local settings file at the repository root (local-settings.ts). As Claude Code 2.1.323
 * does, a local file git tracks is left alone (TrackedSettingsError), so the grant lasts only for the
 * session; a new local file in a repository is added to the global git excludes first. The rest of
 * the file stays as it was; a file that isn't a JSON object is left alone and this throws. The new
 * file replaces the old in one rename, so a reader never sees half of it.
 */
export function persistAllowRule(root: string, ruleContent: string, tool: ShellTool, destination: Destination = "localSettings"): string {
  const rule = `${tool}(${ruleContent})`;
  const path = destination === "userSettings" ? userSettings()
    : join(destination === "projectSettings" ? root : localSettingsDir(root), ".claude", destination === "projectSettings" ? "settings.json" : "settings.local.json");
  let file = path;
  let text: string | undefined;
  try {
    file = realpathSync(file); // A symlinked settings file stays a symlink.
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const settings = text === undefined || !text.trim() ? {} : JSON.parse(text);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${file} is not a JSON object`);
  const permissions = settings.permissions ?? (settings.permissions = {});
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error(`${file}: permissions is not an object`);
  const allow = permissions.allow ?? (permissions.allow = []);
  if (!Array.isArray(allow)) throw new Error(`${file}: permissions.allow is not a list`);
  if (allow.includes(rule)) return rule;
  if (destination === "localSettings") {
    // Both about the path in the project, which may be a link into a dotfiles repository.
    if (text !== undefined && tracked(path)) throw new TrackedSettingsError(`${path} is tracked by git`);
    try {
      ignoreGlobally(path);
    } catch (e) {
      console.error(`cc-remote: could not add ${path} to the global git excludes: ${(e as Error).message}`);
    }
  }
  allow.push(rule);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o644;
  try { mode = statSync(file).mode & 0o777; } catch {}
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    renameSync(temporary, file);
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
  return rule;
}
