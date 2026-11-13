import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFiles } from "../src/host-fs";
import { policyHook } from "../src/policy";
import { rewriter } from "../src/proxy";
import { settingsLocations } from "../src/rules";
import { keyFor } from "../src/sessions";
import { hostDir, launch, tellTools } from "../src/ssh";
import { edit as makeEdit } from "../src/tools/edit";
import { glob as makeGlob } from "../src/tools/glob";
import { read as makeRead } from "../src/tools/read";
import { workspace } from "../src/tools/util";
import { write as makeWrite } from "../src/tools/write";
import { versionCache } from "../src/version";
import { fakeHost } from "./fakehost";
import { call } from "./fixture";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-hostfiles-")));
const host = fakeHost(dir);
const hostConfig = join(dir, "host-config");
const KEYS = ["CC_REMOTE_SSH", "FAKE_SSH_LOG", "FAKE_HOST_HOME", "FAKE_HOST_CONFIG", "FAKE_NOISE", "CLAUDE_CONFIG_DIR", "HOME"];
const saved = { env: Object.fromEntries(KEYS.map((k) => [k, Bun.env[k]])), cache: { ...versionCache }, managed: settingsLocations.managed };

beforeAll(() => {
  for (const k of KEYS) delete Bun.env[k];
  Object.assign(Bun.env, host.env, { FAKE_HOST_CONFIG: hostConfig, CLAUDE_CONFIG_DIR: join(dir, "local-config"), HOME: join(dir, "local-home") });
  versionCache.dir = join(dir, "cache");
  settingsLocations.managed = join(dir, "managed");
});
beforeEach(() => {
  host.reset();
  delete Bun.env.FAKE_NOISE;
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved.env[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = saved.env[k];
  }
  Object.assign(versionCache, saved.cache);
  settingsLocations.managed = saved.managed;
  rmSync(dir, { recursive: true, force: true });
});

/** The host folder of a local project, as the check reports it. */
const folder = (cwd: string) => join(host.home, hostDir(cwd));

describe("which files are the host's", () => {
  const where = { home: "/home/u", config: "/home/u/.claude", folder: "/home/u/.cc-remote/ws/laptop/work/app" };
  const files = new HostFiles("box", where);
  const key = keyFor(where.folder);

  test("the plans, the session's project folder, agent memory and task output, as the host names them", () => {
    for (const path of ["/home/u/.claude/plans/a-plan.md", `/home/u/.claude/projects/${key}/s1/tool-results/mcp-cc-Read-1.txt`,
      `/home/u/.claude/projects/${key}/memory/MEMORY.md`, "/home/u/.claude/agent-memory/reviewer/MEMORY.md",
      `/tmp/claude-1000/${key}/s1/tasks/a.output`, `/var/folders/x/T/claude-501/${key}/s1/tasks/b.output`]) {
      expect([path, files.own(path)]).toEqual([path, path]);
    }
    expect(files.own("~/.claude/plans/a.md")).toBe("/home/u/.claude/plans/a.md");
    expect(files.own("/home/u/.claude/plans/x/../b.md")).toBe("/home/u/.claude/plans/b.md");
  });

  test("not the scratchpad, skills, other projects, local paths, or a way out of the folders", () => {
    for (const path of [`/tmp/claude-1000/${key}/s1/scratchpad/notes.txt`, "/home/u/.claude/skills/x/SKILL.md", "/home/u/.claude/projects/-other/s.jsonl",
      "/home/u/.claude/plans-old/a.md", "/home/u/.claude/plans/../settings.json", "/work/app/src/a.ts", "src/a.ts", "C:\\Users\\u\\a.ts", "~other/.claude/plans/a.md"]) {
      expect([path, files.own(path)]).toEqual([path, undefined]);
    }
  });

  test("claude edits its own plan files and memory files without asking: markdown right in plans/, or in a memory folder", () => {
    expect(files.selfEdited("/home/u/.claude/plans/a.md")).toBe("plan");
    expect(files.selfEdited("/home/u/.claude/plans/a-agent-x1.md")).toBe("plan");
    expect(files.selfEdited(`/home/u/.claude/projects/${key}/memory/MEMORY.md`)).toBe("memory");
    expect(files.selfEdited(`/home/u/.claude/projects/${key}/memory/topics/build.md`)).toBe("memory");
    expect(files.selfEdited("/home/u/.claude/agent-memory/reviewer/MEMORY.md")).toBe("memory");
    for (const path of ["/home/u/.claude/plans/sub/a.md", "/home/u/.claude/plans/a.txt", `/home/u/.claude/projects/${key}/memory/x.sh`,
      `/home/u/.claude/projects/${key}/s1/tool-results/a.md`, "/work/app/plans/a.md"]) {
      expect([path, files.selfEdited(path)]).toEqual([path, undefined]);
    }
  });

  test("needs absolute paths from the check, and reads a relative config folder from the host folder", () => {
    expect(HostFiles.from("box", { ...where, home: "" })).toBeUndefined();
    expect(HostFiles.from("box", { ...where, folder: "relative" })).toBeUndefined();
    expect(HostFiles.from("box", { ...where, config: "cfg" })?.plans).toBe(`${where.folder}/cfg/plans`);
  });
});

