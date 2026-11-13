import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantsSession, grantStore, loadGrants, resetGrants, saveGrants } from "../src/grants";
import { resetLocalSettings } from "../src/local-settings";
import { rewriter, type Session } from "../src/proxy";
import { settingsLocations } from "../src/rules";

const base = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-grants-")));
const ENV = ["CLAUDE_CONFIG_DIR", "HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
const saved = { env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])), managed: settingsLocations.managed, store: { ...grantStore } };
Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(base, "config"), HOME: join(base, "home"), GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
settingsLocations.managed = join(base, "managed");
afterAll(() => {
  for (const k of ENV) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  settingsLocations.managed = saved.managed;
  Object.assign(grantStore, saved.store);
  resetLocalSettings();
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  grantStore.dir = join(base, `store-${++n}`, "grants", "v1");
  resetGrants();
});

const ID = "741f7a4e-c84b-4612-a796-478b87521238";
const project = join(base, "project");

describe("session grants", () => {
  test("the session a command line names, unless a fork starts a new one", () => {
    expect(grantsSession(["--resume", ID])).toBe(ID);
    expect(grantsSession([`--session-id=${ID}`])).toBe(ID);
    expect(grantsSession(["-r", ID, "--fork-session"])).toBeUndefined();
    expect(grantsSession(["--resume", "a", "--fork-session", "--session-id", ID])).toBe(ID);
    expect(grantsSession(["--resume", "../../etc/passwd"])).toBeUndefined();
    expect(grantsSession(["--model", "x"])).toBeUndefined();
  });

  test("kept per session in a private file, merged with what another process saved", () => {
    saveGrants(ID, project, ["Bash(npm test:*)"]);
    saveGrants(ID, project, ["Bash(make:*)"]);
    expect(loadGrants(ID, project)).toEqual(["Bash(npm test:*)", "Bash(make:*)"]);
    const file = join(grantStore.dir, `${ID}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(grantStore.dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ format: 1, sessionId: ID, cwd: project });
    expect(readdirSync(grantStore.dir)).toEqual([`${ID}.json`]);
    // Another directory, another session, or a format this cc-remote doesn't know: none.
    expect(loadGrants(ID, join(base, "elsewhere"))).toEqual([]);
    expect(loadGrants("other", project)).toEqual([]);
    writeFileSync(file, JSON.stringify({ format: 2, sessionId: ID, cwd: project, grants: ["Bash(x)"] }));
    expect(loadGrants(ID, project)).toEqual([]);
    writeFileSync(file, "{oops");
    expect(loadGrants(ID, project)).toEqual([]);
  });

  test("a file left unused for the TTL is gone, and using one keeps it", () => {
    const now = Date.now();
    saveGrants(ID, project, ["Bash(npm test:*)"], now);
    saveGrants("old", project, ["Bash(make:*)"], now);
    const old = (now - grantStore.ttlMs - 1_000) / 1000;
    utimesSync(join(grantStore.dir, "old.json"), old, old);
    expect(loadGrants("old", project, now)).toEqual([]);
    resetGrants();
    saveGrants("new", project, [], now);
    expect(readdirSync(grantStore.dir).sort()).toEqual([`${ID}.json`, "new.json"]);
    const before = (now - 60_000) / 1000;
    utimesSync(join(grantStore.dir, `${ID}.json`), before, before);
    expect(loadGrants(ID, project, now)).toEqual(["Bash(npm test:*)"]);
    expect(statSync(join(grantStore.dir, `${ID}.json`)).mtimeMs).toBeGreaterThan(now - 1_000);
  });

  test("allow for this session holds in the next claude process for the same session, as after Orca switches a chat's mode", () => {
    const session = (sessionId?: string): Session => ({ cwd: project, hostDir: `.cc-remote/ws/box${project}`, mode: "default", sessionId });
    const ask = (r: ReturnType<typeof rewriter>, command: string) =>
      r.outbound(JSON.stringify({ type: "control_request", request_id: "q", request: { subtype: "can_use_tool", tool_name: "mcp__cc__Bash", input: { command } } }), () => {});
    const first = rewriter(session(ID));
    first.inbound(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "q", response: { behavior: "allow", updatedInput: {}, updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make build:*" }], behavior: "allow", destination: "session" },
    ] } } }));
    expect(ask(first, "make build")).toBeNull();
    // A new process for the session, as `--resume <id>` starts it, has it from the start.
    expect(ask(rewriter(session(ID)), "make build -j4")).toBeNull();
    // Another session doesn't.
    expect(ask(rewriter(session("other")), "make build")).not.toBeNull();
    // A session known only from claude's init message gets it once claude names it.
    const late = rewriter(session());
    expect(ask(late, "make build")).not.toBeNull();
    late.outbound(JSON.stringify({ type: "system", subtype: "init", session_id: ID, permissionMode: "default", cwd: project }), () => {});
    expect(ask(late, "make build")).toBeNull();
  });
});
