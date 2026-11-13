import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { sdkHost } from "../src/control";
import { resetLocalSettings } from "../src/local-settings";
import { HOOK_ID, withPolicyHook } from "../src/policy";
import { proxy, rewriter, type Session } from "../src/proxy";
import { settingsLocations } from "../src/rules";
import { localTools } from "../src/tools";

const base = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-policy-")));
// Claude's settings, git's global config and the home directory are all temporary here.
const ENV = ["CLAUDE_CONFIG_DIR", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
const saved = { env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])), managed: settingsLocations.managed };
Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(base, "config"), HOME: join(base, "home"), GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
delete process.env.XDG_CONFIG_HOME;
settingsLocations.managed = join(base, "managed");
afterAll(() => {
  for (const k of ENV) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  settingsLocations.managed = saved.managed;
  resetLocalSettings();
  rmSync(base, { recursive: true, force: true });
});

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
};

let n = 0;
let project = "";
beforeEach(() => {
  project = join(base, `project-${++n}`);
  mkdirSync(project, { recursive: true });
  put(join(base, "config", "settings.json"), { permissions: { allow: ["Bash(npm test:*)"], ask: ["Bash(git push *)"], deny: ["Bash(rm:*)"] } });
  resetLocalSettings();
});

const session = (mode = "default"): Session => ({ cwd: project, hostDir: `.cc-remote/ws/box${project}`, mode });

/** One rewriter, with what it passes on and what it answers itself. */
function stream(s: Session) {
  const r = rewriter(s);
  const replies: any[] = [];
  const out = (msg: object) => {
    const line = r.outbound(JSON.stringify(msg), (x) => replies.push(JSON.parse(x)));
    return line === null ? null : JSON.parse(line);
  };
  const ask = (command: string, extra: object = {}) =>
    out({ type: "control_request", request_id: `q${replies.length}`, request: { subtype: "can_use_tool", tool_name: "mcp__cc__Bash", input: { command }, tool_use_id: "t", ...extra } });
  const hook = (tool_name: string, tool_input: object, permission_mode = "default", callback_id = HOOK_ID) =>
    out({ type: "control_request", request_id: `h${replies.length}`, request: { subtype: "hook_callback", callback_id, tool_use_id: "t", input: { hook_event_name: "PreToolUse", tool_name, tool_input, permission_mode, session_id: "s", transcript_path: "", cwd: project } } });
  const approve = (updatedPermissions: object[]) =>
    JSON.parse(r.inbound(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "q", response: { behavior: "allow", updatedInput: {}, updatedPermissions } } })));
  return { r, replies, out, ask, hook, approve, last: () => replies.at(-1)?.response };
}

