import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionHooks } from "../src/hooks";
import { resetLocalSettings } from "../src/local-settings";
import { HOOK_ID } from "../src/policy";
import { rewriter, type Session } from "../src/proxy";
import { projectKey, projectsDir } from "../src/sessions";
import { hostDir, spawner } from "../src/ssh";
import { bash } from "../src/tools/bash";
import { type Workspace, workspace } from "../src/tools/util";
import { versionCache } from "../src/version";
import { fakeHost } from "./fakehost";
import { call, isolate } from "./fixture";

/**
 * The hooks of this machine's settings, end to end on the stream: registered in claude's
 * initialize, answered when claude calls them back, never seen by the SDK. claude here is the fake
 * host's, which echoes its stdin, so a callback request written as the SDK comes back as claude's.
 */

let iso: ReturnType<typeof isolate>;
const savedCache = { ...versionCache };
beforeAll(() => {
  iso = isolate();
  versionCache.dir = join(iso.home, ".cache", "cc-remote");
});
afterAll(() => {
  Object.assign(versionCache, savedCache);
  iso.restore();
});

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};
const user = () => join(iso.home, ".claude", "settings.json");

let n = 0;
let project = "";
beforeEach(() => {
  project = join(realpathSync(iso.home), `project-${++n}`);
  mkdirSync(project, { recursive: true });
  put(user(), {});
  resetLocalSettings();
});

const cmd = (command: string, extra: object = {}) => ({ type: "command", command, ...extra });
const ARGS = ["--input-format", "stream-json", "--setting-sources=user,project,local"];

/** The sessions' workspaces: cc-remote removes a SessionStart hook's env file as it exits; the test runner doesn't. */
const workspaces: Workspace[] = [];
afterEach(() => {
  for (const ws of workspaces.splice(0)) if (ws.envFile) rmSync(dirname(ws.envFile), { recursive: true, force: true });
});

/** A rewriter for a session in `project` with its hooks, what it answers claude, and claude's side of the stream. */
function stream(args = ARGS) {
  const ws = workspace(project);
  workspaces.push(ws);
  const s: Session = { cwd: project, hostDir: `.cc-remote/ws/box${project}`, mode: "default", ws, hooks: sessionHooks(project, args, ws) };
  const r = rewriter(s);
  const replies: any[] = [];
  let wake = () => {};
  const reply = (line: string) => { replies.push(JSON.parse(line)); wake(); };
  const out = (msg: object) => {
    const line = r.outbound(JSON.stringify(msg), reply);
    return line === null ? null : JSON.parse(line);
  };
  const init = (hooks: object = {}) => JSON.parse(r.inbound(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize", hooks } }))).request;
  const hostCwd = `/home/someone/.cc-remote/ws/box${project}`;
  const hostTranscript = `/home/someone/.claude/projects/-home-someone--cc-remote-ws-box${project.replace(/[^a-zA-Z0-9]/g, "-")}/s1.jsonl`;
  let next = 0;
  /** claude calling one of the callbacks back; returns the request id. */
  const callback = (callback_id: string, input: object) => {
    const request_id = `h${++next}`;
    const passed = out({ type: "control_request", request_id, request: { subtype: "hook_callback", callback_id, tool_use_id: "t", input: { session_id: "s1", transcript_path: hostTranscript, cwd: hostCwd, permission_mode: "default", ...input } } });
    expect(passed).toBeNull();
    return request_id;
  };
  const answer = async (request_id: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = replies.find((m) => m.response?.request_id === request_id);
      if (found) return found.response.response;
      if (Date.now() > deadline) return undefined;
      await Promise.race([new Promise<void>((r) => { wake = r; }), Bun.sleep(50)]);
    }
  };
  return { s, ws, out, init, callback, answer, replies, hostCwd };
}

const idsFor = (init: any, event: string) => (init.hooks[event] ?? []).flatMap((m: any) => m.hookCallbackIds);
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(25);
  return check();
};

