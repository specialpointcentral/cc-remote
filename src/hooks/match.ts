import { isAbsolute, relative, resolve, sep } from "node:path";
import { NAMES_ONLY } from "../names";
import { ruleMatches, type ShellTool } from "../rules";
import { home } from "../tools/util";

type Json = Record<string, any>;

/**
 * Whether a matcher takes a value, as Claude Code reads matchers: none, `""` or `*` takes all; one
 * of only names is an exact list split on `|` or `,`; anything else an unanchored regular
 * expression, and one that doesn't compile takes nothing.
 *
 * claude has already matched the widened matcher (names.ts) against its own name for the tool;
 * this checks the user's own matcher against the built-in name, which a regular expression such as
 * `^mcp__` must not match for the local tools.
 */
export function matcherMatches(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === "*") return true;
  if (NAMES_ONLY.test(matcher)) return matcher.split(/[|,]/).map((n) => n.trim()).includes(value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

/** Tools that rules for another tool also cover: Edit rules apply to every file edit, Read rules to every read. */
const COVERS: Record<string, string[]> = { Edit: ["Edit", "Write", "NotebookEdit"], Read: ["Read", "Glob", "Grep"], Agent: ["Agent", "Task"], Task: ["Agent", "Task"] };

/** Whether a rule's tool name, such as `Bash`, `Edit` or `mcp__server__*`, names this tool. */
function namesTool(name: string, tool: string): boolean {
  if (name === tool || COVERS[name]?.includes(tool)) return true;
  if (name.startsWith("mcp__")) {
    const prefix = name.endsWith("__*") ? name.slice(0, -1) : name.split("__").length === 2 ? `${name}__` : undefined;
    return prefix !== undefined && tool.startsWith(prefix);
  }
  return false;
}

/**
 * A gitignore-style path rule, as Claude Code writes Read and Edit rules: `//abs`, `~/home`, `/`
 * from the project root, otherwise from the current directory; with no slash but a trailing one,
 * any file of that name at any depth.
 */
function pathMatches(rule: string, target: string, root: string, cwd: string): boolean {
  let pattern = rule;
  let base: string;
  let anywhere = false;
  if (pattern.startsWith("//")) [base, pattern] = ["/", pattern.slice(2)];
  else if (pattern === "~" || pattern.startsWith("~/")) [base, pattern] = [home, pattern.slice(2)];
  else if (pattern.startsWith("/")) [base, pattern] = [root, pattern.slice(1)];
  else {
    [base, pattern] = [cwd, pattern.replace(/^\.\//, "")];
    anywhere = !rule.startsWith("./") && !pattern.replace(/\/$/, "").includes("/");
  }
  if (pattern.endsWith("/")) pattern += "**";
  const file = resolve(cwd, target);
  if (anywhere) return new Bun.Glob(`**/${pattern}`).match(file.split(sep).join("/"));
  const rel = relative(base, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return new Bun.Glob(pattern).match(rel.split(sep).join("/"));
}

/** A domain rule (`domain:example.com`, `*.example.com`) against a URL's host. */
function domainMatches(rule: string, url: unknown): boolean {
  let host: string;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true; // Nothing to rule out.
  }
  const want = rule.slice("domain:".length).toLowerCase();
  return want.startsWith("*.") ? host.endsWith(want.slice(1)) : host === want;
}

/**
 * Whether a handler's `if`, in permission rule syntax (`Bash(git *)`, `Edit(*.ts)`), takes this
 * tool call. claude never sees the condition: our callbacks are registered without it, so it is
 * checked here. A condition this can't evaluate (an unknown tool's content, a command that can't
 * be split) lets the hook run, the stricter reading for a hook that may be a guard.
 */
export function condition(rule: string, input: Json, place: { root: string; cwd: string }): boolean {
  const m = /^([^(]+?)(?:\(([\s\S]*)\))?$/.exec(rule.trim());
  if (!m) return true;
  const [, name, content] = m as unknown as [string, string, string | undefined];
  const tool = String(input.tool_name ?? "");
  if (!namesTool(name, tool)) return false;
  if (content === undefined || content === "" || content === "*") return true;
  const args = input.tool_input ?? {};
  if (tool === "Bash" || tool === "PowerShell") {
    return typeof args.command !== "string" || (ruleMatches(`${tool}(${content})`, args.command, tool as ShellTool) ?? true);
  }
  if (COVERS.Edit!.includes(tool) || COVERS.Read!.includes(tool)) {
    const target = args.file_path ?? args.notebook_path ?? args.path;
    return pathMatches(content, typeof target === "string" ? target : place.cwd, place.root, place.cwd);
  }
  if (tool === "WebFetch" && content.startsWith("domain:")) return domainMatches(content, args.url);
  if (COVERS.Agent!.includes(tool)) return args.subagent_type === undefined || args.subagent_type === content;
  return true;
}
