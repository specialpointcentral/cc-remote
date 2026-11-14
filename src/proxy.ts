import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { loadGrants, saveGrants } from "./grants";
import type { LocalHooks } from "./hooks";
import { EDITS, LOCAL, PREFIX, strip } from "./names";
import { SHELL } from "./platform";
import { HOOK_ID, policyHook, shellVerdict, withPolicyHook, workspaceEdit } from "./policy";
import { type Destination, persistAllowRule, type ShellTool, TrackedSettingsError, type Verdict } from "./rules";
import { mirrorKey, projectKey, projectsDir, writeMirror } from "./sessions";
import type { Workspace } from "./tools/util";

/** What one claude process needs to have its messages read as if it ran in `cwd` on this machine. */
export type Session = {
  /** The local working directory. */
  cwd: string;
  /** The folder claude runs in on the host, relative to the host's home. */
  hostDir: string;
  /** claude's permission mode, followed through the SDK's requests. */
  mode: string;
  /** Additional local directories that count as the workspace, as `--add-dir` ones do for claude. */
  dirs?: string[];
  /** The workspace the session's local tools share: where the shell is now, and the host's own files. */
  ws?: Workspace;
  /** The session's id, once known: from the command line, else from claude's init message. */
  sessionId?: string;
  /** The hooks of this machine's settings that run here (hooks/). */
  hooks?: LocalHooks;
};

/**
 * More handling on the same stream, for when the SDK on the other end doesn't know about cc-remote:
 * each returns the line to pass on, or null when it was taken care of here.
 */
