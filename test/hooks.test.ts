import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadHooks, stillConfigured, SUPPORTED, UNSUPPORTED } from "../src/hooks/config";
import { condition, matcherMatches } from "../src/hooks/match";
import { asyncContext, hookOutput, parseOutput } from "../src/hooks/result";
import { runCommand, runHttp, urlAllowed } from "../src/hooks/run";
import { resetLocalSettings } from "../src/local-settings";
import { widenHooks, widenMatcher } from "../src/names";
import { isolate } from "./fixture";

let iso: ReturnType<typeof isolate>;
beforeAll(() => { iso = isolate(); });
afterAll(() => iso.restore());

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};
const user = () => join(iso.home, ".claude", "settings.json");
const managed = () => join(iso.home, "managed", "managed-settings.json");

let n = 0;
let project = "";
beforeEach(() => {
  project = realpathSync(iso.home);
  project = join(project, `project-${++n}`);
  mkdirSync(project, { recursive: true });
  rmSync(join(iso.home, "managed"), { recursive: true, force: true });
  for (const f of [user(), managed()]) put(f, {});
  resetLocalSettings();
});

const cmd = (command: string, extra: object = {}) => ({ type: "command", command, ...extra });
const hooksOf = (event: string, matcher: string | undefined, ...handlers: object[]) => ({ hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: handlers }] } });
const commands = (root: string, args: string[] = []) => loadHooks(root, args).local.map((h) => `${h.source}:${h.event}:${h.handler.command}`);