describe("the policy hook on the stream", () => {
  test("initialize gets cc-remote's matcher next to the SDK's own hooks, once", () => {
    const { r } = stream(session());
    const init = { type: "control_request", request_id: "i", request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "Edit", hookCallbackIds: ["hook_0"] }], Stop: [{ hookCallbackIds: ["hook_1"] }] } } };
    const once = JSON.parse(r.inbound(JSON.stringify(init)));
    expect(once.request.hooks.PreToolUse).toEqual([{ matcher: "Edit", hookCallbackIds: ["hook_0"] }, { matcher: "mcp__cc__Bash|mcp__cc__Write|mcp__cc__Edit|mcp__cc__NotebookEdit|Agent|Task", hookCallbackIds: [HOOK_ID] }]);
    expect(once.request.hooks.Stop).toEqual([{ hookCallbackIds: ["hook_1"] }]);
    expect(withPolicyHook(once.request)).toBe(once.request);
    const bare = JSON.parse(r.inbound(JSON.stringify({ type: "control_request", request_id: "j", request: { subtype: "initialize" } })));
    expect(bare.request.hooks).toEqual({ PreToolUse: [{ matcher: "mcp__cc__Bash|mcp__cc__Write|mcp__cc__Edit|mcp__cc__NotebookEdit|Agent|Task", hookCallbackIds: [HOOK_ID] }] });
  });

  test("answers its own callbacks from the rules in claude's mode, and passes the SDK's on", () => {
    const { hook, last, replies } = stream(session());
    const decision = (command: string, mode: string) => {
      expect(hook("mcp__cc__Bash", { command }, mode)).toBeNull();
      return last().response.hookSpecificOutput?.permissionDecision;
    };
    for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"]) {
      expect(decision("rm -rf build", mode)).toBe("deny");
      expect(decision("git push origin main", mode)).toBe(mode === "dontAsk" ? "deny" : "ask");
    }
    expect(decision("npm test", "dontAsk")).toBe("allow");
    expect(decision("npm test", "default")).toBe("allow");
    expect(decision("npm test", "bypassPermissions")).toBeUndefined();
    expect(decision("npm test", "auto")).toBe("allow");
    expect(decision("npm run anything", "auto")).toBeUndefined();
    expect(decision("rm -rf ~", "auto")).toBe("deny");
    expect(decision("make build", "dontAsk")).toBeUndefined();
    expect(last()).toEqual({ subtype: "success", request_id: expect.any(String), response: {} });
    expect(replies.find((x) => x.response.response.hookSpecificOutput?.permissionDecision === "deny").response.response.hookSpecificOutput.permissionDecisionReason)
      .toBe("cc-remote: the permission rule Bash(rm:*) denies this command");
    // Read-only commands run without asking, as Claude Code's own do, but not past an ask rule.
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk"]) expect(decision("ls -la", mode)).toBe("allow");
    expect(decision("ls -la", "auto")).toBeUndefined();
    expect(decision("ls && git push origin main", "default")).toBe("ask");
    const theirs = hook("mcp__cc__Bash", { command: "rm x" }, "default", "hook_0");
    expect(theirs.request.callback_id).toBe("hook_0");
  });

  test("refuses subagents in a worktree", () => {
    const { hook, last } = stream(session());
    hook("Agent", { prompt: "x", isolation: "worktree" });
    expect(last().response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(last().response.hookSpecificOutput.permissionDecisionReason).toContain('isolation: "worktree"');
    hook("Task", { prompt: "x" });
    expect(last().response).toEqual({});
  });

  test("approves edits in the working directories under acceptEdits and auto, but not protected or outside ones", () => {
    const s = { ...session(), dirs: [join(base, "scratch")] };
    const { hook, last } = stream(s);
    const decision = (tool: string, file_path: string, mode: string) => {
      hook(tool, tool === "mcp__cc__NotebookEdit" ? { notebook_path: file_path } : { file_path, content: "" }, mode);
      return last().response.hookSpecificOutput?.permissionDecision;
    };
    for (const mode of ["auto", "acceptEdits"]) {
      expect(decision("mcp__cc__Write", join(project, "src", "a.ts"), mode)).toBe("allow");
      expect(decision("mcp__cc__Edit", "relative.ts", mode)).toBe("allow");
      expect(decision("mcp__cc__NotebookEdit", join(base, "scratch", "n.ipynb"), mode)).toBe("allow");
      for (const path of [join(project, ".git", "config"), join(project, ".claude", "settings.json"), join(project, ".bashrc"), join(project, "sub", ".mcp.json"), join(base, "elsewhere.ts"), "/etc/passwd"]) {
        expect([path, decision("mcp__cc__Write", path, mode)]).toEqual([path, undefined]);
      }
    }
    expect(decision("mcp__cc__Write", join(project, "a.ts"), "default")).toBeUndefined();
    // A link out of the working directory doesn't count as in it.
    mkdirSync(join(base, "outside"), { recursive: true });
    Bun.spawnSync(["ln", "-s", join(base, "outside"), join(project, "link")]);
    expect(decision("mcp__cc__Write", join(project, "link", "x.ts"), "auto")).toBeUndefined();
  });

  test("an acceptEdits request for a protected path goes to the user", () => {
    const { out } = stream(session("acceptEdits"));
    const edit = (file_path: string) => out({ type: "control_request", request_id: "e", request: { subtype: "can_use_tool", tool_name: "mcp__cc__Edit", input: { file_path } } });
    expect(edit(join(project, "a.ts"))).toBeNull();
    expect(edit(join(project, ".git", "hooks", "pre-commit"))).not.toBeNull();
  });

  test("follows claude's mode from its messages and its hook callbacks", () => {
    const s = session();
    const { out, hook } = stream(s);
    out({ type: "system", subtype: "init", permissionMode: "plan", cwd: project });
    expect(s.mode).toBe("plan");
    hook("mcp__cc__Bash", { command: "ls" }, "acceptEdits");
    expect(s.mode).toBe("acceptEdits");
  });
});