export type Layer = {
  /** A line from the SDK, after the rewriter. */
  inbound(line: string): string | null;
  /** A line from claude, after the rewriter. */
  outbound(line: string): string | null;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

/** Chaining, pipes, substitution and redirection can hide a second command behind an approved one. */
const COMPOUND = /[;&|`<>\n]|\$\(/;

/** The prefix claude would suggest approving: the command, plus its subcommand when it has one. */
export function commandPrefix(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (COMPOUND.test(command) || !/^[\w.@/-]+$/.test(words[0] ?? "")) return undefined;
  return words[1] && /^[a-z][\w-]*$/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
}

/** Permission update destinations that name a settings file, which persistAllowRule can write. */
const FILES: string[] = ["localSettings", "projectSettings", "userSettings"] satisfies Destination[];

/**
 * Rewrites the stream between the SDK and the remote claude, both ways:
 *
 * - claude → SDK: the local tools lose their `mcp__cc__` prefix, so ACP renders them as the
 *   built-ins; the host folder becomes the local cwd; transcript mirror frames are written to the
 *   local projects folder, where a local claude keeps the transcript, in the order they come, so
 *   a hook that reads the transcript finds everything claude mirrored before calling it.
 * - SDK → claude: permission rules the user approves for a local tool get the prefix back, and
 *   `initialize` gets cc-remote's own PreToolUse hook (policy.ts) and the hooks of this machine's
 *   settings (hooks/), whose callbacks are answered here.
 *
 * It also answers claude's permission requests that claude would answer itself for its built-ins:
 * local edits under acceptEdits, and shell commands that the user's rules or this session's grants
 * decide. claude matches `Bash(...)` rules only on its own shell tools, so cc-remote keeps them:
 * "always allow" goes to the local settings file, as Claude Code's own does, and "allow for this
 * session" stays with the session (grants.ts), also when another claude process takes it up.
 */
export function rewriter(s: Session) {
  const hostPath = new RegExp(`(?:/[^"\\\\/\\s]+)*/${escape(jsonText(s.hostDir))}(?=["/\\\\\\s]|$)`, "g");
  const local = jsonText(s.cwd);
  const transcripts = join(projectsDir(), projectKey(s.cwd));
  /** This session's shell grants, as allow rules: `Bash(npm test:*)`. */
  const grants = new Set<string>(s.sessionId ? loadGrants(s.sessionId, s.cwd) : []);
  /** Takes up the session's saved grants, when claude names a session other than the one known. */
  const session = (id: unknown) => {
    if (typeof id !== "string" || !id || id === s.sessionId) return;
    s.sessionId = id;
    for (const g of loadGrants(id, s.cwd)) grants.add(g);
  };

  /** An "always allow" for the shell goes to a settings file; a session grant, or a failed write, stays here. */
  function grant(ruleContent: string, destination: string) {
    if (FILES.includes(destination)) {
      try {
        persistAllowRule(s.cwd, ruleContent, SHELL as ShellTool, destination as Destination);
        return;
      } catch (e) {
        if (e instanceof TrackedSettingsError) console.error(`cc-remote: ${e.message}, so ${SHELL}(${ruleContent}) is allowed for this session only`);
        else console.error(`cc-remote: could not save ${SHELL}(${ruleContent}), so it is allowed for this session only: ${(e as Error).message}`);
      }
    }
    grants.add(`${SHELL}(${ruleContent})`);
    if (s.sessionId) saveGrants(s.sessionId, s.cwd, grants);
  }

  /** Returns the line for the SDK, or null when it was answered here; `reply` writes to claude. */
  function outbound(line: string, reply: (line: string) => void): string | null {
    let text = strip(line);
    if (text.includes("/.cc-remote/ws/")) text = text.replace(hostPath, local);
    if (text.includes('"transcript_mirror"')) {
      const m = JSON.parse(text);
      if (m.type === "transcript_mirror" && typeof m.filePath === "string") {
        const rest = m.filePath.match(/\/projects\/[^/]+\/(.+)$/)?.[1];
        const key = rest ? mirrorKey(join(transcripts, rest)) : undefined;
        try {
          if (key && Array.isArray(m.entries)) writeMirror(key, m.entries);
        } catch (e) {
          console.error(`cc-remote: could not write the local transcript: ${(e as Error).message}`);
        }
        return null;
      }
    }
    if (text.includes('"permissionMode"')) {
      // claude's init and status messages say which mode it is in, whoever changed it, and the
      // init which session it is.
      const m = JSON.parse(text);
      if (m.type === "system" && typeof m.permissionMode === "string") s.mode = m.permissionMode;
      if (m.type === "system" && m.subtype === "init") session(m.session_id);
    }
    const answer = (request_id: string, response: unknown) => {
      reply(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response } }));
      return null;
    };
    if (text.includes('"hook_callback"')) {
      const m = JSON.parse(text);
      if (m.type === "control_request" && m.request?.subtype === "hook_callback" && (m.request.callback_id === HOOK_ID || s.hooks?.owns(m.request.callback_id))) {
        const input = m.request.input;
        if (typeof input?.permission_mode === "string") s.mode = input.permission_mode;
        if (m.request.callback_id === HOOK_ID) return answer(m.request_id, policyHook(input, s.cwd, grants, s.dirs, s.ws));
        s.hooks!.answer(m.request_id, m.request.callback_id, input, (output) => answer(m.request_id, output));
        return null;
      }
    }
    if (s.hooks && text.includes('"control_cancel_request"')) {
      // The SDK never saw the request: the cancellation is ours too.
      const m = JSON.parse(text);
      if (m.type === "control_cancel_request" && s.hooks.cancel(m.request_id)) return null;
    }
    if (text.includes('"can_use_tool"')) {
      const m = JSON.parse(text);
      const req = m.request;
      if (m.type !== "control_request" || req?.subtype !== "can_use_tool") return text;
      // Asks that no stored grant may answer, such as a classifier's escalation, go to the user.
      const allow = () => (req.requires_user_interaction ? text : answer(m.request_id, { behavior: "allow", updatedInput: req.input }));
      if (EDITS.includes(req.tool_name)) {
        const target = String(req.input?.file_path ?? req.input?.notebook_path ?? "");
        // The host claude's own plan or memory file, which it edits without asking in any mode.
        if (req.tool_name !== "NotebookEdit" && s.ws?.host?.selfEdited(target)) return allow();
        const local = workspaceEdit(target, s.cwd, s.dirs);
        if (local && s.mode === "acceptEdits") return allow();
        // As claude offers for its own edits: accept the rest of this session's edits.
        req.permission_suggestions = local ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }] : undefined;
        return JSON.stringify(m);
      }
      if (req.tool_name === SHELL) {
        const command = String(req.input?.command ?? "");
        let verdict: Verdict;
        try {
          verdict = shellVerdict(command, s.mode, s.cwd, grants, s.dirs, s.ws?.cwd);
        } catch (e) {
          console.error(`cc-remote: could not check a command against the permission rules: ${(e as Error).message}`);
          verdict = { decision: "ask" };
        }
        if (verdict.decision === "deny") return answer(m.request_id, { behavior: "deny", message: `cc-remote: ${verdict.reason}` });
        if (verdict.decision === "allow") return allow();
        if (verdict.decision === "ask") {
          // The user's ask rule (or a critical path) forced this prompt, and outranks any allow rule:
          // no "don't ask again", and a person answers it. An app that approves everything itself in
          // its own full-access mode, as Orca does, still asks the user for a request marked so.
          req.permission_suggestions = undefined;
          req.suppress_always_allow_rule = true;
          req.requires_user_interaction = true;
          if (verdict.reason) req.decision_reason ??= `cc-remote: ${verdict.reason}`;
          return JSON.stringify(m);
        }
        // claude suggests approving the whole tool, as for any MCP tool. Offer the command instead.
        const prefix = commandPrefix(command);
        req.permission_suggestions = prefix
          ? [{ type: "addRules", rules: [{ toolName: SHELL, ruleContent: `${prefix}:*` }], behavior: "allow", destination: "localSettings" }]
          : undefined;
        return JSON.stringify(m);
      }
    }
    return text;
  }

  function inbound(line: string): string {
    if (line.includes('"initialize"')) {
      const m = JSON.parse(line);
      if (m.type === "control_request" && m.request?.subtype === "initialize") {
        return JSON.stringify({ ...m, request: withPolicyHook(s.hooks ? s.hooks.register(m.request) : m.request) });
      }
    }
    if (line.includes('"set_permission_mode"')) {
      const m = JSON.parse(line);
      if (m.request?.subtype === "set_permission_mode") s.mode = m.request.mode;
    }
    if (!line.includes('"updatedPermissions"')) return line;
    const m = JSON.parse(line);
    const updates = m.response?.response?.updatedPermissions;
    if (!Array.isArray(updates)) return line;
    for (const u of updates) {
      if (u.type === "setMode" && u.destination === "session") s.mode = u.mode;
      if (!Array.isArray(u.rules)) continue;
      u.rules = u.rules.filter((r: { toolName: string; ruleContent?: string }) => {
        if (r.toolName === SHELL && r.ruleContent && u.behavior === "allow" && u.type !== "removeRules") {
          grant(r.ruleContent, u.destination);
          return false;
        }
        if (LOCAL.includes(r.toolName)) r.toolName = PREFIX + r.toolName;
        return true;
      });
    }
    m.response.response.updatedPermissions = updates.filter((u) => !Array.isArray(u.rules) || u.rules.length);
    return JSON.stringify(m);
  }

  return { outbound, inbound };
}

function lines(input: Readable, onLine: (line: string) => void, onEnd: () => void) {
  createInterface({ input, crlfDelay: Infinity }).on("line", onLine).on("close", onEnd);
}

/**
 * Wraps the ssh process so the SDK reads and writes through the rewriter, and through `layer`
 * when given one; the layer gets the function that writes to claude.
 */
export function proxy(child: ChildProcess, s: Session, layer?: (toClaude: (line: string) => void) => Layer): SpawnedProcess {
  const { outbound, inbound } = rewriter(s);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const toClaude = (line: string) => { if (child.stdin!.writable) child.stdin!.write(`${line}\n`); };
  const extra = layer?.(toClaude);
  // claude going away shows up as the exit event; a write racing it must not crash us.
  child.stdin!.on("error", () => {});
  lines(stdin, (line) => {
    const out = extra ? extra.inbound(inbound(line)) : inbound(line);
    if (out !== null) toClaude(out);
  }, () => child.stdin!.end());
  lines(child.stdout!, (line) => {
    let out = outbound(line, toClaude);
    if (out !== null && extra) out = extra.outbound(out);
    if (out !== null) stdout.write(`${out}\n`);
  }, () => stdout.end());

  return {
    stdin,
    stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal) => child.kill(signal),
    on: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.on(event, listener); },
    once: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.once(event, listener); },
    off: (event: "exit" | "error", listener: (...args: any[]) => void) => { child.off(event, listener); },
  } as SpawnedProcess;
}