describe("hooks of this machine's settings on the stream", () => {
  test("initialize gets one callback per hook, with the matcher widened and room in the timeout, beside the SDK's hooks and the policy's", () => {
    put(user(), {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [cmd("a"), cmd("b", { timeout: 5 })] }],
        UserPromptSubmit: [{ hooks: [cmd("c")] }],
        SessionStart: [{ matcher: "startup|resume", hooks: [cmd("d")] }],
      },
    });
    const { init } = stream();
    const request = init({ PreToolUse: [{ matcher: "Edit", hookCallbackIds: ["hook_0"] }] });
    expect(request.hooks.PreToolUse).toEqual([
      { matcher: "Edit", hookCallbackIds: ["hook_0"] },
      { matcher: "Bash|mcp__cc__Bash", hookCallbackIds: ["cc-remote-hook-0"], timeout: 630 },
      { matcher: "Bash|mcp__cc__Bash", hookCallbackIds: ["cc-remote-hook-1"], timeout: 35 },
      { matcher: "mcp__cc__Bash|mcp__cc__Write|mcp__cc__Edit|mcp__cc__NotebookEdit|Agent|Task|Monitor", hookCallbackIds: [HOOK_ID] },
    ]);
    // The carrier brings what SessionStart hooks print, when claude doesn't call them back itself.
    expect(request.hooks.UserPromptSubmit).toEqual([{ hookCallbackIds: ["cc-remote-hook-2"], timeout: 60 }, { hookCallbackIds: ["cc-remote-hooks-carrier"], timeout: 630 }]);
    expect(request.hooks.SessionStart).toEqual([{ matcher: "startup|resume", hookCallbackIds: ["cc-remote-hook-3"], timeout: 630 }]);
  });

  test("a PreToolUse hook runs here, on this machine's paths, and its exit 2 denies the call", async () => {
    put(user(), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd('cat > "$CLAUDE_PROJECT_DIR/seen.json"; echo "not here" >&2; exit 2')] }] } });
    const { init, callback, answer } = stream();
    init();
    const id = callback("cc-remote-hook-0", { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "make" }, scratchpad_dir: "/tmp/claude-1/x" });
    expect(await answer(id)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not here" } });
    const seen = JSON.parse(readFileSync(join(project, "seen.json"), "utf8"));
    expect(seen).toEqual({
      session_id: "s1", transcript_path: join(projectsDir(), projectKey(project), "s1.jsonl"), cwd: project, permission_mode: "default",
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "make" },
    });
  });

  test("a Stop hook reads the transcript up to the moment claude calls it", async () => {
    const reader = `${process.execPath} -e 'const i = JSON.parse(await Bun.stdin.text()); const lines = (await Bun.file(i.transcript_path).text()).trim().split("\\n"); console.error(JSON.parse(lines.at(-1)).uuid); process.exit(2)'`;
    put(user(), { hooks: { Stop: [{ hooks: [cmd(reader)] }] } });
    const { init, out, callback, answer } = stream();
    init();
    const frame = (uuid: string) => out({ type: "transcript_mirror", filePath: "/home/someone/.claude/projects/-x/s1.jsonl", entries: [{ type: "assistant", uuid }] });
    expect(frame("a1")).toBeNull();
    expect(frame("a2")).toBeNull();
    const id = callback("cc-remote-hook-0", { hook_event_name: "Stop", stop_hook_active: false });
    expect(await answer(id)).toEqual({ decision: "block", reason: "a2" });
  });

  test("the user's own matcher and if condition decide, on the built-in names", async () => {
    put(user(), {
      hooks: {
        PreToolUse: [
          { matcher: "^mcp__", hooks: [cmd('touch "$CLAUDE_PROJECT_DIR/mcp"')] },
          { matcher: "Bash", hooks: [cmd('touch "$CLAUDE_PROJECT_DIR/git"', { if: "Bash(git *)" })] },
        ],
      },
    });
    const { init, callback, answer } = stream();
    init();
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Read", tool_input: { file_path: "a" } }))).toEqual({});
    expect(await answer(callback("cc-remote-hook-1", { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "ls" } }))).toEqual({});
    expect(existsSync(join(project, "mcp")) || existsSync(join(project, "git"))).toBe(false);
    expect(await answer(callback("cc-remote-hook-1", { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "cd x && git status" } }))).toEqual({});
    expect(existsSync(join(project, "git"))).toBe(true);
  });

  test("the policy hook still decides beside a user's hook that allows", async () => {
    put(user(), { permissions: { deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd(`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`)] }] } });
    const { init, callback, answer, out, replies } = stream();
    init();
    const input = { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "rm -rf build" } };
    expect(await answer(callback("cc-remote-hook-0", input))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    // claude merges the answers, and deny wins; the shell tool refuses the command again before running it.
    out({ type: "control_request", request_id: "p", request: { subtype: "hook_callback", callback_id: HOOK_ID, input } });
    expect(replies.find((m) => m.response.request_id === "p").response.response.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a cancelled callback stops its hook and gets no answer; the cancellation doesn't reach the SDK", async () => {
    const pid = join(project, "pid");
    put(user(), { hooks: { PreToolUse: [{ hooks: [cmd(`echo $$ > "${pid}"; sleep 30`)] }] } });
    const { init, callback, answer, out } = stream();
    init();
    const id = callback("cc-remote-hook-0", { hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: {} });
    expect(await waitFor(() => existsSync(pid) && readFileSync(pid, "utf8").trim() !== "")).toBe(true);
    expect(out({ type: "control_cancel_request", request_id: id })).toBeNull();
    const other = { type: "control_cancel_request", request_id: "theirs" };
    expect(out(other)).toEqual(other);
    expect(await answer(id, 1_000)).toBeUndefined();
    const shell = Number(readFileSync(pid, "utf8"));
    expect(await waitFor(() => { try { process.kill(shell, 0); return false; } catch { return true; } })).toBe(true);
  }, 20_000);

  test("an async hook answers at once, and what it leaves comes with the next prompt", async () => {
    put(user(), { hooks: { PostToolUse: [{ matcher: "Write", hooks: [cmd(`sleep 0.3; echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"tests pass"}}'`, { async: true })] }] } });
    const { init, callback, answer } = stream();
    const request = init();
    expect(idsFor(request, "UserPromptSubmit")).toEqual(["cc-remote-hooks-carrier"]);
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "PostToolUse", tool_name: "mcp__cc__Write", tool_input: {}, tool_response: {} }), 2_000)).toEqual({ async: true });
    expect(await answer(callback("cc-remote-hooks-carrier", { hook_event_name: "UserPromptSubmit", prompt: "next" }))).toEqual({});
    await Bun.sleep(1_500);
    expect(await answer(callback("cc-remote-hooks-carrier", { hook_event_name: "UserPromptSubmit", prompt: "next" }))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "tests pass" } });
    expect(await answer(callback("cc-remote-hooks-carrier", { hook_event_name: "UserPromptSubmit", prompt: "again" }))).toEqual({});
  }, 20_000);

  test("SessionStart's plain output is context, and what it puts in CLAUDE_ENV_FILE reaches the local Bash", async () => {
    put(user(), { hooks: { SessionStart: [{ hooks: [cmd('echo "export HOOKED=from-session-start" >> "$CLAUDE_ENV_FILE"; echo "project notes"')] }] } });
    const { init, callback, answer, ws } = stream();
    init();
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "SessionStart", source: "startup" }))).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "project notes" } });
    expect(ws.envFile).toBeDefined();
    expect(await call(bash(ws), { command: 'echo "$HOOKED"' })).toEqual({ text: "from-session-start", error: false });
  }, 30_000);

  test("a new session's SessionStart hooks, which claude starts before it knows ours, run with the first prompt", async () => {
    put(user(), {
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [cmd('cat > "$CLAUDE_PROJECT_DIR/start.json"; echo "from startup"')] }, { matcher: "resume", hooks: [cmd("echo from resume")] }],
        UserPromptSubmit: [{ hooks: [cmd("echo from prompt")] }],
      },
    });
    const { init, callback, answer } = stream();
    init();
    const prompt = { hook_event_name: "UserPromptSubmit", prompt: "hi" };
    expect(await answer(callback("cc-remote-hooks-carrier", prompt))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "from startup" } });
    expect(JSON.parse(readFileSync(join(project, "start.json"), "utf8"))).toEqual({
      session_id: "s1", transcript_path: join(projectsDir(), projectKey(project), "s1.jsonl"), cwd: project, permission_mode: "default", hook_event_name: "SessionStart", source: "startup",
    });
    // The user's own UserPromptSubmit hook answers for itself; the carrier has nothing more.
    expect(await answer(callback("cc-remote-hook-2", prompt))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "from prompt" } });
    expect(await answer(callback("cc-remote-hooks-carrier", prompt))).toEqual({});
  });

  test("when claude does call SessionStart back, as on a resume, the first prompt doesn't run it again", async () => {
    const count = join(project, "starts");
    put(user(), { hooks: { SessionStart: [{ hooks: [cmd(`echo x >> "${count}"`)] }] } });
    const { init, callback, answer } = stream([...ARGS, "--resume", "abc"]);
    init();
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "SessionStart", source: "resume" }))).toEqual({});
    expect(await answer(callback("cc-remote-hooks-carrier", { hook_event_name: "UserPromptSubmit", prompt: "hi" }))).toEqual({});
    expect(readFileSync(count, "utf8")).toBe("x\n");
  });

  test("SessionEnd answers at once and its hook runs on", async () => {
    const marker = join(project, "ended");
    put(user(), { hooks: { SessionEnd: [{ hooks: [cmd(`sleep 0.3; cat > "${marker}"`, { timeout: 10 })] }] } });
    const { init, callback, answer } = stream();
    init();
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "SessionEnd", reason: "other" }), 1_000)).toEqual({});
    expect(existsSync(marker)).toBe(false);
    expect(await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").includes('"reason":"other"'))).toBe(true);
  });

  test("a hook taken out of the settings mid-session stops running", async () => {
    put(user(), { hooks: { Stop: [{ hooks: [cmd("exit 2")] }] } });
    const { init, callback, answer } = stream();
    init();
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "Stop" }))).toEqual({ decision: "block", reason: "Blocked by hook" });
    put(user(), { hooks: {} });
    expect(await answer(callback("cc-remote-hook-0", { hook_event_name: "Stop" }))).toEqual({});
  });

  test("without local hooks, initialize is left alone but for the policy hook", () => {
    const { init } = stream();
    expect(Object.keys(init().hooks)).toEqual(["PreToolUse"]);
  });
});