describe("reading and writing them on the host", () => {
  const cwd = join(dir, "project");
  beforeAll(() => mkdirSync(cwd, { recursive: true }));
  const files = () => new HostFiles("box", { home: host.home, config: hostConfig, folder: folder(cwd) });
  const plan = join(hostConfig, "plans", "a-plan.md");

  test("writes in place, privately, and says whether the file was there; reads back what is there", async () => {
    const f = files();
    expect(await f.write(plan, "# Plan\n")).toBe(false);
    expect(readFileSync(plan, "utf8")).toBe("# Plan\n");
    expect(statSync(plan).mode & 0o777).toBe(0o600);
    expect(statSync(join(hostConfig, "plans")).mode & 0o777).toBe(0o700);
    expect(await f.write(plan, "# Plan v2\n")).toBe(true);
    expect(new TextDecoder().decode((await f.read(plan)) as Uint8Array)).toBe("# Plan v2\n");
    expect(await f.read(join(hostConfig, "plans", "none.md"))).toBe("missing");
    expect(await f.read(join(hostConfig, "plans"))).toBe("directory");
    expect(host.calls()).toHaveLength(5);
    // What a chatty shell startup prints is not the file's.
    Bun.env.FAKE_NOISE = "1";
    expect(new TextDecoder().decode((await f.read(plan)) as Uint8Array)).toBe("# Plan v2\n");
    expect(await f.write(plan, "")).toBe(true);
    expect(new TextDecoder().decode((await f.read(plan)) as Uint8Array)).toBe("");
  });

  test("Read, Write and Edit take the host's files to the host and leave the rest here", async () => {
    const ws = workspace(cwd);
    ws.host = files();
    const [read, write, edit, glob] = [makeRead, makeWrite, makeEdit, makeGlob].map((t) => t(ws));
    const memory = join(hostConfig, "projects", keyFor(folder(cwd)), "memory", "MEMORY.md");
    expect((await call(write, { file_path: memory, content: "one\ntwo\n" })).text).toBe(`File created successfully at: ${memory}`);
    expect((await call(edit, { file_path: memory, old_string: "two", new_string: "three" })).text).toBe(`The file ${memory} has been updated successfully.`);
    expect((await call(read, { file_path: memory })).text).toBe("     1\tone\n     2\tthree");
    expect(await call(read, { file_path: join(hostConfig, "plans", "gone.md") })).toEqual({ text: `File does not exist: ${join(hostConfig, "plans", "gone.md")}`, error: true });
    expect(await call(edit, { file_path: memory, old_string: "four", new_string: "five" })).toMatchObject({ error: true });
    expect(host.calls().length).toBe(6);
    // Glob lists the host's folder there, given as the path or as an absolute pattern's start.
    const dir = join(hostConfig, "projects", keyFor(folder(cwd)), "memory");
    await call(write, { file_path: join(dir, "topics", "build.md"), content: "x" });
    expect((await call(glob, { pattern: "**/*.md", path: dir })).text).toBe(`${join(dir, "MEMORY.md")}\n${join(dir, "topics", "build.md")}`);
    expect((await call(glob, { pattern: `${dir}/topics/*.md` })).text).toBe(join(dir, "topics", "build.md"));
    expect((await call(glob, { pattern: "*.txt", path: dir })).text).toBe("No files found");
    expect((await call(glob, { pattern: "*", path: join(hostConfig, "plans", "none") })).text).toBe(`Directory does not exist: ${join(hostConfig, "plans", "none")}`);
    host.reset();
    await call(write, { file_path: join(cwd, "local.txt"), content: "here" });
    expect((await call(read, { file_path: "local.txt" })).text).toBe("     1\there");
    expect((await call(glob, { pattern: "*.txt" })).text).toBe(join(cwd, "local.txt"));
    expect(host.calls()).toEqual([]);
  });

  test("a launch tells the session's tools where the host keeps them", async () => {
    const ws = workspace(cwd);
    const child = launch("box", cwd, [], {}, [], undefined, tellTools("box", ws));
    child.stdin.end();
    await new Promise((done) => child.on("exit", done));
    expect(ws.host?.plans).toBe(join(hostConfig, "plans"));
    expect(ws.host?.own(join(hostConfig, "projects", keyFor(realpathSync(folder(cwd))), "s", "tool-results", "x.txt"))).toBeDefined();
  });
});

