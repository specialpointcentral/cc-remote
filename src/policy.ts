import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EDITS, PREFIX } from "./names";
import { SHELL } from "./platform";
import { evaluate, rulesFor, shellHookOutput, type ShellTool, type Verdict, withGrants } from "./rules";
import type { Workspace } from "./tools/util";

/**
 * cc-remote's own PreToolUse hook, added on the stream so it works whichever SDK is on the other end
 * (claude-agent-acp's or an app's such as Orca's): the SDK→claude `initialize` request gets a matcher
 * with our callback id, and the proxy answers claude's `hook_callback` requests for that id itself.
 * The SDK never sees them. On the wire (Agent SDK 0.3):
 *
 *   initialize:    request.hooks.PreToolUse += { matcher, hookCallbackIds: [HOOK_ID] }
 *   claude → us:   { type: "control_request", request_id, request: { subtype: "hook_callback", callback_id, input, tool_use_id } }
 *   us → claude:   { type: "control_response", response: { subtype: "success", request_id, response: <hook output> } }
 *
 * The hook applies the user's shell rules (rules.ts) in the mode claude reports with each call, so
 * they hold in every mode: deny refuses, ask prompts even in bypassPermissions and auto, and allow
 * runs a command without asking, which dontAsk needs. It also refuses subagents in a worktree, and
 * approves local edits in the working directories under acceptEdits and auto mode, as claude
 * approves its own there: in auto mode they would otherwise all go to the classifier. Edits of the
 * host claude's own plan and memory files (host-fs.ts) it approves in every mode, as claude
 * approves its own.
 */
export const HOOK_ID = "cc-remote-policy";

/** The subagent tool, under its current name and its earlier one. */
const AGENTS = ["Agent", "Task"];

type Json = Record<string, any>;

/** claude matches hooks against the names it knows: the local tools keep their prefix there. */
const MATCHER = [PREFIX + SHELL, ...EDITS.map((t) => PREFIX + t), ...AGENTS].join("|");

/** Claude Code's protected paths: writes there are never approved by a mode alone. */
const PROTECTED_DIRS = new Set([".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude"]);
const PROTECTED_FILES = new Set([
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".bash_login", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv",
  ".zlogin", ".zlogout", ".profile", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml",
  ".bunfig.toml", ".bazelrc", ".bazelversion", ".bazeliskrc", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml",
  ".lefthook.yaml", "gradle-wrapper.properties", "maven-wrapper.properties", ".devcontainer.json", ".ripgreprc", "pyrightconfig.json",
  ".mcp.json", ".claude.json",
]);

/** The real path a write would land on: the nearest existing ancestor's, followed by the rest. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/**
 * Whether a local edit is one claude would approve for its own edit tools under acceptEdits or in
 * auto mode: inside a working directory, also once symlinks are followed, and not to a protected path.
 */
export function workspaceEdit(target: string, cwd: string, dirs: string[] = []): boolean {
  if (!target) return false;
  const path = resolve(cwd, target);
  const file = real(path);
  return [cwd, ...dirs].some((dir) => {
    const rel = relative(real(dir), file);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
    if (relative(resolve(dir), path).startsWith("..")) return false;
    const parts = rel.split(sep);
    return !parts.slice(0, -1).some((p, i) => PROTECTED_DIRS.has(p) || (p === ".config" && parts[i + 1] === "git"))
      && !PROTECTED_FILES.has(parts.at(-1)!) && !PROTECTED_DIRS.has(parts.at(-1)!);
  });
}

/** The initialize request with our matcher added to the SDK's own hooks, once. */
export function withPolicyHook(request: Json): Json {
  const pre: Json[] = Array.isArray(request.hooks?.PreToolUse) ? request.hooks.PreToolUse : [];
  if (pre.some((m) => m?.hookCallbackIds?.includes(HOOK_ID))) return request;
  return { ...request, hooks: { ...request.hooks, PreToolUse: [...pre, { matcher: MATCHER, hookCallbackIds: [HOOK_ID] }] } };
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `cc-remote: ${reason}` },
});

const allow = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `cc-remote: ${reason}` },
});

/**
 * The hook's answer. `input` is as the proxy passes it on, so the local shell tool already carries
 * its built-in name; `grants` are the session's own approvals, as allow rules; `ws` the workspace
 * the session's local tools share, with the shell's current directory and the host's files.
 */
export function policyHook(input: Json | undefined, root: string, grants: Iterable<string>, dirs: string[] = [], ws?: Workspace): HookJSONOutput {
  if (input?.hook_event_name !== "PreToolUse") return {};
  const tool = input.tool_name;
  if (EDITS.includes(tool)) {
    const target = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    const own = tool === "NotebookEdit" ? undefined : ws?.host?.selfEdited(target);
    if (own) return allow(`${own === "plan" ? "the session's plan file" : "a memory file"}, on the host, which claude edits without asking`);
    return (input.permission_mode === "acceptEdits" || input.permission_mode === "auto") && workspaceEdit(target, root, dirs)
      ? allow(`an edit in the working directory, which ${input.permission_mode} mode approves`)
      : {};
  }
  if (AGENTS.includes(tool)) {
    // claude would make the worktree in its own folder on the host, while the local tools keep
    // working in this machine's directory: the subagent would be told about files it never sees.
    return input.tool_input?.isolation === "worktree"
      ? deny('subagents can\'t use isolation: "worktree" here, because claude runs on another host and the worktree would be made there, not in the local project. Run the subagent without isolation.')
      : {};
  }
  if (tool !== SHELL) return {};
  try {
    const place = { root, cwd: ws?.cwd, dirs };
    return shellHookOutput(input.tool_input?.command, input.permission_mode, withGrants(rulesFor(root, SHELL as ShellTool), grants), SHELL as ShellTool, place);
  } catch (e) {
    return deny(`could not check this command against your permission rules (${(e as Error).message})`);
  }
}

/** What the rules and the session's grants say about a shell command claude asks to run, with the shell now in `cwd`. */
export const shellVerdict = (command: string, mode: string | undefined, root: string, grants: Iterable<string>, dirs: string[] = [], cwd?: string): Verdict =>
  evaluate(command, mode, withGrants(rulesFor(root, SHELL as ShellTool), grants), SHELL as ShellTool, { root, cwd, dirs });
