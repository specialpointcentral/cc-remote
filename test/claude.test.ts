import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { hostLaunch, hostPlugins } from "../src/args";
import { forwardedEnv } from "../src/claude";
import { initialize, sdkHost } from "../src/control";
import { pluginsApplied, readInitialize } from "../src/initialize";
import { hostTools, REMOVED } from "../src/names";
import { remote } from "../src/options";
import { mirrorKey, projectsDir } from "../src/sessions";
import { argument, hostDir, spawner } from "../src/ssh";
import { localTools } from "../src/tools";
import { workspace } from "../src/tools/util";
import { fakeHost, TEAMS_OFF } from "./fakehost";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-claude-"));
const savedConfigDir = Bun.env.CLAUDE_CONFIG_DIR;
beforeAll(() => { Bun.env.CLAUDE_CONFIG_DIR = join(dir, "config"); });
afterAll(() => {
  if (savedConfigDir === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
  else Bun.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

/** The command line Orca 1.4.254 gave its Claude Command for a new chat (SDK 0.3.284). */
const orca = (plugin: string) => [
  "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool", "stdio",
  "--setting-sources=user,project,local", "--permission-mode", "default", "--include-partial-messages",
  "--add-dir", "/orca/profile/agent-session-attachments", "--add-dir", "/orca/profile/chat-scratch/f368",
  "--plugin-dir", plugin, "--session-id=741f7a4e-c84b-4612-a796-478b87521238", "--replay-user-messages",
  "--thinking-display", "summarized", "--settings", '{"fastMode":false}',
];

describe("hostLaunch", () => {
  const plugin = join(dir, "visuals");
  beforeAll(() => {
    mkdirSync(join(plugin, "skills", "x"), { recursive: true });
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
  });

  test("keeps Orca's flags, moves local paths off the command line, and adds the local tools' settings", () => {
    const cwd = "/work/app";
    const launch = hostLaunch(orca(plugin), cwd, true);
    expect(launch.addDirs).toEqual(["/orca/profile/agent-session-attachments", "/orca/profile/chat-scratch/f368"]);
    expect(launch.mode).toBe("default");
    expect(launch.uploads).toHaveLength(1);
    expect(launch.uploads[0]!.local).toBe(plugin);
    expect(launch.uploads[0]!.remote).toMatch(/^\.cc-remote\/plugins\/visuals-[0-9a-z]+$/);
    const up = "../".repeat(hostDir(cwd).split("/").length);
    expect(launch.args).toEqual([
      "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool", "stdio",
      "--setting-sources=user,project,local", "--permission-mode", "default", "--include-partial-messages",
      `--plugin-dir=${up}${launch.uploads[0]!.remote}`, "--session-id=741f7a4e-c84b-4612-a796-478b87521238", "--replay-user-messages",
      "--thinking-display", "summarized", "--settings", '{"fastMode":false}',
      "--allowedTools=mcp__cc__Read,mcp__cc__Glob,mcp__cc__Grep",
      `--tools=${hostTools(true).tools!.join(",")}`,
      `--disallowedTools=${hostTools(true).disallowed.join(",")}`,
      "--session-mirror",
    ]);
  });

  test("a plugin that isn't readable here is left out, and said to be", () => {
    const missing = join(dir, "no-such-plugin");
    const launch = hostLaunch(["--plugin-dir", missing, "--input-format", "stream-json"], "/w", true);
    expect(launch.uploads).toEqual([]);
    expect(launch.leftOut).toEqual([missing]);
    expect(launch.args.some((a) => a.startsWith("--plugin-dir"))).toBe(false);
  });

  test("hostPlugins copies a command line's plugins up as hostLaunch does, and leaves the rest as it is", () => {
    const cwd = "/work/app";
    const up = "../".repeat(hostDir(cwd).split("/").length);
    const { args, uploads } = hostPlugins(["--input-format", "stream-json", `--plugin-dir=${plugin}`, "--plugin-dir-no-mcp", plugin, `--plugin-dir=${join(dir, "no-such-plugin")}`, "--verbose"], cwd);
    const remote = hostLaunch(["--plugin-dir", plugin], cwd, true).uploads[0]!.remote;
    expect(uploads).toEqual([{ local: plugin, remote }, { local: plugin, remote }]);
    expect(args).toEqual(["--input-format", "stream-json", `--plugin-dir=${up}${remote}`, `--plugin-dir-no-mcp=${up}${remote}`, "--verbose"]);
  });

  test("a plugin gets a new name on the host when its content changes", () => {
    const before = hostLaunch(["--plugin-dir", plugin], "/w", true).uploads[0]!.remote;
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: changed\n---\n");
    expect(hostLaunch(["--plugin-dir", plugin], "/w", true).uploads[0]!.remote).not.toBe(before);
  });

  test("merges tool lists into one flag each and bridges --mcp-config servers", () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { file: { command: "f" } } }));
    const settings = join(dir, "settings.json");
    writeFileSync(settings, '{"model":"x"}');
    const launch = hostLaunch([
      "--allowedTools=Bash(git log:*)", "--disallowed-tools", "WebFetch", "Task", "--mcp-config", '{"mcpServers":{"inline":{"type":"http","url":"https://x"}}}', config,
      "--strict-mcp-config", "--settings", settings, "--permission-mode=acceptEdits", "--input-format", "stream-json",
    ], dir, true);
    expect(launch.mcpServers).toEqual({ inline: { type: "http", url: "https://x" }, file: { command: "f" } } as never);
    expect(launch.strictMcpConfig).toBe(true);
    expect(launch.mode).toBe("acceptEdits");
    expect(launch.args).toEqual([
      "--strict-mcp-config", "--settings", '{"model":"x"}', "--permission-mode=acceptEdits", "--input-format", "stream-json",
      "--allowedTools=Bash(git log:*),mcp__cc__Read,mcp__cc__Glob,mcp__cc__Grep",
      `--tools=${hostTools(true).tools!.join(",")}`,
      `--disallowedTools=WebFetch,Task,${hostTools(true).disallowed.join(",")}`,
      "--session-mirror",
    ]);
  });

  test("a stream session names its tools rather than deny Bash, so claude keeps Monitor; not with reconnection off", () => {
    const flags = (argv: string[], stream = true) => {
      const args = hostLaunch(argv, "/w", stream).args;
      const list = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1).split(",").filter(Boolean);
      return { tools: list("--tools"), disallowed: list("--disallowedTools")!, args };
    };
    const stream = flags(["--input-format", "stream-json"]);
    expect(stream.tools).toContain("Monitor");
    for (const t of ["WebFetch", "Agent", "Skill", "DesignSync"]) expect(stream.tools).toContain(t);
    for (const t of [...REMOVED.filter((r) => r !== "Monitor"), "TaskCreate", "TaskList"]) expect(stream.tools).not.toContain(t);
    // Every other built-in that would act on the host is still denied; Bash, by not being named.
    expect(stream.disallowed).toEqual(REMOVED.filter((t) => t !== "Bash" && t !== "Monitor"));
    expect(hostTools(true)).toEqual({ tools: stream.tools, disallowed: stream.disallowed });
    // The caller's own list, without what would act on the host.
    expect(flags(["--input-format", "stream-json", "--tools", "Read,Monitor", "WebSearch"]).tools).toEqual(["Monitor", "WebSearch"]);
    expect(flags(["--input-format", "stream-json", "--tools=default"]).tools).toEqual(stream.tools);
    expect(flags(["--input-format", "stream-json", "--tools", ""]).tools).toEqual([]);
    // A one-off, or reconnection off: Bash is denied as before, and Monitor with it.
    const oneOff = flags(["-p", "--tools", "Read,Grep"], false);
    expect(oneOff.tools).toBeUndefined();
    expect(oneOff.args.slice(0, 3)).toEqual(["-p", "--tools", "Read,Grep"]);
    expect(oneOff.disallowed).toEqual(REMOVED);
    const grace = Bun.env.CC_REMOTE_RECONNECT_GRACE;
    Bun.env.CC_REMOTE_RECONNECT_GRACE = "0";
    try {
      expect(flags(["--input-format", "stream-json"])).toMatchObject({ tools: undefined, disallowed: REMOVED });
    } finally {
      if (grace === undefined) delete Bun.env.CC_REMOTE_RECONNECT_GRACE;
      else Bun.env.CC_REMOTE_RECONNECT_GRACE = grace;
    }
  });

  test("a one-off -p only loses the host's tools", () => {
    // Orca 1.4.251 and 1.4.254's chat title, as test/live/orca.test.ts saw it.
    const argv = [
      "-p", "--output-format", "text", "--model", "sonnet", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob",
      "--permission-mode", "dontAsk", "--effort", "low", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}',
    ];
    const launch = hostLaunch(argv, "/w", false);
    expect(launch.mode).toBe("dontAsk");
    expect(launch.args).toEqual([
      "-p", "--output-format", "text", "--model", "sonnet", "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--effort", "low",
      "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--allowedTools=Read,Grep,Glob", `--disallowedTools=${REMOVED.join(",")}`,
    ]);
  });
});

