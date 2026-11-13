import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolate } from "./fixture";
import { strip, widenMatcher } from "../src/names";
import { commandPrefix, rewriter, type Session } from "../src/proxy";
import { projectKey, projectsDir } from "../src/sessions";
import { quote, remoteCommand, rsh } from "../src/ssh";

describe("names", () => {
  test("strips the MCP prefix from whole tool names only", () => {
    const msg = JSON.stringify({ name: "mcp__cc__Bash", tools: ["WebSearch", "mcp__cc__Read"], text: "I used mcp__cc__Bash" });
    expect(JSON.parse(strip(msg))).toEqual({ name: "Bash", tools: ["WebSearch", "Read"], text: "I used mcp__cc__Bash" });
  });
  test("widens hook matchers that name local tools", () => {
    expect(widenMatcher("Edit|Write")).toBe("Edit|Write|mcp__cc__Write|mcp__cc__Edit");
    expect(widenMatcher("WebFetch")).toBe("WebFetch");
    expect(widenMatcher("BashOutput")).toBe("BashOutput");
    expect(widenMatcher(undefined)).toBeUndefined();
  });
});

describe("projectKey", () => {
  test("matches claude's folder names, hashing long paths", () => {
    expect(projectKey("/no/such/dir_x.y")).toBe("-no-such-dir-x-y");
    const long = projectKey(`/no/${"a".repeat(250)}`);
    expect(long.slice(0, 200)).toBe(`-no-${"a".repeat(196)}`);
    expect(long).toMatch(/^.{200}-[0-9a-z]+$/);
  });
});

describe("rewriter", () => {
  const session = (mode = "default"): Session => ({ cwd: "/work/app", hostDir: ".cc-remote/ws/box/work/app", mode });
  const out = (s: Session, msg: object) => {
    const replies: string[] = [];
    const line = rewriter(s).outbound(JSON.stringify(msg), (r) => replies.push(r));
    return { msg: line === null ? null : JSON.parse(line), replies: replies.map((r) => JSON.parse(r)) };
  };

  test("maps the host folder back to the local directory", () => {
    const { msg } = out(session(), { type: "system", cwd: "/home/eric/.cc-remote/ws/box/work/app", note: "see /home/eric/.cc-remote/ws/box/work/app/src/a.ts and /work/apple" });
    expect(msg).toEqual({ type: "system", cwd: "/work/app", note: "see /work/app/src/a.ts and /work/apple" });
  });

  test("points transcript mirror frames at the local projects folder", () => {
    const { msg } = out(session(), { type: "transcript_mirror", filePath: "/home/eric/.claude/projects/-home-eric--cc-remote-ws-box-work-app/s1/subagents/agent-1.jsonl", entries: [] });
    expect(msg.filePath).toBe(join(projectsDir(), projectKey("/work/app"), "s1/subagents/agent-1.jsonl"));
  });

  test("approves local edits inside the directory under acceptEdits", () => {
    const ask = (file_path: string) => ({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "mcp__cc__Edit", input: { file_path } } });
    const asked = out(session(), ask("/work/app/a.ts")).msg.request;
    expect(asked.tool_name).toBe("Edit");
    expect(asked.permission_suggestions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    const inside = out(session("acceptEdits"), ask("a.ts"));
    expect(inside.msg).toBeNull();
    expect(inside.replies[0]).toEqual({ type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { file_path: "a.ts" } } } });
    expect(out(session("acceptEdits"), ask("/etc/passwd")).msg).not.toBeNull();
  });

  test("follows the permission mode and prefixes approved rules", () => {
    const s = session();
    const r = rewriter(s);
    r.inbound(JSON.stringify({ type: "control_request", request_id: "1", request: { subtype: "set_permission_mode", mode: "acceptEdits" } }));
    expect(s.mode).toBe("acceptEdits");
    const reply = r.inbound(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "2", response: {
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }, { toolName: "WebFetch", ruleContent: "domain:x" }], behavior: "allow", destination: "session" }, { type: "setMode", mode: "default", destination: "session" }],
    } } }));
    expect(JSON.parse(reply).response.response.updatedPermissions[0].rules.map((x: { toolName: string }) => x.toolName)).toEqual(["mcp__cc__Bash", "WebFetch"]);
    expect(s.mode).toBe("default");
  });
});

describe("Bash rules", () => {
  test("suggests a command prefix, never for compound commands", () => {
    expect(commandPrefix("npm test -- --watch")).toBe("npm test");
    expect(commandPrefix("ls -la")).toBe("ls");
    expect(commandPrefix("git status && rm -rf /")).toBeUndefined();
    expect(commandPrefix("echo $(whoami)")).toBeUndefined();
  });
  test("keeps approved prefixes here and approves matching commands", () => {
    // A temporary home and project: the approval is written to the project's settings.local.json.
    const iso = isolate();
    const cwd = mkdtempSync(join(tmpdir(), "cc-remote-rules-"));
    try {
      const s: Session = { cwd, hostDir: `.cc-remote/ws/box${cwd}`, mode: "default" };
      const r = rewriter(s);
      const ask = (command: string) => {
        const replies: string[] = [];
        const line = r.outbound(JSON.stringify({ type: "control_request", request_id: "q", request: { subtype: "can_use_tool", tool_name: "mcp__cc__Bash", input: { command }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "mcp__cc__Bash" }], behavior: "allow", destination: "localSettings" }] } }), (x) => replies.push(x));
        return { line: line && JSON.parse(line), replies };
      };
      const first = ask("npm test");
      expect(first.line.request.permission_suggestions[0].rules).toEqual([{ toolName: "Bash", ruleContent: "npm test:*" }]);
      const reply = r.inbound(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "q", response: { behavior: "allow", updatedPermissions: first.line.request.permission_suggestions } } }));
      expect(JSON.parse(reply).response.response.updatedPermissions).toEqual([]);
      expect(ask("npm test -- a.ts").line).toBeNull();
      expect(ask("npm testing").line).not.toBeNull();
      expect(ask("npm test; rm -rf ~").line).not.toBeNull();
      const local = join(cwd, ".claude", "settings.local.json");
      expect(existsSync(local) && readFileSync(local, "utf8")).toContain("Bash(npm test:*)");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      iso.restore();
    }
  });
});

describe("ssh", () => {
  test("adds keepalives after a custom ssh command, so its own -o options win", () => {
    const saved = Bun.env.CC_REMOTE_SSH;
    try {
      Bun.env.CC_REMOTE_SSH = "/usr/bin/ssh -o ServerAliveInterval=60 -p 2222";
      expect(rsh()).toEqual(["/usr/bin/ssh", "-o", "ServerAliveInterval=60", "-p", "2222", "-o", "Compression=yes", "-o", "ConnectTimeout=20", "-o", "IPQoS=none", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=20"]);
      Bun.env.CC_REMOTE_SSH = "tsh ssh";
      expect(rsh()).toEqual(["tsh", "ssh"]);
      delete Bun.env.CC_REMOTE_SSH;
      expect(rsh()).toContain("ServerAliveCountMax=20");
      expect(rsh()).toContain("ControlMaster=auto");
    } finally {
      if (saved === undefined) delete Bun.env.CC_REMOTE_SSH;
      else Bun.env.CC_REMOTE_SSH = saved;
    }
  });
  test("quotes for a POSIX shell", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`);
  });
  test("enters the host folder and passes the environment", () => {
    const cmd = remoteCommand(["--model", "x y"], { A: "1" }, "/work/app");
    expect(cmd).toContain("'.cc-remote/ws/");
    expect(cmd).toEndWith(`exec env 'A=1' claude '--model' 'x y'`);
  });
});