describe("starting claude with them", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-remote-hooks-host-"));
  const host = fakeHost(dir);
  const KEYS = ["CC_REMOTE_SSH", "FAKE_SSH_LOG", "FAKE_HOST_HOME", "CC_REMOTE_RECONNECT_GRACE"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, Bun.env[k]]));
  // Reconnection is turned off only in cc-remote's own processes: in this one, launch() would say so
  // once for the whole test run, and other files listen for what it says once.
  beforeAll(() => {
    Object.assign(Bun.env, host.env);
    delete Bun.env.CC_REMOTE_RECONNECT_GRACE;
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete Bun.env[k];
      else Bun.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const settings = () => put(user(), {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [cmd(`cat > "$CLAUDE_PROJECT_DIR/ran.json"; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"local hook"}}'`)] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "Is the task done? $ARGUMENTS" }] }],
    },
  });
  const hostSettings = { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Is the task done? $ARGUMENTS" }] }] }, env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" } };
  /** The settings the fake claude was started with: its last argument. */
  const lastSettings = (args: string) => JSON.parse(args.slice(args.lastIndexOf("[--settings] [") + 14, -1));

  /** Lines from a stream, as they come. */
  function reader(stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>) {
    const lines: string[] = [];
    let buffer = "";
    const take = (chunk: Buffer | Uint8Array) => {
      buffer += Buffer.from(chunk).toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    };
    if ("on" in stream) stream.on("data", take);
    else void (async () => { for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) take(chunk); })();
    const find = async (match: (line: string) => boolean) => {
      for (let i = 0; i < 400; i++) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        await Bun.sleep(25);
      }
      throw new Error(`not seen; got:\n${lines.join("\n")}`);
    };
    return { lines, find };
  }

  const callbackLine = (cwd: string, callback_id: string) => JSON.stringify({
    type: "control_request", request_id: "cb1",
    request: { subtype: "hook_callback", callback_id, tool_use_id: "t", input: {
      session_id: "s1", hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command: "ls" },
      cwd: join(host.home, hostDir(cwd)), transcript_path: "/x/.claude/projects/-k/s1.jsonl",
    } },
  });

  test("as cc-remote claude: the host gets the prompt hook in its --settings, the command hook runs here", async () => {
    settings();
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "claude", "--output-format", "stream-json", "--verbose", ...ARGS, "--settings", '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"flag-hook"}]}]}}'], {
      cwd: project,
      env: { ...Bun.env, XDG_CACHE_HOME: join(iso.home, ".cache"), CC_REMOTE_RECONNECT_GRACE: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = reader(proc.stdout);
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize" } })}\n`);
    const args = await out.find((l) => l.startsWith("ARGS"));
    // The flag's command hook runs here; only the prompt hook goes to the host.
    expect(lastSettings(args)).toEqual(hostSettings);
    const init = JSON.parse(await out.find((l) => l.includes('"initialize"'))).request;
    // The command line's hooks rank above the user's, and come first.
    expect(init.hooks.Notification).toEqual([{ hookCallbackIds: ["cc-remote-hook-0"], timeout: 630 }]);
    expect(init.hooks.PreToolUse[0]).toEqual({ matcher: "Bash|mcp__cc__Bash", hookCallbackIds: ["cc-remote-hook-1"], timeout: 630 });
    proc.stdin.write(`${callbackLine(project, "cc-remote-hook-1")}\n`);
    const reply = JSON.parse(await out.find((l) => l.includes('"control_response"') && l.includes('"cb1"')));
    expect(reply.response.response).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "local hook" } });
    const ran = JSON.parse(readFileSync(join(project, "ran.json"), "utf8"));
    expect([ran.tool_name, ran.cwd, ran.transcript_path]).toEqual(["Bash", project, join(projectsDir(), projectKey(project), "s1.jsonl")]);
    // The callback request never reached the SDK: what it sees of it is the answer claude echoed.
    expect(out.lines.filter((l) => l.includes('"hook_callback"'))).toEqual([]);
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, 30_000);

  test("under claude-agent-acp: the spawner registers them too", async () => {
    settings();
    const abort = new AbortController();
    const ws = workspace(project);
    const sdk = spawner("box", project, {}, ws)({ command: "claude", args: ARGS, env: { ...process.env }, signal: abort.signal });
    const out = reader(sdk.stdout);
    sdk.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize", hooks: { Stop: [{ hookCallbackIds: ["hook_0"] }] } } })}\n`);
    expect(lastSettings(await out.find((l) => l.startsWith("ARGS")))).toEqual(hostSettings);
    const init = JSON.parse(await out.find((l) => l.includes('"initialize"'))).request;
    expect(init.hooks.Stop).toEqual([{ hookCallbackIds: ["hook_0"] }]);
    expect(init.hooks.PreToolUse.map((m: any) => m.hookCallbackIds[0])).toEqual(["cc-remote-hook-0", HOOK_ID]);
    sdk.stdin.write(`${callbackLine(project, "cc-remote-hook-0")}\n`);
    const reply = JSON.parse(await out.find((l) => l.includes('"control_response"') && l.includes('"cb1"')));
    expect(reply.response.response.hookSpecificOutput.permissionDecisionReason).toBe("local hook");
    const exited = new Promise((done) => sdk.once("exit", done));
    abort.abort();
    await exited;
  }, 30_000);

  test("a one-off -p keeps the command line's settings as they are", () => {
    settings();
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "claude", "-p", "--settings", '{"disableAllHooks":true}'], {
      cwd: project, env: { ...Bun.env, XDG_CACHE_HOME: join(iso.home, ".cache") }, stdin: "ignore",
    });
    expect(r.stdout.toString()).toContain('[--settings] [{"disableAllHooks":true,"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"0"}}]');
  }, 30_000);
});

test("the host folder is this machine's name", () => {
  expect(hostDir("/w")).toBe(`.cc-remote/ws/${hostname()}/w`);
});