describe("pluginDelivery: initialize", () => {
  /** What readInitialize makes of `input` sent in pieces of `size` bytes: its result, and the stdin it passes on. */
  async function read(input: string, size: number) {
    const stream = new PassThrough();
    const reading = readInitialize(stream);
    const bytes = Buffer.from(input);
    for (let i = 0; i < bytes.length; i += size) stream.write(bytes.subarray(i, i + size));
    stream.end();
    const init = await reading;
    const chunks: Buffer[] = [];
    for await (const chunk of init.input as Readable) chunks.push(Buffer.from(chunk));
    return { ...init, text: Buffer.concat(chunks).toString() };
  }
  const plugins = [{ type: "local", path: "/p/a" }, { type: "local", path: "rel/b", skipMcpDiscovery: true }];
  const request = { type: "control_request", request_id: "init-1", request: { subtype: "initialize", hooks: {}, plugins } };
  const before = '{"type":"keep_alive"}\n';
  const after = '{"type":"user","message":{"role":"user","content":"café"}}\n';

  test("the request's plugins become flags, and it goes on without them, the lines around it as they were", async () => {
    // In pieces of every size, so a line, and a character, can end anywhere in one.
    for (const size of [1, 2, 3, 7, 64, 4096]) {
      const got = await read(`${before}${JSON.stringify(request)}\n${after}`, size);
      expect(got.flags).toEqual(["--plugin-dir=/p/a", "--plugin-dir-no-mcp=rel/b"]);
      expect(got.id).toBe("init-1");
      expect(got.text).toBe(`${before}${JSON.stringify({ ...request, request: { subtype: "initialize", hooks: {} } })}\n${after}`);
    }
  });

  test("a request without plugins goes on byte for byte, and so does a stdin that ends before one", async () => {
    const plain = '{"type":"control_request","request_id":"i","request":{"subtype":"initialize","n":9007199254740993}}\n';
    const got = await read(`${plain}${after}`, 5);
    expect([got.flags, got.id, got.text]).toEqual([[], undefined, `${plain}${after}`]);
    const ended = await read(`${before}{"type":"user"`, 4);
    expect([ended.flags, ended.id, ended.text]).toEqual([[], undefined, `${before}{"type":"user"`]);
  });

  test("claude's answer to that request says whether the plugins were copied up, once", () => {
    const answer = (id: string) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: { commands: [] } } });
    const patch = pluginsApplied("init-1", false);
    expect(patch(answer("init-10"))).toBe(answer("init-10"));
    expect(JSON.parse(patch(answer("init-1"))).response.response).toEqual({ commands: [], plugins_applied: false });
    expect(patch(answer("init-1"))).toBe(answer("init-1"));
  });

  test("under claude-agent-acp the SDK is told to send them as flags", async () => {
    const options = await remote("box")({ cwd: dir, plugins: [{ type: "local", path: "/p/a" }], pluginDelivery: "initialize" });
    expect(options.pluginDelivery).toBe("argv");
    expect(options.plugins).toEqual([{ type: "local", path: "/p/a" }]);
  });
});

