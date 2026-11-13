import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authCache, authCommand, cachedAuth, forgetAuth, rememberAuth } from "../src/auth-cache";
import { fakeHost } from "./fakehost";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-auth-"));
const saved = { ...authCache };
afterAll(() => {
  Object.assign(authCache, saved);
  rmSync(dir, { recursive: true, force: true });
});

describe("auth status cache", () => {
  test("knows the probe, with global settings first, and what changes the login", () => {
    expect(authCommand(["auth", "status", "--json"])).toBe("status");
    expect(authCommand(["--settings", '{"apiKeyHelper":"x"}', "auth", "status", "--json"])).toBe("status");
    expect(authCommand(["--settings={}", "auth", "status"])).toBe("status");
    expect(authCommand(["auth", "login", "--claudeai"])).toBe("change");
    expect(authCommand(["auth", "logout"])).toBe("change");
    for (const args of [["--version"], ["auth"], ["mcp", "list"], ["--model", "x", "auth", "status"], []]) expect(authCommand(args)).toBeUndefined();
  });

  test("remembers each command line's answer for the TTL, privately, in a file of its own format", () => {
    authCache.dir = join(dir, "unit");
    const args = ["auth", "status", "--json"];
    rememberAuth("h", args, '{"loggedIn":true}', 0, 1_000);
    expect(cachedAuth("h", args, 1_000 + authCache.ttlMs - 1)).toEqual({ out: '{"loggedIn":true}', code: 0, at: 1_000 });
    expect(cachedAuth("h", args, 1_000 + authCache.ttlMs)).toBeUndefined();
    expect(cachedAuth("h", ["auth", "status"], 1_000)).toBeUndefined();
    expect(cachedAuth("other", args, 1_000)).toBeUndefined();
    const [name] = readdirSync(authCache.dir);
    expect(name).toStartWith("auth-status-v1-");
    expect(statSync(join(authCache.dir, name!)).mode & 0o777).toBe(0o600);
    expect(statSync(authCache.dir).mode & 0o777).toBe(0o700);
    const file = join(authCache.dir, name!);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), format: 2 }));
    expect(cachedAuth("h", args, 1_000)).toBeUndefined();
    rememberAuth("h", args, "{}", 1, 2_000);
    forgetAuth("h");
    expect(cachedAuth("h", args, 2_000)).toBeUndefined();
  });

  describe("through cc-remote", () => {
    const host = fakeHost(join(dir, "entry"));
    const cache = join(dir, "entry", "cache");
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    const run = (env: Record<string, string>, ...args: string[]) =>
      Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", ...args], {
        cwd: work, env: { ...Bun.env, ...host.env, XDG_CACHE_HOME: cache, ...env }, stdin: "ignore",
      });

    test("the shim's auth status costs one ssh round trip a minute; logging in or out through cc-remote forgets it", () => {
      host.reset();
      const first = run({}, "--cli", "auth", "status", "--json");
      expect(first.exitCode).toBe(0);
      expect(first.stdout.toString()).toStartWith("ARGS [auth] [status] [--json]");
      const again = run({}, "--cli", "auth", "status", "--json");
      expect(again.stdout.toString()).toBe(first.stdout.toString());
      // Orca's form of it shares the answer; other settings are another question.
      expect(run({}, "claude", "auth", "status", "--json").stdout.toString()).toBe(first.stdout.toString());
      expect(host.calls()).toHaveLength(1);
      run({}, "--cli", "--settings", '{"apiKeyHelper":"x"}', "auth", "status", "--json");
      expect(host.calls()).toHaveLength(2);
      run({}, "--cli", "auth", "logout");
      run({}, "--cli", "auth", "status", "--json");
      expect(host.calls()).toHaveLength(4);
      // The same host name through another ssh command is another cache.
      const ssh = join(dir, "bin", "other-ssh");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(ssh, `#!/bin/sh\nexec ${host.ssh} "$@"\n`);
      chmodSync(ssh, 0o755);
      run({ CC_REMOTE_SSH: ssh }, "--cli", "auth", "status", "--json");
      expect(host.calls()).toHaveLength(5);
    }, 30_000);

    test("probes that start together, as claude-agent-acp's do, share one round trip", async () => {
      host.reset();
      const slow = join(dir, "bin", "slow-ssh");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(slow, `#!/bin/sh\nsleep 0.5\nexec ${host.ssh} "$@"\n`);
      chmodSync(slow, 0o755);
      const outs = await Promise.all([1, 2, 3].map(async () => {
        const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "--host", "box", "--cli", "auth", "status", "--json"], {
          cwd: work, env: { ...Bun.env, ...host.env, XDG_CACHE_HOME: cache, CC_REMOTE_SSH: slow }, stdin: "ignore", stdout: "pipe",
        });
        return new Response(p.stdout).text();
      }));
      expect(outs[0]).toStartWith("ARGS [auth] [status] [--json]");
      expect(new Set(outs).size).toBe(1);
      expect(host.calls()).toHaveLength(1);
    }, 30_000);

    test("what ssh fails with is not remembered", () => {
      const failing = join(dir, "bin", "failing-ssh");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(failing, "#!/bin/sh\necho 'ssh: connect to host box port 22: Connection refused' >&2\nexit 255\n");
      chmodSync(failing, 0o755);
      expect(run({ CC_REMOTE_SSH: failing }, "--cli", "auth", "status", "--json").exitCode).toBe(255);
      expect(readdirSync(join(cache, "cc-remote")).filter((n) => n.startsWith("auth-status-") && n.includes(Bun.hash(`box\n${failing}`).toString(36)))).toEqual([]);
    });
  });
});