describe("which hooks run", () => {
  test("from managed, user, project and local settings and the command line, the same handler once", () => {
    put(managed(), hooksOf("Stop", undefined, cmd("m")));
    put(user(), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd("u"), cmd("same")] }] } });
    put(join(project, ".claude", "settings.json"), hooksOf("PreToolUse", "Bash", { command: "same", type: "command" }));
    put(join(project, ".claude", "settings.local.json"), hooksOf("UserPromptSubmit", undefined, cmd("l")));
    const flag = ["--settings", JSON.stringify(hooksOf("SessionStart", "startup", cmd("f")))];
    expect(commands(project, flag).sort()).toEqual(["flag:SessionStart:f", "local:UserPromptSubmit:l", "managed:Stop:m", "project:PreToolUse:same", "user:PreToolUse:u"]);
    // Claude Code without --setting-sources reads them all; the SDK's list narrows them; --bare reads none.
    expect(commands(project, ["--setting-sources=project"]).sort()).toEqual(["managed:Stop:m", "project:PreToolUse:same"]);
    expect(commands(project, ["--setting-sources", "user,local", ...flag]).sort()).toEqual(["flag:SessionStart:f", "local:UserPromptSubmit:l", "managed:Stop:m", "user:PreToolUse:same", "user:PreToolUse:u"]);
    expect(commands(project, ["--setting-sources="])).toEqual(["managed:Stop:m"]);
    expect(commands(project, ["--bare", "--setting-sources=user"])).toEqual(["managed:Stop:m"]);
  });

  test("disableAllHooks follows settings precedence and leaves the managed hooks, unless managed settings set it", () => {
    put(managed(), hooksOf("Stop", undefined, cmd("m")));
    put(user(), { disableAllHooks: true, ...hooksOf("Stop", undefined, cmd("u")) });
    expect(commands(project)).toEqual(["managed:Stop:m"]);
    put(join(project, ".claude", "settings.local.json"), { disableAllHooks: false });
    expect(commands(project).sort()).toEqual(["managed:Stop:m", "user:Stop:u"]);
    // Orca's chat title: --settings {"disableAllHooks":true} outranks the local file.
    expect(commands(project, ["--settings", '{"disableAllHooks":true}'])).toEqual(["managed:Stop:m"]);
    put(managed(), { disableAllHooks: true, ...hooksOf("Stop", undefined, cmd("m")) });
    expect(commands(project)).toEqual([]);
    // A drop-in comes after the managed file, and wins.
    put(join(iso.home, "managed", "managed-settings.d", "10-on.json"), { disableAllHooks: false });
    expect(commands(project).sort()).toEqual(["managed:Stop:m", "user:Stop:u"]);
  });

  test("managed allowManagedHooksOnly and a hooks lock leave only the managed hooks, the command line's included", () => {
    put(user(), hooksOf("Stop", undefined, cmd("u")));
    const flag = ["--settings", JSON.stringify(hooksOf("Stop", undefined, cmd("f")))];
    put(managed(), { allowManagedHooksOnly: true, ...hooksOf("Stop", undefined, cmd("m")) });
    expect(commands(project, flag)).toEqual(["managed:Stop:m"]);
    put(managed(), { strictPluginOnlyCustomization: ["skills", "hooks"] });
    expect(commands(project, flag)).toEqual([]);
    put(managed(), { strictPluginOnlyCustomization: ["skills"] });
    expect(commands(project, flag).sort()).toEqual(["flag:Stop:f", "user:Stop:u"]);
    // Only managed settings may set it.
    put(user(), { allowManagedHooksOnly: true, ...hooksOf("Stop", undefined, cmd("u")) });
    put(managed(), {});
    expect(commands(project)).toEqual(["user:Stop:u"]);
  });

  test("prompt and MCP tool hooks go to the host, widened; agent hooks, unknown types and unsupported events run nowhere", () => {
    put(user(), {
      hooks: {
        PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "prompt", prompt: "ok? $ARGUMENTS" }, { type: "mcp_tool", server: "s", tool: "t" }, cmd("c")] }],
        Stop: [{ hooks: [{ type: "agent", prompt: "verify" }, { type: "prompt", prompt: "done?" }] }],
        CwdChanged: [{ hooks: [cmd("direnv")] }],
        Bogus: [{ hooks: [cmd("x")] }],
        Notification: [{ hooks: [{ type: "smoke-signal" }, cmd("n", { if: "Bash(git *)" })] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: "http://127.0.0.1:1/h" }] }],
      },
    });
    const config = loadHooks(project, []);
    expect(config.host).toEqual({
      PreToolUse: [{ matcher: "Edit|Write|mcp__cc__Write|mcp__cc__Edit", hooks: [{ type: "prompt", prompt: "ok? $ARGUMENTS" }, { type: "mcp_tool", server: "s", tool: "t" }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "done?" }] }],
    });
    expect(config.local.map((h) => [h.event, h.matcher, h.handler.type])).toEqual([["PreToolUse", "Edit|Write", "command"], ["PostToolUse", "Bash", "http"]]);
    expect(config.left).toEqual([
      "an agent hook on Stop (its subagent would work on the server's files)",
      `CwdChanged (${UNSUPPORTED.CwdChanged})`,
      "Bogus (not a hook event this cc-remote knows)",
      "a smoke-signal hook on Notification (not a hook type this cc-remote knows)",
    ]);
    expect(SUPPORTED).toContain("PreToolUse");
    expect(SUPPORTED).not.toContain("WorktreeCreate");
  });

  test("a broken settings file's hooks don't run, the others' do; the http allowlists merge", () => {
    put(user(), "{ not json");
    put(join(project, ".claude", "settings.json"), { allowedHttpHookUrls: ["http://a/*"], httpHookAllowedEnvVars: ["A"], ...hooksOf("Stop", undefined, cmd("p")) });
    put(join(project, ".claude", "settings.local.json"), { allowedHttpHookUrls: ["http://b/*"] });
    const config = loadHooks(project, []);
    expect(config.local.map((h) => h.handler.command)).toEqual(["p"]);
    expect(config.http).toEqual({ urls: ["http://b/*", "http://a/*"], envVars: ["A"] });
  });

  test("a hook removed or disabled after the start stops running", () => {
    put(user(), hooksOf("Stop", undefined, cmd("u")));
    const [hook] = loadHooks(project, []).local;
    expect(stillConfigured(project, [], hook!.key)).toBe(true);
    put(user(), { ...hooksOf("Stop", undefined, cmd("u")), disableAllHooks: true, padding: "changes the size" });
    expect(stillConfigured(project, [], hook!.key)).toBe(false);
  });
});