describe("argument", () => {
  test("reads --flag value and --flag=value", () => {
    expect(argument(["--resume=abc"], "--resume", "-r")).toBe("abc");
    expect(argument(["-r", "def"], "--resume", "-r")).toBe("def");
    expect(argument(["--permission-mode", "plan"], "--permission-mode")).toBe("plan");
    expect(argument(["--resume-session-at=x"], "--resume")).toBeUndefined();
  });
});

describe("forwardedEnv", () => {
  test("passes the SDK's settings for claude, never a login, Orca's secrets or the config folder", () => {
    expect(forwardedEnv({
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.284", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k",
      CLAUDE_CONFIG_DIR: "/x", ORCA_AGENT_SESSION_SPAWN_TOKEN: "s", PATH: "/bin",
    })).toEqual({
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.284", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
  });
});

describe("initialize", () => {
  const served = { cc: { instance: {} as never, timeout: 660_000 }, other: { instance: {} as never } };

  test("adds our servers, the tool aliases and wider hooks to the SDK's own", () => {
    const req = initialize({ subtype: "initialize", sdkMcpServers: ["orca"], hooks: { PreToolUse: [{ matcher: "Edit", hookCallbackIds: ["hook_0"] }] } }, served, "ENV");
    expect(req.sdkMcpServers).toEqual(["orca", "cc", "other"]);
    expect(req.sdkMcpServerConfigs).toEqual({ cc: { timeout: 660_000 } });
    expect(req.toolAliases.Bash).toBe("mcp__cc__Bash");
    expect(req.hooks.PreToolUse[0]).toEqual({ matcher: "Edit|mcp__cc__Edit", hookCallbackIds: ["hook_0"] });
  });

  test("replaces the host's sections of claude's own prompt, and appends to a custom one", () => {
    expect(initialize({ subtype: "initialize", supportedDialogKinds: [] }, served, "ENV")).toMatchObject({ excludeDynamicSections: true, appendSystemPrompt: "ENV", supportedDialogKinds: [] });
    expect(initialize({ subtype: "initialize", appendSystemPrompt: "Theirs" }, served, "ENV").appendSystemPrompt).toBe("Theirs\n\nENV");
    const custom = initialize({ subtype: "initialize", systemPrompt: ["You are a bot."] }, served, "ENV");
    expect(custom.systemPrompt).toEqual(["You are a bot.", "ENV"]);
    expect(custom.excludeDynamicSections).toBeUndefined();
  });
});

describe("mirrorKey", () => {
  test("reads transcript paths as the SDK does", () => {
    const p = projectsDir();
    expect(mirrorKey(join(p, "-w", "s1.jsonl"))).toEqual({ projectKey: "-w", sessionId: "s1" });
    expect(mirrorKey(join(p, "-w", "s1", "subagents", "agent-a.jsonl"))).toEqual({ projectKey: "-w", sessionId: "s1", subpath: "subagents/agent-a" });
    expect(mirrorKey(join(p, "-w", "s1", "x.jsonl"))).toBeUndefined();
    expect(mirrorKey(join(dir, "elsewhere", "s1.jsonl"))).toBeUndefined();
  });
});

/** Runs a layer the way the proxy does, and collects what it writes to claude. */
function harness(servers: Parameters<typeof sdkHost>[0]) {
  const toClaude: any[] = [];
  let wake = () => {};
  const layer = sdkHost(servers, "ENV", (line) => { toClaude.push(JSON.parse(line)); wake(); });
  const reply = async (id: string) => {
    for (;;) {
      const found = toClaude.find((m) => m.response?.request_id === id);
      if (found) return found.response;
      await new Promise<void>((r) => { wake = r; });
    }
  };
  const mcp = (request_id: string, server_name: string, message: object) =>
    layer.outbound(JSON.stringify({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name, message } }));
  return { layer, toClaude, reply, mcp };
}

describe("sdkHost", () => {
  const work = join(dir, "work");
  beforeAll(() => mkdirSync(work, { recursive: true }));

  test("serves the local tools over claude's mcp_message requests, and lets the SDK's own servers through", async () => {
    const { layer, reply, mcp } = harness({ cc: localTools(work) });
    const init = JSON.parse(layer.inbound(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize" } }))!);
    expect(init.request.sdkMcpServers).toEqual(["cc"]);

    expect(mcp("1", "cc", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } })).toBeNull();
    expect((await reply("1")).response.mcp_response.result.serverInfo.name).toBe("cc");
    expect(mcp("2", "cc", { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect((await reply("2")).response.mcp_response).toEqual({ jsonrpc: "2.0", result: {}, id: 0 });

    mcp("3", "cc", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await reply("3")).response.mcp_response.result.tools.map((t: { name: string }) => t.name)).toContain("Write");
    mcp("4", "cc", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Write", arguments: { file_path: join(work, "a.txt"), content: "hi" } } });
    expect((await reply("4")).response.mcp_response.result.content[0].text).toContain("File created successfully");
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("hi");

    const theirs = JSON.stringify({ type: "control_request", request_id: "5", request: { subtype: "mcp_message", server_name: "orca", message: { jsonrpc: "2.0", id: 3, method: "tools/list" } } });
    expect(layer.outbound(theirs)).toBe(theirs);
    const response = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "x", response: {} } });
    expect(layer.outbound(response)).toBe(response);
  });

  test("a server the SDK declares itself stays the SDK's, but cc is always ours", () => {
    const { layer, mcp } = harness({ cc: localTools(work), orca: localTools(work) });
    layer.inbound(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize", sdkMcpServers: ["orca", "cc"] } }));
    expect(mcp("1", "orca", { jsonrpc: "2.0", id: 0, method: "tools/list" })).not.toBeNull();
    expect(mcp("2", "cc", { jsonrpc: "2.0", id: 0, method: "tools/list" })).toBeNull();
  });

  test("holds what a server sends until claude is initialized, and keeps claude's reply to itself", async () => {
    const server = new McpServer({ name: "late", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    const { layer, toClaude } = harness({ late: { instance: server } });
    await Bun.sleep(0);
    server.sendToolListChanged();
    await Bun.sleep(0);
    expect(toClaude).toEqual([]);
    layer.inbound(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize" } }));
    await Bun.sleep(0);
    expect(toClaude).toHaveLength(1);
    expect(toClaude[0].request).toEqual({ subtype: "mcp_message", server_name: "late", message: { jsonrpc: "2.0", method: "notifications/tools/list_changed" } });
    const ack = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: toClaude[0].request_id, response: {} } });
    expect(layer.outbound(ack)).toBeNull();
  });

  test("keeps its servers in a later mcp_set_servers", () => {
    const { layer } = harness({ cc: localTools(work) });
    layer.inbound(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize" } }));
    const set = JSON.parse(layer.inbound(JSON.stringify({ type: "control_request", request_id: "s", request: { subtype: "mcp_set_servers", servers: { mine: { type: "sdk", name: "mine" } } } }))!);
    expect(set.request.servers).toEqual({ mine: { type: "sdk", name: "mine" }, cc: { type: "sdk", name: "cc", timeout: 660_000 } });
  });

  test("passes transcript mirror frames on: the proxy before it writes them (rewrite.test.ts)", () => {
    const { layer } = harness({});
    const frame = JSON.stringify({ type: "transcript_mirror", filePath: join(projectsDir(), "-w", "s1.jsonl"), entries: [] });
    expect(layer.outbound(frame)).toBe(frame);
  });
});

describe("cc-remote claude", () => {
  // Each case starts cc-remote (a new bun) several times, which takes seconds on a busy machine.
  const SPAWNS = 30_000;
  const host = fakeHost(join(dir, "entry"));
  const cache = join(dir, "entry", "cache");
  beforeAll(() => mkdirSync(join(dir, "work-entry"), { recursive: true }));
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "claude", ...args], {
      cwd: join(dir, "work-entry"),
      env: { ...Bun.env, ...host.env, XDG_CACHE_HOME: cache, CLAUDE_CODE_FROM_SDK: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret" },
      stdin: "ignore",
    });

  test("answers version probes from the host once, then from the cache, and help from the host", () => {
    host.reset();
    for (const probe of ["--version", "-v", "--version"]) {
      const out = run(probe);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.toString()).toBe("2.1.323 (Claude Code)\n");
    }
    expect(host.calls()).toHaveLength(1);
    const help = run("--help");
    expect(help.stdout.toString()).toStartWith("ARGS [--help]");
    expect(host.calls()).toHaveLength(2);
  }, SPAWNS);

  test("version probes that start together ask the host once", async () => {
    const fresh = join(dir, "entry", "cache-together");
    host.reset();
    const probe = () => Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "claude", "--version"], {
      cwd: join(dir, "work-entry"), env: { ...Bun.env, ...host.env, XDG_CACHE_HOME: fresh }, stdin: "ignore", stdout: "pipe",
    });
    const outs = await Promise.all([probe(), probe(), probe()].map((p) => new Response(p.stdout).text()));
    expect(outs).toEqual(Array(3).fill("2.1.323 (Claude Code)\n"));
    expect(host.calls()).toHaveLength(1);
  }, SPAWNS);

  test("passes claude's subcommands to the host as they are, and refuses an interactive session", () => {
    expect(run("auth", "status", "--json").stdout.toString()).toStartWith("ARGS [auth] [status] [--json]");
    const interactive = run("--dangerously-skip-permissions");
    expect(interactive.exitCode).toBe(1);
    expect(interactive.stderr.toString()).toContain("stands in for claude under an app");
  }, SPAWNS);

  test("runs a one-off -p on the host in one channel, without local paths, the login or the host's tools", () => {
    run("--version");
    host.reset();
    const out = run("-p", "--add-dir", "/local/only", "--output-format", "text");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.toString()).toBe(`ARGS [-p] [--output-format] [text] [--disallowedTools=${REMOVED.join(",")}]${TEAMS_OFF}\nTEAMS=0\n`);
    const [remote, ...more] = host.calls();
    expect(more).toEqual([]);
    expect(remote).toContain("'CLAUDE_CODE_FROM_SDK=1'");
    expect(remote).toContain("'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0'");
    expect(remote).toContain("Compression=yes");
    expect(remote).not.toContain("secret");
    expect(remote).not.toContain("/local/only");
  }, SPAWNS);

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

  /** A plugin folder with one skill. */
  const plugin = (name: string) => {
    const path = join(dir, name);
    mkdirSync(join(path, "skills", "x"), { recursive: true });
    writeFileSync(join(path, "skills", "x", "SKILL.md"), `---\nname: x\n---\n${name}\n`);
    return path;
  };

  test("with pluginDelivery: initialize, the request's plugins go up as copies, and claude still waits for the request", async () => {
    const local = plugin("init-plugin");
    host.reset();
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "claude", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--await-initialize"], {
      cwd: join(dir, "work-entry"),
      env: { ...Bun.env, ...host.env, XDG_CACHE_HOME: cache, CC_REMOTE_RECONNECT_GRACE: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = reader(proc.stdout);
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize", plugins: [{ type: "local", path: local, skipMcpDiscovery: true }] } })}\n`);
    const args = await out.find((l) => l.startsWith("ARGS"));
    expect(args).toContain("[--await-initialize]");
    const flag = /\[--plugin-dir-no-mcp=(?:\.\.\/)+(\.cc-remote\/plugins\/init-plugin-[0-9a-z]+)\]/.exec(args);
    expect(flag).not.toBeNull();
    expect(readFileSync(join(host.home, flag![1]!, "skills", "x", "SKILL.md"), "utf8")).toBe("---\nname: x\n---\ninit-plugin\n");
    const request = JSON.parse(await out.find((l) => l.includes('"control_request"') && l.includes('"init-1"'))).request;
    expect(request.subtype).toBe("initialize");
    expect(request).not.toHaveProperty("plugins");
    // The fake claude echoes its stdin, so an answer written there comes back as claude's.
    proc.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "init-1", response: {} } })}\n`);
    const answer = JSON.parse(await out.find((l) => l.includes('"control_response"') && l.includes('"init-1"')));
    expect(answer.response.response).toEqual({ plugins_applied: true });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, SPAWNS);

  test("under claude-agent-acp, the spawner copies the plugins of the command line up", async () => {
    const local = plugin("acp-plugin");
    const cwd = join(dir, "work-entry");
    const keys = Object.keys(host.env);
    const saved = Object.fromEntries(keys.map((k) => [k, Bun.env[k]]));
    Object.assign(Bun.env, host.env);
    try {
      const abort = new AbortController();
      const sdk = spawner("box", cwd, {}, workspace(cwd))({ command: "claude", args: ["--input-format", "stream-json", `--plugin-dir=${local}`], env: { ...process.env }, signal: abort.signal });
      const args = await reader(sdk.stdout).find((l) => l.startsWith("ARGS"));
      const flag = /\[--plugin-dir=(?:\.\.\/)+(\.cc-remote\/plugins\/acp-plugin-[0-9a-z]+)\]/.exec(args);
      expect(flag).not.toBeNull();
      expect(existsSync(join(host.home, flag![1]!, "skills", "x", "SKILL.md"))).toBe(true);
      const exited = new Promise((done) => sdk.once("exit", done));
      abort.abort();
      await exited;
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete Bun.env[k];
        else Bun.env[k] = saved[k];
      }
    }
  }, SPAWNS);
});
