import { SHELL } from "./platform";

/** The file tools, under the names Claude Code uses for its own versions. */
const FILES = ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"];

/** Both shells' built-in names. Only the local one is ours; the other would act on the host. */
const SHELLS = ["Bash", "PowerShell"];

/** Tools we run locally. */
export const LOCAL = [...FILES, SHELL];

/** Local tools that only read; Claude Code never asks before its own versions of these. */
export const READS = ["Read", "Glob", "Grep"];

/** Local tools that acceptEdits approves, as it does Claude Code's own. */
export const EDITS = ["Write", "Edit", "NotebookEdit"];

/**
 * Built-in tools that would act on the host instead of this machine. LSP needs local language
 * servers, Monitor streams events claude can't receive from an MCP tool, the worktree tools move
 * claude's own working directory, and both shells would run on the host.
 */
export const REMOVED = [...FILES, ...SHELLS, "LSP", "Monitor", "EnterWorktree", "ExitWorktree"];

/** claude puts every MCP tool behind `mcp__<server>__`. It only exists between claude and the SDK. */
export const PREFIX = "mcp__cc__";

const PREFIXED = new RegExp(`"${PREFIX}(${LOCAL.join("|")})"`, "g");

/** Rewrites a serialized message so the local tools carry the names of the built-ins they replace. */
export const strip = (json: string) => json.replace(PREFIXED, '"$1"');

/** Hook events whose matcher is a tool name. */
export const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];

/** Claude Code reads a matcher of only these characters as names, split on `|` or `,`; any other as a regular expression. */
export const NAMES_ONLY = /^[A-Za-z0-9_\- ,|]+$/;

/**
 * A hook matcher written for the built-in names also matches our tools. claude matches hooks
 * against the prefixed name, which the SDK's toolAliases don't cover. A list (`Edit|Write`) gets
 * the prefixed names added; a regular expression (`^Notebook`) gets an alternative for each local
 * tool it matches by its built-in name, so it still matches nothing else. A matcher that already
 * takes the prefixed names stays as it is, so widening twice changes nothing.
 */
export function widenMatcher(matcher: string | undefined): string | undefined {
  if (!matcher || matcher === "*") return matcher;
  if (NAMES_ONLY.test(matcher)) {
    const names = matcher.split(/[|,]/).map((n) => n.trim()).filter(Boolean);
    const named = LOCAL.filter((t) => names.includes(t) && !names.includes(PREFIX + t));
    return named.length ? [...names, ...named.map((t) => PREFIX + t)].join("|") : matcher;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(matcher);
  } catch {
    return matcher; // claude matches nothing with it either.
  }
  const named = LOCAL.filter((t) => pattern.test(t) && !pattern.test(PREFIX + t));
  return named.length ? `(?:${matcher})|^${PREFIX}(?:${named.join("|")})$` : matcher;
}

/** The tool events' matchers of a hooks map, as the SDK options and its initialize request both lay them out. */
export function widenHooks<T extends { matcher?: string }>(hooks: Record<string, T[]> | undefined): Record<string, T[]> | undefined {
  if (!hooks) return hooks;
  return Object.fromEntries(Object.entries(hooks).map(([event, matchers]) =>
    [event, TOOL_EVENTS.includes(event) ? matchers.map((m) => ({ ...m, matcher: widenMatcher(m.matcher) })) : matchers]));
}