describe("shell permission requests", () => {
  test("deny refuses, an allow rule approves where Claude's would, and the rest goes to the user", () => {
    const { ask, last } = stream(session());
    expect(ask("echo ok && rm -rf build")).toBeNull();
    expect(last().response).toEqual({ behavior: "deny", message: "cc-remote: the permission rule Bash(rm:*) denies this command" });
    expect(ask("npm test -- --watch")).toBeNull();
    expect(last().response).toEqual({ behavior: "allow", updatedInput: { command: "npm test -- --watch" } });
    const other = ask("make build");
    expect(other.request.tool_name).toBe("Bash");
    expect(other.request.permission_suggestions).toEqual([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make build:*" }], behavior: "allow", destination: "localSettings" }]);
  });

  test("an ask rule always reaches the user, with no don't-ask-again, whatever was granted", () => {
    const { ask, approve } = stream(session());
    approve([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }]);
    const asked = ask("git push origin main");
    expect(asked.request.permission_suggestions).toBeUndefined();
    expect(asked.request.suppress_always_allow_rule).toBe(true);
    expect(asked.request.requires_user_interaction).toBe(true);
    expect(asked.request.decision_reason).toBe("cc-remote: the permission rule Bash(git push *) asks first");
  });

  test("a broad allow rule doesn't answer in auto mode, nor an ask no stored grant may answer", () => {
    put(join(base, "config", "settings.json"), { permissions: { allow: ["Bash(npm:*)", "Bash(python3:*)"] } });
    expect(stream(session("auto")).ask("python3 x.py")).not.toBeNull();
    expect(stream(session("auto")).ask("npm install")).toBeNull();
    expect(stream(session()).ask("npm test", { requires_user_interaction: true })).not.toBeNull();
  });

  test("allow for this session stays in memory, for this session only", () => {
    const s = session();
    const { ask, approve } = stream(s);
    const reply = approve([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make build:*" }], behavior: "allow", destination: "session" }]);
    expect(reply.response.response.updatedPermissions).toEqual([]);
    expect(ask("make build -j8")).toBeNull();
    expect(ask("make build; rm x")).toBeNull(); // denied by the rule, not approved
    expect(ask("make test")).not.toBeNull();
    expect(stream(session()).ask("make build")).not.toBeNull();
    expect(() => readFileSync(join(project, ".claude", "settings.local.json"))).toThrow();
  });

  test("always allow goes to the local settings, where every later session finds it", () => {
    const { approve } = stream(session());
    approve([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make build:*" }, { toolName: "WebFetch", ruleContent: "domain:x" }], behavior: "allow", destination: "localSettings" }]);
    expect(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"))).toEqual({ permissions: { allow: ["Bash(make build:*)"] } });
    expect(stream(session()).ask("make build")).toBeNull();
  });

  test("whole-tool rules for local tools get their prefix back", () => {
    const { approve } = stream(session());
    const reply = approve([{ type: "addRules", rules: [{ toolName: "Bash" }, { toolName: "Edit" }], behavior: "allow", destination: "session" }]);
    expect(reply.response.response.updatedPermissions[0].rules).toEqual([{ toolName: "mcp__cc__Bash" }, { toolName: "mcp__cc__Edit" }]);
  });
});

/** A stand-in for the ssh child: what is written to its stdin, and a stdout to write claude's lines to. */
function fakeClaude() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, exitCode: null, signalCode: null, kill: () => true });
  const received: any[] = [];
  child.stdin.on("data", (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => received.push(JSON.parse(l))));
  return { child: child as unknown as ChildProcess, received, say: (m: object) => child.stdout.write(`${JSON.stringify(m)}\n`) };
}

describe("composed with the SDK host of claude-compatible mode", () => {
  test("initialize carries both cc-remote's servers and its hook, and the hook's callbacks never reach the SDK", async () => {
    const { child, received, say } = fakeClaude();
    const s = session();
    const sdk = proxy(child, s, (toClaude) => sdkHost({ cc: localTools(project) }, "ENV", toClaude));
    const toSdk: any[] = [];
    sdk.stdout.on("data", (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => toSdk.push(JSON.parse(l))));
    sdk.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: "Write", hookCallbackIds: ["hook_0"] }] } } })}\n`);
    await Bun.sleep(20);
    const init = received.find((m) => m.request?.subtype === "initialize").request;
    expect(init.sdkMcpServers).toEqual(["cc"]);
    expect(init.hooks.PreToolUse).toEqual([{ matcher: "Write|mcp__cc__Write", hookCallbackIds: ["hook_0"] }, { matcher: "mcp__cc__Bash|mcp__cc__Write|mcp__cc__Edit|mcp__cc__NotebookEdit|Agent|Task", hookCallbackIds: [HOOK_ID] }]);

    say({ type: "control_request", request_id: "h1", request: { subtype: "hook_callback", callback_id: HOOK_ID, input: { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "rm -rf /" }, permission_mode: "bypassPermissions" } } });
    say({ type: "control_request", request_id: "h2", request: { subtype: "hook_callback", callback_id: "hook_0", input: { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Write", tool_input: {} } } });
    await Bun.sleep(20);
    expect(received.find((m) => m.response?.request_id === "h1").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(toSdk.map((m) => m.request_id)).toEqual(["h2"]);
    expect(toSdk[0].request.input.tool_name).toBe("Write");
    expect(s.mode).toBe("bypassPermissions");
    sdk.stdin.end();
  });
});