describe("matchers", () => {
  test("widened for the local tools: lists, comma lists and regular expressions, on tool events only", () => {
    expect(widenMatcher("Edit|Write")).toBe("Edit|Write|mcp__cc__Write|mcp__cc__Edit");
    expect(widenMatcher("Edit, Bash")).toBe("Edit|Bash|mcp__cc__Edit|mcp__cc__Bash");
    expect(widenMatcher("^Notebook")).toBe("(?:^Notebook)|^mcp__cc__(?:NotebookEdit)$");
    // Unanchored, it already matches the prefixed names.
    expect(widenMatcher("Note.*")).toBe("Note.*");
    expect(widenMatcher("mcp__memory__.*")).toBe("mcp__memory__.*");
    // Widening twice, as the proxy and then the SDK host do under Orca, changes nothing more.
    for (const m of ["Edit|Write", "^Notebook", "^(Read|Bash)$"]) expect(widenMatcher(widenMatcher(m))).toBe(widenMatcher(m)!);
    expect(widenMatcher("(")).toBe("(");
    expect(widenHooks({ PreToolUse: [{ matcher: "Read" }], Notification: [{ matcher: "Read" }] })).toEqual({ PreToolUse: [{ matcher: "Read|mcp__cc__Read" }], Notification: [{ matcher: "Read" }] });
  });

  test("checked again against the built-in name, as Claude Code reads them", () => {
    expect(matcherMatches(undefined, "Bash")).toBe(true);
    expect(matcherMatches("*", "Bash")).toBe(true);
    expect(matcherMatches("Edit|Write", "Write")).toBe(true);
    expect(matcherMatches("Edit,Write", "NotebookEdit")).toBe(false);
    expect(matcherMatches("^mcp__", "Read")).toBe(false);
    expect(matcherMatches("^mcp__", "mcp__github__issue")).toBe(true);
    expect(matcherMatches("Note.*", "NotebookEdit")).toBe(true);
    expect(matcherMatches("(", "Bash")).toBe(false);
  });

  test("a handler's if condition, in permission rule syntax", () => {
    const at = { root: "/p", cwd: "/p/sub" };
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    expect(condition("Bash(git *)", bash("git status"), at)).toBe(true);
    expect(condition("Bash(git *)", bash("ls && sudo git push"), at)).toBe(true);
    expect(condition("Bash(git *)", bash("ls -la"), at)).toBe(false);
    expect(condition("Bash(git *)", bash("echo 'unclosed"), at)).toBe(true);
    expect(condition("Bash", bash("anything"), at)).toBe(true);
    expect(condition("Edit", bash("x"), at)).toBe(false);
    const write = (file_path: string, tool_name = "Write") => ({ tool_name, tool_input: { file_path } });
    expect(condition("Edit(*.ts)", write("/p/sub/deep/a.ts"), at)).toBe(true);
    expect(condition("Edit(*.ts)", write("/p/a.js"), at)).toBe(false);
    expect(condition("Edit(/src/**)", write("/p/src/x/y.ts"), at)).toBe(true);
    expect(condition("Edit(/src/**)", write("/p/sub/src/y.ts"), at)).toBe(false);
    expect(condition("Edit(./lib/*)", write("lib/a.ts"), at)).toBe(true);
    expect(condition("Edit(//etc/**)", write("/etc/hosts"), at)).toBe(true);
    expect(condition("Read(.env)", write("/p/x/.env", "Grep"), at)).toBe(true);
    expect(condition("Read(.env)", write("/p/x/.env", "Edit"), at)).toBe(false);
    expect(condition("WebFetch(domain:example.com)", { tool_name: "WebFetch", tool_input: { url: "https://example.com/a" } }, at)).toBe(true);
    expect(condition("WebFetch(domain:example.com)", { tool_name: "WebFetch", tool_input: { url: "https://evil.com/a" } }, at)).toBe(false);
    expect(condition("mcp__github", { tool_name: "mcp__github__create_issue" }, at)).toBe(true);
    expect(condition("mcp__github__*", { tool_name: "mcp__gitlab__x" }, at)).toBe(false);
    expect(condition("Agent(Explore)", { tool_name: "Agent", tool_input: { subagent_type: "Plan" } }, at)).toBe(false);
    // What can't be evaluated lets the hook run.
    expect(condition("Skill(deploy)", { tool_name: "Skill", tool_input: {} }, at)).toBe(true);
  });
});

