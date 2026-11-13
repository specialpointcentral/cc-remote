import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type Answer, runSetup, snapshot, world, type World } from "./setup-world";

/**
 * `cc-remote setup` run whole, in this process, against a fake central server, a fake Orca Server
 * and stub package tools, with keystrokes typed at its prompts. No network, no model, no real
 * home: see setup-world.ts.
 */
let worlds: World[] = [];
const make = (...args: Parameters<typeof world>) => {
  const w = world(...args);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds) w.cleanup();
  worlds = [];
});

const marker = (w: World) => join(w.host.home, ".cc-remote", "machines", `${hostname()}.json`);
const state = (w: World) => JSON.parse(readFileSync(w.file(".config", "cc-remote", "setup-state.json"), "utf8"));
const yes = (expect: RegExp): Answer => ({ expect, keys: ["\r"] });

describe("first run at a terminal", () => {
  test("checks, connects, fixes ssh-agent dependence, saves, configures Orca and verifies", async () => {
    const w = make({ orca: true });
    // An existing key, so cc-remote gets a key of its own named in a managed block.
    writeFileSync(w.file(".ssh", "id_rsa"), "not a real key", { mode: 0o600 });
    const r = await runSetup(w, [], {
      tty: true,
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock", FAKE_AGENTLESS_DENY: "1" },
      answers: [
        { expect: /Run `sudo apt-get install -y ripgrep git` now\? sudo may ask for your password\. \[y\/N\] $/, keys: ["\r"] },
        { expect: /Central server \(ssh host, user@host or ~\/\.ssh\/config alias\) \[central\]: $/, keys: ["cen", "\t", "\r"] },
        yes(/Create ~\/\.ssh\/cc-remote_ed25519 \(no passphrase\) for cc-remote and copy it to central\? \[Y\/n\] $/),
        yes(/Save central as the default server \(~\/\.config\/cc-remote\/host\)\? \[Y\/n\] $/),
        yes(/Set Orca's Claude Command\? .*\[Y\/n\] $/),
        yes(/Set Claude chats in Orca to permission mode auto\? \[Y\/n\] $/),
        yes(/Copy CC_REMOTE_SSH from this shell into Orca's Claude environment\? \[Y\/n\] $/),
      ],
    });
    expect(r.left).toBe(0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[1/7]");
    expect(w.orca!.settings.agentDefaultEnv.claude?.CC_REMOTE_SSH).toBe(w.host.ssh);
    expect(r.out).toContain("Install: sudo apt-get install -y ripgrep");
    expect(r.out).toContain("1) central");
    expect(r.out).toContain("works through ssh-agent only; Orca Server has no ssh-agent");
    expect(r.out).toContain("works without ssh-agent now");
    expect(r.out).toContain("Claude Command now:  (Orca's default: claude)");
    expect(r.out).toMatch(/\[7\/7\] ✓ Verifying as Orca runs it\s+\d+s — 2\.1\.323 \(Claude Code\), live, without ssh-agent/);
    expect(r.out).toContain("── Summary");

    // Nothing was installed: the [y/N] question was answered with Enter.
    expect(w.calls().filter((c) => c.startsWith("sudo") || c.startsWith("apt-get"))).toEqual([]);
    // The host file, private.
    expect(readFileSync(w.file(".config", "cc-remote", "host"), "utf8")).toBe("central\n");
    expect(statSync(w.file(".config", "cc-remote", "host")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(w.file(".config", "cc-remote", "setup-history.json"), "utf8"))).toEqual({ version: 1, host: ["central"] });
    // The key, copied with ssh-copy-id, and named in a managed block; the old config backed up.
    expect(existsSync(w.file(".ssh", "cc-remote_ed25519"))).toBe(true);
    expect(w.calls()).toContainEqual(expect.stringMatching(/^ssh-copy-id -i .*cc-remote_ed25519\.pub central$/));
    const config = readFileSync(w.file(".ssh", "config"), "utf8");
    expect(config).toContain("# >>> cc-remote setup >>>\nHost central\n    IdentityFile ~/.ssh/cc-remote_ed25519\n    IdentitiesOnly yes\n# <<< cc-remote setup <<<");
    expect(config.startsWith("Host central\n    HostName 203.0.113.7")).toBe(true);
    const backups = readdirSync(w.file(".ssh")).filter((f) => f.startsWith("config.cc-remote-"));
    expect(backups).toHaveLength(1);
    expect(statSync(w.file(".ssh", backups[0]!)).mode & 0o777).toBe(0o600);
    // Orca: the stable path, Claude-only permission override, no global change.
    expect(w.orca!.settings.agentCmdOverrides.claude).toBe(`${w.stable} claude`);
    expect(w.orca!.settings.agentPermissionOverrides).toEqual({ claude: "auto" });
    expect(w.orca!.settings.agentPermissionDefault).toBe("full-access");
    expect(w.orca!.calls.some((c) => c.method === "settings.update")).toBe(false);
    // The marker on the central server holds this machine's id; the previous values are recorded.
    const s = state(w);
    expect(JSON.parse(readFileSync(marker(w), "utf8")).machineId).toBe(s.machineId);
    const actions = Object.fromEntries(s.actions.map((a: { id: string }) => [a.id, a]));
    expect(actions["local.hostfile"]).toMatchObject({ previous: null, value: "central" });
    expect(actions["orca.claude-command"]).toMatchObject({ previous: null, value: `${w.stable} claude`, ok: true });
    expect(actions["orca.permission"]).toMatchObject({ model: "agent-permission", previousOverride: null, previousDefault: "full-access", value: "auto", ok: true });
    expect(actions["ssh.keygen"].value).toEndWith("cc-remote_ed25519");
    expect(actions["ssh.config-block"].backup).toContain("config.cc-remote-");
    expect(actions["remote.marker"]).toBeDefined();
  }, 60_000);

  test("a re-run asks only for the server, Enter accepts, and changes nothing", async () => {
    const w = make({ orca: true, tools: ["sh", "bash", "grep", "ssh-keygen", "rg", "git"] });
    expect((await runSetup(w, ["--yes", "--host", "central", "--orca-env"])).code).toBe(0);
    const mutations = w.orca!.mutations().length;
    const r = await runSetup(w, [], { tty: true, answers: [{ expect: /Central server \[central\]: $/, keys: ["\r"] }] });
    expect(r.code).toBe(0);
    expect(r.left).toBe(0);
    expect(r.out.match(/\[Y\/n\]|\[y\/N\]/g)).toBeNull();
    expect(r.out).toContain("(last run ");
    expect(r.out).toMatch(/\[5\/7\] ✓ Saving settings\s+\d+s — nothing changed/);
    expect(r.out).toContain("Orca Server: Claude Command and permission mode already set");
    expect(w.orca!.mutations()).toHaveLength(mutations);
  }, 60_000);

  test("Up browses the server history and Tab completes after user@", async () => {
    const w = make({ tools: ["sh", "bash", "grep", "rg", "git"] });
    writeFileSync(w.file(".ssh", "known_hosts"), "|1|hashed= ssh-ed25519 AAAA\n[box.example]:2222 ssh-ed25519 AAAA\n");
    const r = await runSetup(w, [], {
      tty: true,
      env: { FAKE_SSH_FAIL: "refused" },
      answers: [{ expect: /alias\) \[central\]: $/, keys: ["me@cen", "\t", "\r"] }],
    });
    expect(r.left).toBe(0);
    expect(r.out).toContain("Central server: me@central");
    expect(r.out).toContain("ssh://box.example:2222");
    expect(r.out).toContain("the connection was refused");
    expect(r.code).toBe(1);
  }, 30_000);
});

describe("aborts on claude", () => {
  const cases: [string, (w: World) => Record<string, string>, RegExp][] = [
    ["missing", (w) => {
      renameSync(join(w.host.home, ".local", "bin", "claude"), join(w.dir, "claude-gone"));
      return {};
    }, /claude was not found on central \(looked in ~\/\.local\/bin and the non-interactive PATH\)\. Install Claude Code there/],
    ["only in the login shell", (w) => {
      const alt = join(w.dir, "alt");
      renameSync(join(w.host.home, ".local", "bin"), alt);
      const shell = join(w.dir, "login-shell");
      writeFileSync(shell, `#!/bin/sh\n[ "$1" = -lc ] && shift\nPATH="${alt}:$PATH" exec sh -c "$1"\n`, { mode: 0o755 });
      return { FAKE_LOGIN_SHELL: shell };
    }, /claude is at .*\/alt\/claude on central but not on the PATH ssh commands get\. On central: `ln -s .*\/alt\/claude ~\/\.local\/bin\/claude`/],
    ["too old", () => ({ FAKE_CLAUDE_VERSION: "2.1.200" }), /claude on central is 2\.1\.200, older than the 2\.1\.268 cc-remote needs\. Run `claude update` on central, then run setup again\./],
    ["not logged in", () => ({ FAKE_AUTH_STATUS: "out" }), /Setup stopped: cc-remote needs a logged-in claude on central, and setup doesn't install or log in claude\.[\s\S]*cc-remote --host central --cli auth login/],
  ];
  for (const [name, arrange, message] of cases) {
    test(`claude ${name}: stops after step 4 with a hint; no host file, marker or Orca call`, async () => {
      const w = make({ orca: true });
      const env = arrange(w);
      const r = await runSetup(w, ["--yes", "--host", "central"], { env });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(message);
      expect(r.out).toContain("Nothing was changed on this machine or in Orca.");
      expect(r.out).not.toContain("[5/7]");
      expect(existsSync(w.file(".config", "cc-remote", "host"))).toBe(false);
      expect(existsSync(join(w.host.home, ".cc-remote"))).toBe(false);
      expect(w.orca!.calls).toEqual([]);
    }, 30_000);
  }
});

describe("--check", () => {
  test("changes nothing: the trees are the same before and after, no Orca change, no installs", async () => {
    const w = make({ orca: true });
    expect((await runSetup(w, ["--yes", "--host", "central"])).code).toBe(0);
    w.host.reset();
    const before = [snapshot(w.home), snapshot(w.host.home)];
    const mutations = w.orca!.mutations().length;
    const r = await runSetup(w, ["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[1/5] This machine...");
    expect(r.out).toContain("[5/5] ✓ End to end");
    expect(r.out).toContain("hint: sudo apt-get install -y ripgrep; --check installs nothing");
    expect([snapshot(w.home), snapshot(w.host.home)]).toEqual(before);
    expect(w.orca!.mutations()).toHaveLength(mutations);
    expect(w.calls().filter((c) => /^(sudo|apt-get|ssh-copy-id)/.test(c))).toEqual([]);
    // Only the probes and version checks went over ssh, never the save script.
    expect(w.host.calls().every((c) => !c.includes("RESULT"))).toBe(true);
  }, 60_000);

  test("reports a logged-out claude with its fix and fails, skipping end to end", async () => {
    const w = make({ orca: true });
    const r = await runSetup(w, ["--check", "--host", "central"], { env: { FAKE_AUTH_STATUS: "out" } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[3\/5\] ✗ central \(\d+s\): claude not logged in/);
    expect(r.out).toContain("Fix (on central, by you): cc-remote --cli auth login");
    expect(r.out).toMatch(/\[4\/5\] ⚠ Orca \(\d+s\): ⚠ Claude Command is claude/);
    expect(r.out).toMatch(/\[5\/5\] ✗ End to end \(\d+s\): skipped: central isn't ready/);
    expect(r.out).not.toContain("Setup stopped");
    expect(w.orca!.mutations()).toEqual([]);
    expect(existsSync(w.file(".config", "cc-remote"))).toBe(false);
  }, 30_000);
});

describe("unattended", () => {
  test("--yes alone never installs: it shows the command --install would run", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--host", "central"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("not installing (add --install to run: sudo -n apt-get install -y ripgrep git)");
    expect(w.calls()).toEqual([]);
  }, 30_000);

  test("--yes --install installs with sudo -n, then checks again", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--install", "--host", "central"]);
    expect(r.code).toBe(0);
    expect(w.calls()).toEqual(["sudo -n apt-get install -y ripgrep git", "apt-get install -y ripgrep git"]);
    expect(r.out).toContain("$ sudo -n apt-get install -y ripgrep git");
    expect(r.out).toContain("ripgrep 13.0.0 (running cc-remote sessions pick it up when restarted)");
  }, 30_000);

  test("at a terminal, [y/N] answered y runs the exact command with sudo", async () => {
    const w = make();
    const r = await runSetup(w, ["--host", "central"], {
      tty: true,
      answers: [
        { expect: /Run `sudo apt-get install -y ripgrep git` now\?.*\[y\/N\] $/, keys: ["y", "\r"] },
        yes(/Save central as the default server.*\[Y\/n\] $/),
      ],
    });
    expect(r.code).toBe(0);
    expect(r.left).toBe(0);
    expect(w.calls()[0]).toBe("sudo apt-get install -y ripgrep git");
  }, 30_000);

  test("--yes leaves a custom Claude Command and permission mode alone; --orca set replaces the command only", async () => {
    const w = make({ orca: true });
    w.orca!.settings.agentCmdOverrides.claude = "/opt/my-claude --flag";
    w.orca!.settings.agentPermissionOverrides.claude = "ask";
    let r = await runSetup(w, ["--yes", "--host", "central"]);
    expect(r.code).toBe(0);
    expect(w.orca!.mutations()).toEqual([]);
    expect(r.out).toContain("Claude Command is /opt/my-claude --flag (custom), not this install");
    r = await runSetup(w, ["--yes", "--host", "central", "--orca", "set"]);
    expect(w.orca!.settings.agentCmdOverrides.claude).toBe(`${w.stable} claude`);
    expect(w.orca!.settings.agentPermissionOverrides.claude).toBe("ask");
    const actions = state(w).actions.filter((a: { id: string }) => a.id === "orca.claude-command");
    expect(actions.at(-1)).toMatchObject({ previous: "/opt/my-claude --flag" });
  }, 60_000);

  test("--yes replaces an older cc-remote path and Orca's default permission; --orca skip touches nothing", async () => {
    const w = make({ orca: true });
    w.orca!.settings.agentCmdOverrides.claude = "/home/me/.bun/bin/cc-remote --host old claude";
    expect((await runSetup(w, ["--yes", "--host", "central", "--orca", "skip"])).code).toBe(0);
    expect(w.orca!.mutations()).toEqual([]);
    expect((await runSetup(w, ["--yes", "--host", "central"])).code).toBe(0);
    expect(w.orca!.settings.agentCmdOverrides.claude).toBe(`${w.stable} claude`);
    expect(w.orca!.settings.agentPermissionOverrides.claude).toBe("auto");
  }, 60_000);

  test("legacy Orca settings take the permission through settings.update", async () => {
    const w = make({ orca: { legacy: true } });
    const r = await runSetup(w, ["--yes", "--host", "central"]);
    expect(r.code).toBe(0);
    const update = w.orca!.calls.find((c) => c.method === "settings.update");
    expect(update?.params).toEqual({ nativeChatPermissionMode: "auto" });
    expect(state(w).actions.find((a: { id: string }) => a.id === "orca.permission")).toMatchObject({ model: "legacy", previous: "full-access", value: "auto" });
  }, 30_000);

  test("central's claude without auto: the permission mode is left alone", async () => {
    const w = make({ orca: true });
    const r = await runSetup(w, ["--yes", "--host", "central"], { env: { FAKE_HELP: "noauto" } });
    expect(r.code).toBe(0);
    expect(w.orca!.settings.agentPermissionOverrides).toEqual({});
    expect(w.orca!.settings.agentCmdOverrides.claude).toBe(`${w.stable} claude`);
  }, 30_000);

  test("--orca-env copies CC_REMOTE_SSH into Orca's Claude environment, by name", async () => {
    const w = make({ orca: true });
    const r = await runSetup(w, ["--yes", "--host", "central", "--orca-env"]);
    expect(r.code).toBe(0);
    expect(w.orca!.settings.agentDefaultEnv.claude?.CC_REMOTE_SSH).toBe(w.host.ssh);
    expect(state(w).actions.find((a: { id: string }) => a.id === "orca.env")).toMatchObject({ names: ["CC_REMOTE_SSH"] });
  }, 30_000);
});

describe("ssh problems", () => {
  test("an unknown host key: OpenSSH's own prompt at a terminal, then it connects", async () => {
    const w = make({ tools: ["sh", "bash", "grep", "rg", "git"] });
    const r = await runSetup(w, ["--host", "central"], {
      tty: true,
      env: { FAKE_SSH_FAIL: "hostkey" },
      answers: [yes(/Let OpenSSH show the fingerprint and ask you to trust it\? \[Y\/n\] $/), yes(/Save central as the default server.*\[Y\/n\] $/)],
    });
    expect(r.left).toBe(0);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[3\/7\] ✗ Connecting to central\s+\d+s — the server's host key isn't trusted yet/);
    expect(r.out).toMatch(/\[3\/7\] ✓ Connecting to central/);
    expect(w.host.calls().some((c) => c.includes("StrictHostKeyChecking=ask"))).toBe(true);
  }, 30_000);

  test("unattended, an unknown host key needs --accept-new-host-key", async () => {
    const w = make();
    let r = await runSetup(w, ["--yes", "--host", "central"], { env: { FAKE_SSH_FAIL: "hostkey" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("pass --accept-new-host-key");
    r = await runSetup(w, ["--yes", "--host", "central", "--accept-new-host-key"], { env: { FAKE_SSH_FAIL: "hostkey" } });
    expect(r.code).toBe(0);
    expect(w.host.calls().some((c) => c.includes("StrictHostKeyChecking=accept-new"))).toBe(true);
  }, 30_000);

  test("a changed host key is a hard failure, never accepted", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--host", "central", "--accept-new-host-key"], { env: { FAKE_SSH_FAIL: "changed" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("central's host key has CHANGED");
    expect(r.out).toContain("ssh-keygen -R central");
    expect(w.host.calls().some((c) => c.includes("StrictHostKeyChecking=ask"))).toBe(false);
  }, 30_000);

  test("a name that doesn't resolve suggests close ones", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--host", "centrl"], { env: { FAKE_SSH_FAIL: "dns" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("centrl doesn't resolve");
    expect(r.out).toContain("Did you mean: central?");
  }, 30_000);

  test("--host with ssh flags is refused with the ssh:// form to use", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--host", "-p 2222 me@h"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("use --host ssh://me@h:2222");
  }, 30_000);
});

describe("--smoke", () => {
  test("sends one tiny prompt through Orca's command, and reports what came back", async () => {
    const w = make({ tools: ["sh", "bash", "grep", "rg", "git"] });
    const r = await runSetup(w, ["--yes", "--host", "central", "--smoke"]);
    // The fake claude echoes its arguments instead of answering.
    expect(r.code).toBe(1);
    expect(r.out).toContain("the test prompt got: ARGS [-p] [Reply with exactly: OK]");
    expect(w.host.calls().some((c) => c.includes("'Reply with exactly: OK'"))).toBe(true);
  }, 30_000);
});

describe("language", () => {
  test("--lang zh speaks Chinese", async () => {
    const w = make({ tools: ["sh", "bash", "grep", "rg", "git"] });
    const r = await runSetup(w, ["--yes", "--host", "central", "--lang", "zh"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("检查本机");
    expect(r.out).toContain("中心服务器: central");
    expect(r.out).toContain("按 Orca 的方式验证");
  }, 30_000);

  test("the locale picks Chinese too, and abort messages follow it", async () => {
    const w = make();
    const r = await runSetup(w, ["--yes", "--host", "central"], { env: { LANG: "zh_CN.UTF-8", FAKE_AUTH_STATUS: "out" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("setup 已停止：cc-remote 需要 central 上已登录的 claude");
    expect(r.out).toContain("本机和 Orca 中没有做任何改动。");
  }, 30_000);
});