describe("the policy for them", () => {
  const cwd = join(dir, "policy-project");
  beforeAll(() => mkdirSync(cwd, { recursive: true }));
  const ws = () => Object.assign(workspace(cwd), { host: new HostFiles("box", { home: host.home, config: hostConfig, folder: folder(cwd) }) });
  const plan = join(hostConfig, "plans", "p.md");
  const memory = join(hostConfig, "projects", keyFor(folder(cwd)), "memory", "MEMORY.md");
  const result = join(hostConfig, "projects", keyFor(folder(cwd)), "s1", "tool-results", "r.md");
  const hook = (tool_name: string, tool_input: object, permission_mode: string) =>
    (policyHook({ hook_event_name: "PreToolUse", tool_name, tool_input, permission_mode }, cwd, [], [], ws()) as any).hookSpecificOutput?.permissionDecision;

  test("edits of the plan and memory files are approved in every mode, as claude approves its own; other host files ask", () => {
    for (const mode of ["default", "plan", "acceptEdits", "auto"]) {
      expect(hook("Write", { file_path: plan, content: "x" }, mode)).toBe("allow");
      expect(hook("Edit", { file_path: plan, old_string: "a", new_string: "b" }, mode)).toBe("allow");
      expect(hook("Write", { file_path: memory, content: "x" }, mode)).toBe("allow");
      expect(hook("Write", { file_path: result, content: "x" }, mode)).toBeUndefined();
    }
    expect(hook("NotebookEdit", { notebook_path: plan }, "default")).toBeUndefined();
    expect(policyHook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: plan }, permission_mode: "default" }, cwd, [])).toEqual({});
  });

  test("the permission request for the plan file is answered on the stream", () => {
    const replies: any[] = [];
    const r = rewriter({ cwd, hostDir: hostDir(cwd), mode: "plan", ws: ws() });
    const request = (tool_name: string, input: object) =>
      r.outbound(JSON.stringify({ type: "control_request", request_id: "w", request: { subtype: "can_use_tool", tool_name, input } }), (x) => replies.push(JSON.parse(x)));
    expect(request("mcp__cc__Write", { file_path: plan, content: "# Plan" })).toBeNull();
    expect(replies[0].response.response).toEqual({ behavior: "allow", updatedInput: { file_path: plan, content: "# Plan" } });
    expect(request("mcp__cc__Write", { file_path: result, content: "x" })).not.toBeNull();
    // Approving is all: the tool call itself writes the file.
    expect(existsSync(plan)).toBe(false);
  });
});