describe("the hook contract", () => {
  const exit = (code: number, stdout = "", stderr = "") => ({ kind: "exit" as const, code, stdout, stderr });

  test("stdout is JSON only as one object alone", () => {
    expect(parseOutput('  {"continue": false}\n', "Stop")).toEqual({ json: { continue: false } });
    expect(parseOutput("welcome\n{}", "Stop")).toEqual({ text: "welcome\n{}" });
    expect(parseOutput('["a"]', "Stop")).toEqual({ text: '["a"]' });
    expect(parseOutput('{"a":1}\n{"b":2}', "Stop")).toEqual({ text: '{"a":1}\n{"b":2}' });
    expect(parseOutput('{"a":1}\n{"decision":"block"}', "Stop")).toEqual({ invalid: "print the JSON output object alone on stdout" });
    expect(parseOutput("{nope}", "Stop")).toEqual({ invalid: "stdout looks like JSON but doesn't parse" });
    expect(parseOutput('{"continue":"no"}', "Stop")).toEqual({ invalid: "continue has the wrong type" });
    expect(parseOutput('{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}', "Stop")).toEqual({ invalid: 'hookSpecificOutput.hookEventName must be "Stop"' });
    expect(parseOutput('{"decision":"block","reason":"r","extra":1}', "Stop")).toEqual({ json: { decision: "block", reason: "r" } });
  });

  test("exit 0: JSON is the output, plain text is context where Claude Code adds it", () => {
    expect(hookOutput("PreToolUse", exit(0, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}')))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
    for (const event of ["UserPromptSubmit", "UserPromptExpansion", "SessionStart", "PostModelSwitch"]) {
      expect(hookOutput(event, exit(0, "remember x\n"))).toEqual({ hookSpecificOutput: { hookEventName: event, additionalContext: "remember x" } } as never);
    }
    expect(hookOutput("PreCompact", exit(0, "keep the API notes"))).toEqual({ systemMessage: "keep the API notes" });
    expect(hookOutput("PostToolUse", exit(0, "just a log line"))).toEqual({});
    expect(hookOutput("Stop", exit(0, ""))).toEqual({});
    expect(hookOutput("Stop", exit(0, "{bad"))).toEqual({});
    expect(hookOutput("Stop", exit(0, "{bad}"))).toEqual({ systemMessage: "Stop hook error: invalid output: stdout looks like JSON but doesn't parse" });
  });

  test("exit 2 blocks in each event's way, with stderr as the reason, and JSON can't lift it", () => {
    expect(hookOutput("PreToolUse", exit(2, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"systemMessage":"s"}', "no rm\n")))
      .toEqual({ systemMessage: "s", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no rm" } });
    for (const event of ["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "TaskCreated", "TaskCompleted", "PreModelSwitch"]) {
      expect(hookOutput(event, exit(2, "", "why"))).toEqual({ decision: "block", reason: "why" });
    }
    expect(hookOutput("PreCompact", exit(2, "", "not now"))).toEqual({ decision: "block", reason: "not now", systemMessage: "not now" });
    expect(hookOutput("Elicitation", exit(2, "", "no"))).toEqual({ reason: "no", hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } } as never);
    for (const event of ["SessionStart", "SubagentStart", "PostCompact"]) expect(hookOutput(event, exit(2, "", "shown"))).toEqual({ systemMessage: "shown" });
    for (const event of ["Notification", "PermissionRequest", "PermissionDenied", "StopFailure", "Setup"]) expect(hookOutput(event, exit(2, "", "ignored"))).toEqual({});
    expect(hookOutput("Stop", exit(2, "", ""))).toEqual({ decision: "block", reason: "Blocked by hook" });
  });

  test("other exits: valid JSON decides, otherwise a notice for the user; onFailure block turns failures into blocks", () => {
    expect(hookOutput("Stop", exit(1, '{"decision":"block","reason":"r"}'))).toEqual({ decision: "block", reason: "r" });
    expect(hookOutput("PreToolUse", exit(1, "", "boom\nmore"))).toEqual({ systemMessage: "PreToolUse hook error: boom" });
    expect(hookOutput("PreToolUse", exit(3))).toEqual({ systemMessage: "PreToolUse hook error: exit code 3" });
    expect(hookOutput("PreCompact", exit(1, "", "x"))).toEqual({});
    expect(hookOutput("PreToolUse", { kind: "timeout" })).toEqual({ systemMessage: "PreToolUse hook error: timed out" });
    expect(hookOutput("PreToolUse", { kind: "failed", message: "could not start: x" })).toEqual({ systemMessage: "PreToolUse hook error: could not start: x" });
    expect(hookOutput("PreModelSwitch", { kind: "timeout" })).toEqual({ decision: "block", reason: "the hook did not answer in time" });
    const blocked = hookOutput("PreToolUse", exit(1, '{"decision":"approve"}'), "block") as any;
    expect(blocked.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(blocked.hookSpecificOutput.permissionDecisionReason).toBe('PreToolUse hook failed: exit code 1; blocking because onFailure is "block"');
    expect((hookOutput("UserPromptSubmit", { kind: "timeout" }, "block") as any).decision).toBe("block");
    expect(hookOutput("Stop", { kind: "timeout" }, "block")).toEqual({ systemMessage: "Stop hook error: timed out" });
    expect(hookOutput("Stop", { kind: "cancelled" })).toEqual({});
  });

  test("what async hooks leave for Claude", () => {
    expect(asyncContext(exit(0, 'starting\n{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"tests pass"}}\n'), false)).toEqual(["tests pass"]);
    expect(asyncContext(exit(0, '{\n  "systemMessage": "done"\n}\n'), false)).toEqual(["done"]);
    expect(asyncContext(exit(2, "", "build broke"), true)).toEqual(["build broke"]);
    expect(asyncContext(exit(2, "out only", ""), true)).toEqual(["out only"]);
    expect(asyncContext(exit(1, "", "x"), false)).toEqual([]);
  });
});

describe("running a command hook", () => {
  const env = () => ({ ...process.env, CLAUDE_PROJECT_DIR: project });

  test("gets the input on stdin, runs in the given folder with the project folder in its environment, and in the login environment", async () => {
    put(join(iso.home, ".bash_profile"), "export FROM_PROFILE=yes\n");
    const sub = join(project, "sub");
    mkdirSync(sub);
    const outcome = await runCommand(cmd('read -r line; printf "%s|%s|%s|%s" "$line" "$PWD" "$CLAUDE_PROJECT_DIR" "$FROM_PROFILE"; echo err >&2; exit 3'), '{"a":1}', { cwd: sub, env: env(), timeoutMs: 20_000 });
    expect(outcome).toEqual({ kind: "exit", code: 3, stdout: `{"a":1}|${sub}|${project}|yes`, stderr: "err\n" });
  }, 30_000);

  test("exec form runs the executable without a shell, with the project folder put in", async () => {
    const outcome = await runCommand(cmd("printf", { args: ["%s;%s", "${CLAUDE_PROJECT_DIR}/x", "$HOME *"] }), "", { cwd: project, env: env(), timeoutMs: 20_000 });
    expect(outcome).toEqual({ kind: "exit", code: 0, stdout: `${project}/x;$HOME *`, stderr: "" });
  }, 30_000);

  test("is stopped at its timeout, with everything it started", async () => {
    const pidFile = join(project, "pid");
    const started = Date.now();
    const outcome = await runCommand(cmd(`sleep 30 & echo $! > ${pidFile}; wait`), "", { cwd: project, env: env(), timeoutMs: 1_500 });
    expect(outcome).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  test("a cancelled run stops and says so", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    expect(await runCommand(cmd("sleep 30"), "", { cwd: project, env: env(), timeoutMs: 20_000, signal: abort.signal })).toEqual({ kind: "cancelled" });
  }, 30_000);
});

describe("an http hook", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { path: string; body: string; auth: string | null }[] = [];
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, body: await req.text(), auth: req.headers.get("authorization") });
        if (path === "/json") return Response.json({ decision: "block", reason: "from http" });
        if (path === "/empty") return new Response("");
        if (path === "/text") return new Response("hello");
        return new Response("no", { status: 500 });
      },
    });
  });
  afterAll(() => server.stop(true));
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const o = { cwd: "/", env: { HOOK_TOKEN: "t0k", OTHER: "secret" }, timeoutMs: 5_000 };

  test("posts the input and reads the answer as a command's exit 0, with only allowed variables in the headers", async () => {
    const h = { type: "http", url: url("/json"), headers: { Authorization: "Bearer $HOOK_TOKEN ${OTHER}" }, allowedEnvVars: ["HOOK_TOKEN"] };
    expect(await runHttp(h, '{"x":1}', o)).toEqual({ kind: "exit", code: 0, stdout: '{"decision":"block","reason":"from http"}', stderr: "" });
    // Header values lose their trailing blanks on the way.
    expect(seen.at(-1)).toEqual({ path: "/json", body: '{"x":1}', auth: "Bearer t0k" });
    expect(await runHttp({ ...h, url: url("/empty") }, "{}", { ...o, envVars: ["OTHER"] })).toEqual({ kind: "exit", code: 0, stdout: "", stderr: "" });
    expect(seen.at(-1)!.auth).toBe("Bearer");
    expect(await runHttp({ type: "http", url: url("/text") }, "{}", o)).toEqual({ kind: "failed", message: "the answer is not JSON: hello" });
    expect(await runHttp({ type: "http", url: url("/500") }, "{}", o)).toEqual({ kind: "failed", message: "the server answered 500" });
  });

  test("isn't sent to a URL allowedHttpHookUrls doesn't take", async () => {
    const before = seen.length;
    expect(await runHttp({ type: "http", url: url("/json") }, "{}", { ...o, urls: ["https://hooks.example.com/*"] })).toEqual({ kind: "skipped", reason: `${url("/json")} is not in allowedHttpHookUrls` });
    expect(seen.length).toBe(before);
    expect(urlAllowed("http://127.0.0.1:*", url("/x"))).toBe(true);
    expect(urlAllowed("https://hooks.example.com/*", "https://HOOKS.example.com./a")).toBe(true);
  });
});

test("the fixture's HOME is the only one written to", () => {
  expect(existsSync(join(iso.home, ".claude"))).toBe(true);
});
