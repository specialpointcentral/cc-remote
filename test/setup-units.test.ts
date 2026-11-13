import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEntry } from "../src/setup/actions/ssh";
import {
  commandDecision, envDecision, hostFileDecision, hostKeyDecision, installDecision, type Mode, type Options, parseArgs, permissionDecision, sshKeyDecision,
  UsageError,
} from "../src/setup/args";
import { remoteChecks } from "../src/setup/checks/remote";
import { lock, readPrivateJson, writePrivateJson } from "../src/setup/files";
import { pushHistory, readHistory } from "../src/setup/history";
import { call, inspect, normalizeCommand, permissionOf, profileCandidates, validateCommand, versionSupport } from "../src/setup/orca";
import { chooseManager, installPlan, type Machine, mergePlans, parseOsRelease } from "../src/setup/os";
import { classifySsh, parseAuth, parseProbe, parseSshd, probeScript, saveScript } from "../src/setup/remote-probe";
import { commandKind } from "../src/setup/steps/orca";
import { cleanHost, closest, completer, knownHosts, parseFlagged, sshConfigHosts } from "../src/setup/suggest";
import { detectLang } from "../src/setup/ui/i18n";
import { Progress } from "../src/setup/ui/progress";
import { Term } from "../src/setup/ui/term";
import { cachedVersion, rememberVersion, versionCache } from "../src/version";
import { fakeOrca } from "./fakeorca";

const dir = mkdtempSync(join(tmpdir(), "ccr-units-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opts = (argv: string[] = []): Options => parseArgs(argv);
const TTY: Mode = { interactive: true, check: false };
const BATCH: Mode = { interactive: false, check: false };
const CHECK: Mode = { interactive: false, check: true };

describe("flags and consent", () => {
  test("parses flags in both forms and refuses bad ones", () => {
    const o = parseArgs(["--host=central", "-y", "--orca", "set", "--ssh-key=generate", "--lang", "zh", "-v"]);
    expect(o).toMatchObject({ host: "central", yes: true, orca: "set", sshKey: "generate", lang: "zh", verbose: true });
    expect(() => parseArgs(["--orca", "maybe"])).toThrow(UsageError);
    expect(() => parseArgs(["--frobnicate"])).toThrow(UsageError);
    expect(() => parseArgs(["--host"])).toThrow(UsageError);
    expect(() => parseArgs(["--check", "--install"])).toThrow(UsageError);
    expect(parseArgs([], { CC_REMOTE_NO_PROGRESS: "1", CC_REMOTE_ORCA_PROFILE: "/p" })).toMatchObject({ noProgress: true, orcaProfile: "/p" });
  });

  test("--yes never installs; only --install does unattended; a terminal always asks [y/N]; --check never", () => {
    expect(installDecision(opts(["--yes"]), BATCH)).toBe("skip");
    expect(installDecision(opts(["--yes", "--install"]), BATCH)).toBe("do");
    expect(installDecision(opts(["--install"]), TTY)).toBe("ask-no");
    expect(installDecision(opts([]), TTY)).toBe("ask-no");
    expect(installDecision(opts(["--install"]), CHECK)).toBe("skip");
  });

  test("the Claude Command changes unattended only from Orca's default or another cc-remote, unless --orca set", () => {
    expect(commandDecision(opts(), BATCH, "default")).toBe("do");
    expect(commandDecision(opts(), BATCH, "cc-remote")).toBe("do");
    expect(commandDecision(opts(), BATCH, "custom")).toBe("skip");
    expect(commandDecision(opts(["--orca", "set"]), BATCH, "custom")).toBe("do");
    expect(commandDecision(opts(["--orca", "skip"]), BATCH, "default")).toBe("skip");
    expect(commandDecision(opts(), TTY, "custom")).toBe("ask-no");
    expect(commandDecision(opts(), TTY, "default")).toBe("ask-yes");
    expect(commandDecision(opts(), BATCH, "ours")).toBe("skip");
    expect(commandDecision(opts(["--orca", "set"]), CHECK, "custom")).toBe("skip");
  });

  test("permission mode auto changes unattended only from Orca's default, even with --orca set", () => {
    const def = { current: "full-access", isDefault: true };
    const custom = { current: "ask", isDefault: false };
    expect(permissionDecision(opts(), BATCH, def, true)).toBe("do");
    expect(permissionDecision(opts(["--orca", "set"]), BATCH, custom, true)).toBe("skip");
    expect(permissionDecision(opts(), TTY, custom, true)).toBe("ask-no");
    expect(permissionDecision(opts(), TTY, def, true)).toBe("ask-yes");
    expect(permissionDecision(opts(), BATCH, def, false)).toBe("skip");
    expect(permissionDecision(opts(["--orca-permission", "keep"]), TTY, def, true)).toBe("skip");
    expect(permissionDecision(opts(["--orca", "skip"]), BATCH, def, true)).toBe("skip");
    expect(permissionDecision(opts(), BATCH, { current: "auto", isDefault: false }, true)).toBe("skip");
  });

  test("the rest: host file, host keys, ssh keys, environment", () => {
    expect(hostFileDecision(TTY, undefined, "c")).toBe("ask-yes");
    expect(hostFileDecision(TTY, "c", "c")).toBe("skip");
    expect(hostFileDecision(BATCH, "old", "c")).toBe("do");
    expect(hostFileDecision(CHECK, undefined, "c")).toBe("skip");
    expect(hostKeyDecision(opts(), BATCH)).toBe("skip");
    expect(hostKeyDecision(opts(["--accept-new-host-key"]), BATCH)).toBe("accept-new");
    expect(hostKeyDecision(opts(["--accept-new-host-key"]), CHECK)).toBe("skip");
    expect(sshKeyDecision(opts(), BATCH)).toBe("skip");
    expect(sshKeyDecision(opts(["--ssh-key", "generate"]), BATCH)).toBe("do");
    expect(sshKeyDecision(opts(["--ssh-key", "skip"]), TTY)).toBe("skip");
    expect(envDecision(opts(), BATCH)).toBe("skip");
    expect(envDecision(opts(["--orca-env"]), BATCH)).toBe("do");
  });
});

describe("language", () => {
  test("--lang, then CC_REMOTE_LANG, then the locale; zh* is Chinese", () => {
    expect(detectLang({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(detectLang({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(detectLang({ LC_ALL: "", LC_MESSAGES: "zh_TW.UTF-8" })).toBe("zh");
    expect(detectLang({ CC_REMOTE_LANG: "en", LANG: "zh_CN" })).toBe("en");
    expect(detectLang({ LANG: "zh_CN" }, "en")).toBe("en");
    expect(detectLang({})).toBe("en");
  });
});

describe("install commands", () => {
  const machine = (platform: NodeJS.Platform, release: string, has: string[], root = false): Machine => ({ platform, ...parseOsRelease(release), root, has: (c) => has.includes(c) });

  test("os-release picks the manager, confirmed on PATH", () => {
    expect(chooseManager(machine("linux", "ID=ubuntu\nID_LIKE=debian", ["apt-get"]))).toBe("apt-get");
    expect(chooseManager(machine("linux", "ID=rocky\nID_LIKE=\"rhel centos fedora\"", ["dnf", "yum"]))).toBe("dnf");
    expect(chooseManager(machine("linux", "ID=linuxmint\nID_LIKE=ubuntu", ["apt-get"]))).toBe("apt-get");
    expect(chooseManager(machine("linux", "ID=weird", ["zypper"]))).toBe("zypper");
    expect(chooseManager(machine("darwin", "", ["port"]))).toBe("port");
    expect(chooseManager(machine("win32", "", ["scoop", "choco"]))).toBe("scoop");
  });

  test("the exact command per OS, with sudo, sudo -n or none", () => {
    const cases: [Machine, string, string][] = [
      [machine("linux", "ID=debian", ["apt-get"]), "ripgrep", "sudo apt-get install -y ripgrep"],
      [machine("linux", "ID=ubuntu\nID_LIKE=debian", ["apt-get"]), "ssh", "sudo apt-get install -y openssh-client"],
      [machine("linux", "ID=fedora", ["dnf"]), "ssh", "sudo dnf install -y openssh-clients"],
      [machine("linux", "ID=rhel", ["dnf"]), "ripgrep", "sudo dnf install -y epel-release && sudo dnf install -y ripgrep"],
      [machine("linux", "ID=arch", ["pacman"]), "git", "sudo pacman -S --needed --noconfirm git"],
      [machine("linux", "ID=alpine", ["apk"]), "bash", "sudo apk add bash"],
      [machine("linux", "ID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"", ["zypper"]), "ripgrep", "sudo zypper install -y ripgrep"],
      [machine("linux", "ID=debian", ["apt-get"], true), "git", "apt-get install -y git"],
      [machine("darwin", "", ["brew"]), "ripgrep", "brew install ripgrep"],
      [machine("darwin", "", ["brew"]), "git", "xcode-select --install"],
      [machine("win32", "", ["winget"]), "ripgrep", "winget install --id BurntSushi.ripgrep.MSVC -e"],
      [machine("win32", "", ["winget"]), "git", "winget install --id Git.Git -e"],
    ];
    for (const [m, pkg, text] of cases) expect(installPlan(pkg as never, m).text).toBe(text);
    expect(installPlan("ripgrep", machine("linux", "ID=debian", ["apt-get"]), true).text).toBe("sudo -n apt-get install -y ripgrep");
    expect(installPlan("ripgrep", machine("win32", "", ["winget"]), true).text).toBe("winget install --id BurntSushi.ripgrep.MSVC -e --accept-source-agreements --accept-package-agreements");
  });

  test("advice only where cc-remote must not install: macOS without brew, Windows' ssh", () => {
    const noBrew = installPlan("ripgrep", machine("darwin", "", []));
    expect(noBrew.steps).toEqual([]);
    expect(noBrew.text).toContain("brew.sh");
    expect(installPlan("ssh", machine("win32", "", ["winget"])).text).toContain("Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0");
    expect(installPlan("ssh", machine("darwin", "", ["brew"])).steps).toEqual([]);
  });

  test("plans of one manager merge into one command", () => {
    const m = machine("linux", "ID=debian", ["apt-get"]);
    expect(mergePlans([installPlan("ripgrep", m), installPlan("git", m)]).map((p) => p.text)).toEqual(["sudo apt-get install -y ripgrep git"]);
    const rhel = machine("linux", "ID=rhel", ["dnf"]);
    expect(mergePlans([installPlan("ripgrep", rhel), installPlan("git", rhel)]).map((p) => p.text)).toEqual(["sudo dnf install -y epel-release && sudo dnf install -y ripgrep", "sudo dnf install -y git"]);
    const mac = machine("darwin", "", ["brew"]);
    expect(mergePlans([installPlan("ripgrep", mac), installPlan("git", mac)]).map((p) => p.text)).toEqual(["brew install ripgrep", "xcode-select --install"]);
  });
});

describe("suggestions", () => {
  const home = join(dir, "suggest");
  mkdirSync(join(home, ".ssh", "conf.d"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), `# comment
Host central  other # trailing
HOST *.example !bad
Include conf.d/*.conf
Match host x
  Host inside-match-is-still-a-name
host=equals
`);
  writeFileSync(join(home, ".ssh", "conf.d", "a.conf"), "Host from-include\nInclude ~/.ssh/config\n");

  test("ssh config: Host names, Include globs, no patterns, any case, no loops", () => {
    expect(sshConfigHosts(home)).toEqual(["central", "other", "from-include", "inside-match-is-still-a-name", "equals"]);
  });

  test("known_hosts: hashed, revoked and CA lines skipped; [h]:p becomes ssh://h:p", () => {
    expect(knownHosts("|1|abc= ssh-ed25519 K\n@revoked bad ssh-rsa K\n@cert-authority *.x ssh-rsa K\nbox,10.0.0.5 ssh-ed25519 K\n[h.example]:2222 ssh-ed25519 K\n[std]:22 ssh-ed25519 K\n*.wild ssh-rsa K\n"))
      .toEqual(["box", "10.0.0.5", "ssh://h.example:2222", "std"]);
  });

  test("completion by prefix, and the host part after user@", () => {
    const list = [{ value: "central", source: "ssh config" as const }, { value: "wei@cenpi", source: "history" as const }, { value: "other", source: "known_hosts" as const }];
    expect(completer(list)("cen")[0]).toEqual(["central"]);
    expect(completer(list)("me@cen")[0]).toEqual(["me@central", "me@cenpi"]);
    expect(completer(list)("x")[0]).toEqual([]);
  });

  test("cleaning a pasted value, and flags taken apart", () => {
    expect(cleanHost("  ssh  me@central​﻿ ")).toBe("me@central");
    expect(cleanHost("　central　")).toBe("central");
    expect(parseFlagged("-p 2222 me@h")).toEqual({ user: "me", host: "h", port: "2222", unsupported: [] });
    expect(parseFlagged("-p2222 -i ~/.ssh/k h")).toEqual({ host: "h", port: "2222", identity: "~/.ssh/k", unsupported: [] });
    expect(parseFlagged("-o ProxyCommand=x h")?.unsupported).toContain("-o");
    expect(parseFlagged("central")).toBeUndefined();
    expect(closest("centrl", [{ value: "central", source: "history" }, { value: "zzz", source: "history" }])).toEqual(["central"]);
  });
});

describe("history and private files", () => {
  test("most recent first, no duplicates, at most 50, 0600, replaced atomically", () => {
    const home = join(dir, "history");
    for (let i = 0; i < 60; i++) pushHistory(home, "host", `h${i}`);
    pushHistory(home, "host", "h10");
    const list = readHistory(home);
    expect(list).toHaveLength(50);
    expect(list.slice(0, 2)).toEqual(["h10", "h59"]);
    expect(new Set(list).size).toBe(50);
    expect(statSync(join(home, ".config", "cc-remote", "setup-history.json")).mode & 0o777).toBe(0o600);
    pushHistory(home, "host", "bad\nvalue");
    expect(readHistory(home)[0]).toBe("h10");
  });

  test("a corrupt, foreign-mode or symlinked file is no history, and writes refuse links", () => {
    const home = join(dir, "history-bad");
    const file = join(home, ".config", "cc-remote", "setup-history.json");
    mkdirSync(join(home, ".config", "cc-remote"), { recursive: true });
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(readHistory(home)).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 1, host: ["x"] }));
    chmodSync(file, 0o644);
    expect(readHistory(home)).toEqual([]);
    rmSync(file);
    writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ version: 1, host: ["x"] }), { mode: 0o600 });
    symlinkSync(join(dir, "elsewhere.json"), file);
    expect(readHistory(home)).toEqual([]);
    expect(() => writePrivateJson(file, { a: 1 })).toThrow(/symbolic link/);
    expect(readFileSync(join(dir, "elsewhere.json"), "utf8")).toContain('"x"');
    expect(readPrivateJson(join(dir, "missing.json"))).toBeUndefined();
  });

  test("a lock is exclusive while its holder lives, and taken over when it died", () => {
    const path = join(dir, "locks", "setup.lock");
    const release = lock(path)!;
    expect(release).toBeDefined();
    writeFileSync(path, "1\n"); // pid 1 is alive
    expect(lock(path)).toBeUndefined();
    writeFileSync(path, "999999999\n");
    const again = lock(path);
    expect(again).toBeDefined();
    again!();
    expect(() => lstatSync(path)).toThrow();
  });
});

describe("the central probe", () => {
  test("output between markers is parsed; noise before and after is ignored", () => {
    const out = "welcome\nKEY=noise\nT:begin\nOS=Linux\nAUTH_EXIT=1\nT:begin:auth\n{\"loggedIn\":false}\nOS=not-a-key-here\nT:end:auth\nOS=again\nT:end\nKEY=after\n";
    const p = parseProbe(out, "T")!;
    expect(p.kv).toEqual({ OS: "Linux", AUTH_EXIT: "1" });
    expect(p.sections.auth).toBe('{"loggedIn":false}\nOS=not-a-key-here');
    expect(parseProbe("no markers", "T")).toBeUndefined();
  });

  test("ssh's error output is classified", () => {
    expect(classifySsh("@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.")).toBe("changed");
    expect(classifySsh("No ED25519 host key is known for x and you have requested strict checking.\nHost key verification failed.")).toBe("hostkey");
    expect(classifySsh("me@x: Permission denied (publickey).")).toBe("denied");
    expect(classifySsh("Received disconnect from x: 2: Too many authentication failures")).toBe("toomany");
    expect(classifySsh("ssh: Could not resolve hostname x: Name or service not known")).toBe("dns");
    expect(classifySsh("ssh: connect to host x port 22: Connection timed out")).toBe("timeout");
    expect(classifySsh("ssh: connect to host x port 22: Connection refused")).toBe("refused");
    expect(classifySsh("ssh: connect to host x port 22: No route to host")).toBe("noroute");
    expect(classifySsh("kex_exchange_identification: read: Connection reset by peer")).toBe("kex");
    expect(classifySsh("something else")).toBe("other");
  });

  test("claude's login, as claude-agent-acp reads it", () => {
    expect(parseAuth('{"loggedIn":true,"subscriptionType":"max","apiProvider":"firstParty"}')).toMatchObject({ loggedIn: true, subscription: "max" });
    expect(parseAuth('{"loggedIn":false,"apiKeySource":"ANTHROPIC_API_KEY"}')?.loggedIn).toBe(true);
    expect(parseAuth('{"loggedIn":false,"apiProvider":"bedrock"}')?.loggedIn).toBe(true);
    expect(parseAuth('{"loggedIn":false,"apiProvider":"firstParty"}')?.loggedIn).toBe(false);
    expect(parseAuth("garbage")).toBeUndefined();
  });

  test("sshd values: first wins, Match blocks ignored, unreadable is unknown", () => {
    expect(parseSshd("#cc-remote:file /etc/ssh/sshd_config\n#cc-remote:file /etc/ssh/sshd_config.d/a.conf\nMaxSessions 64\nMaxSessions 5\nClientAliveInterval=30\nMatch User x\n  MaxStartups 1:1:1"))
      .toEqual({ readable: true, maxSessions: 64, clientAliveInterval: 30, maxStartups: undefined });
    expect(parseSshd("#cc-remote:unreadable /etc/ssh/sshd_config").readable).toBe(false);
  });

  const stub = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  /** A host home with a stub claude, run under each POSIX shell available. */
  const probeIn = (shell: string[], claude: string | undefined, marker?: string) => {
    const home = mkdtempSync(join(dir, "probe-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    if (claude) stub(join(home, ".local", "bin", "claude"), claude);
    if (marker !== undefined) {
      mkdirSync(join(home, ".cc-remote", "machines"), { recursive: true });
      writeFileSync(join(home, ".cc-remote", "machines", "box.json"), marker);
    }
    const r = Bun.spawnSync([...shell], { stdin: new Blob([probeScript("TOK", "box")]), env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" } });
    return parseProbe(r.stdout.toString(), "TOK")!;
  };
  const shells = [["sh", "-s"], ["dash", "-s"], ["bash", "--posix", "-s"]].filter(([s]) => Bun.which(s!));
  const LOGGED_IN = `case "$1 $2" in "auth status") echo '{"loggedIn":true,"subscriptionType":"pro"}';; "--help ") echo 'choices: "auto", "default"';; esac`;
  for (const shell of shells) {
    test(`runs under ${shell.join(" ")}: claude, login, auto, marker, resources`, () => {
      const p = probeIn(shell, LOGGED_IN, '{"machineId":"abc"}');
      expect(p.kv.OS).toBe(process.platform === "darwin" ? "Darwin" : "Linux");
      expect(p.kv.CLAUDE_NI).toEndWith("/.local/bin/claude");
      expect(p.kv.HELP_AUTO).toBe("1");
      expect(p.kv.AUTH_EXIT).toBe("0");
      expect(parseAuth(p.sections.auth)?.loggedIn).toBe(true);
      expect(p.kv.TOOLS_MISSING?.trim()).toBe("");
      expect(p.kv.CC_DIR).toBe("dir");
      expect(p.sections.marker).toBe('{"machineId":"abc"}');
      expect(Number(p.kv.NOFILE)).toBeGreaterThan(0);
      expect(p.kv.PYTHON_VERSION).toMatch(/^3\.\d+\.\d+$/);
      expect(Number(p.kv.NPROC) > 0 || p.kv.NPROC === "unlimited").toBe(true);
    });
  }

  test("logged out exits 1 with JSON, no auto in --help, and no claude at all", () => {
    const out = probeIn(["sh", "-s"], `case "$1 $2" in "auth status") echo '{"loggedIn":false}'; exit 1;; "--help ") echo 'choices: "default"';; esac`);
    expect(out.kv.AUTH_EXIT).toBe("1");
    expect(parseAuth(out.sections.auth)?.loggedIn).toBe(false);
    expect(out.kv.HELP_AUTO).toBe("0");
    const none = probeIn(["sh", "-s"], undefined);
    expect(none.kv.CLAUDE_NI).toBe("");
    expect(none.kv.CC_DIR).toBe("absent");
    expect(none.sections.marker).toBe("");
  });

  test("the save script writes the marker only when absent or ours", () => {
    const home = mkdtempSync(join(dir, "save-"));
    const run = (id: string) => Bun.spawnSync(["sh", "-s"], { stdin: new Blob([saveScript("box", id, JSON.stringify({ machineId: id }))]), env: { HOME: home, PATH: "/usr/bin:/bin" } }).stdout.toString().trim();
    expect(run("11111111-1111-1111-1111-111111111111")).toBe("RESULT=created");
    expect(run("11111111-1111-1111-1111-111111111111")).toBe("RESULT=updated");
    expect(run("22222222-2222-2222-2222-222222222222")).toBe("RESULT=foreign");
    expect(JSON.parse(readFileSync(join(home, ".cc-remote", "machines", "box.json"), "utf8")).machineId).toBe("11111111-1111-1111-1111-111111111111");
    expect(statSync(join(home, ".cc-remote")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".cc-remote", "ws")).isDirectory()).toBe(true);
  });

  test("remote findings: abort conditions in order, sshd and resource advice", () => {
    const base = { OS: "Linux", ARCH: "x86_64", LOGIN_SHELL: "/bin/bash", CLAUDE_NI: "/home/me/.local/bin/claude", HELP_AUTO: "1", CC_DIR: "dir", CC_OWNED: "1", CC_WRITABLE: "1", CC_FREE_KB: "50000000", NOFILE: "1024", NPROC: "100000", MEM_KB: "500000", CLAUDE_PROCS: "3" };
    const auth = '{"loggedIn":true,"subscriptionType":"max"}';
    const run = (kv: Record<string, string>, extra: object = {}, sections: Record<string, string> = { auth, sshd: "#cc-remote:file /etc/ssh/sshd_config\nMaxSessions 64\nClientAliveInterval 60\nMaxStartups 100:30:300" }) =>
      remoteChecks({ host: "c", probe: { kv, sections }, version: "2.1.300 (Claude Code)", ...extra });
    expect(run(base).abort).toBeUndefined();
    expect(run({ ...base, CLAUDE_NI: "" }).abort?.reason).toBe("missing");
    expect(run({ ...base, CLAUDE_NI: "", CLAUDE_LOGIN: "/x/claude" }).abort?.reason).toBe("login-only");
    expect(run(base, { version: "2.1.1 (Claude Code)" }).abort?.reason).toBe("too-old");
    expect(run(base, { version: undefined }).abort?.reason).toBe("no-version");
    expect(run(base, {}, { auth: '{"loggedIn":false}' }).abort?.reason).toBe("logged-out");
    const checks = run(base).checks;
    expect(checks.find((c) => c.id === "R14")).toMatchObject({ status: "warn" });
    expect(checks.find((c) => c.id === "R14")!.detail).toContain("nofile 1024 < 4096");
    const sshd = run(base, {}, { auth, sshd: "#cc-remote:file /etc/ssh/sshd_config\n" }).checks.filter((c) => c.id === "R13");
    expect(sshd.map((c) => c.status)).toEqual(["warn", "warn", "info"]);
    expect(run({ ...base, LOGIN_SHELL: "/usr/bin/fish" }).checks.find((c) => c.id === "R4")?.status).toBe("warn");
    expect(run({ ...base, TOOLS_MISSING: " tar" }).checks.find((c) => c.id === "R6")?.status).toBe("fail");
    expect(run(base, { machineId: "mine" }, { auth, marker: '{"machineId":"other"}' }).checks.find((c) => c.id === "R12")?.status).toBe("warn");
    // python3 for the relay: advice, never a stop.
    expect(checks.find((c) => c.id === "R15")).toMatchObject({ status: "warn", short: "no python3: no reconnection" });
    expect(run({ ...base, PYTHON_VERSION: "3.5.2" }).checks.find((c) => c.id === "R15")!.detail).toContain("older than 3.6");
    expect(run({ ...base, PYTHON_VERSION: "3.6.8" })).toMatchObject({ abort: undefined });
    expect(run({ ...base, PYTHON_VERSION: "3.6.8" }).checks.find((c) => c.id === "R15")?.status).toBe("pass");
  });
});

describe("Orca", () => {
  test("command validation mirrors oLs()", () => {
    expect(validateCommand("/home/me/.local/bin/cc-remote claude")).toEqual({ program: "/home/me/.local/bin/cc-remote", prefixArgs: ["claude"] });
    for (const bad of ["", "a $HOME", "a `x`", "a\nb", "X=1 cc-remote claude", "cc-remote | tee", "cc-remote claude;", "cc-remote (x)", "a*", "a?", "a!", "/my path/x claude"]) {
      if (bad === "/my path/x claude") expect(validateCommand(bad)).toEqual({ program: "/my", prefixArgs: ["path/x", "claude"] });
      else expect("error" in validateCommand(bad)).toBe(true);
    }
    expect(normalizeCommand("  /x/cc-remote   claude ")).toBe("/x/cc-remote claude");
  });

  test("the permission model: new versus legacy, default versus custom", () => {
    expect(permissionOf({ agentPermission: { default: "full-access", overrides: {} } }, {})).toMatchObject({ model: "agent-permission", current: "full-access", isDefault: true });
    expect(permissionOf({ agentPermission: { default: "full-access", overrides: { claude: "ask" } } }, {})).toMatchObject({ current: "ask", override: "ask", isDefault: false });
    expect(permissionOf({ agentPermission: { default: "own", overrides: {} } }, {})).toMatchObject({ current: "own", isDefault: false });
    expect(permissionOf({}, { nativeChatPermissionMode: "full-access" })).toEqual({ model: "legacy", current: "full-access", isDefault: true });
    expect(permissionOf({}, { nativeChatPermissionMode: "accept-edits" })).toMatchObject({ model: "legacy", isDefault: false });
  });

  test("which commands are Orca's default, another cc-remote, ours or custom", () => {
    const ours = "/home/me/.local/bin/cc-remote claude";
    expect(commandKind(undefined, ours)).toBe("default");
    expect(commandKind(" claude ", ours)).toBe("default");
    expect(commandKind("/home/me/.local/bin/cc-remote  claude", ours)).toBe("ours");
    expect(commandKind("/home/me/.bun/bin/cc-remote --host x claude", ours)).toBe("cc-remote");
    expect(commandKind("/opt/cc-remote-linux-x64 claude", ours)).toBe("cc-remote");
    expect(commandKind("/usr/local/bin/claude", ours)).toBe("custom");
  });

  test("versions: 1.4.254 verified, newer 1.4 patches accepted with a warning", () => {
    expect(versionSupport("1.4.254")).toBe("verified");
    expect(versionSupport("1.4.260")).toBe("newer");
    expect(versionSupport("1.5.0")).toBe("unverified");
    expect(versionSupport(undefined)).toBe("unverified");
  });

  test("profile candidates: flag, env, orcad's, then the desktop app's", () => {
    expect(profileCandidates({ ORCA_USER_DATA: "/o", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" }, "/h", "linux", "/f")).toEqual(["/f", "/o", "/d/Orca", "/h/.orca", "/c/orca"]);
    expect(profileCandidates({}, "/h", "darwin")).toEqual(["/h/.orca", "/h/Library/Application Support/orca"]);
  });

  test("discovery refuses unsafe profiles, dead pids and missing sockets; RPC skips keepalives and checks the runtime", async () => {
    const profile = mkdtempSync(join(tmpdir(), "ccr-o-"));
    const orca = fakeOrca(profile);
    try {
      const rt = inspect(profile);
      expect(rt && "endpoint" in rt).toBe(true);
      if (!rt || !("endpoint" in rt)) return;
      expect((await call(rt, "status.get")).graphStatus).toBe("ready");
      await expect(call(rt, "settings.mutateAgentLaunch", { type: "command", agent: "claude", value: "x", extra: 1 })).rejects.toThrow(/refused settings.mutateAgentLaunch: Unrecognized key/);
      await expect(call({ ...rt, runtimeId: "other" }, "status.get")).rejects.toThrow(/runtime changed/);
      await expect(call({ ...rt, token: "wrong" }, "status.get")).rejects.toThrow();
      chmodSync(profile, 0o770);
      expect(inspect(profile)).toEqual({ problem: "the profile folder isn't controlled by this user only" });
      chmodSync(profile, 0o700);
      const file = join(profile, "orca-runtime.json");
      chmodSync(file, 0o644);
      expect(inspect(profile)).toEqual({ problem: "orca-runtime.json isn't a private file of this user" });
      const meta = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...meta, pid: 999999999 }), { mode: 0o600 });
      chmodSync(file, 0o600);
      expect(inspect(profile)).toEqual({ problem: "not running (its runtime file is left over)" });
      writeFileSync(file, JSON.stringify({ ...meta, transports: [{ kind: "unix", endpoint: join(profile, "gone.sock") }] }));
      expect(inspect(profile)).toEqual({ problem: "not running (its socket is gone)" });
      rmSync(file);
      expect(inspect(profile)).toBeUndefined();
    } finally {
      orca.stop();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe("ssh config block", () => {
  test("appended once, replaced in place, other hosts' entries kept", () => {
    const one = withEntry("Host a\n  User x\n", { pattern: "central", identity: "~/.ssh/cc-remote_ed25519" });
    expect(one).toBe("Host a\n  User x\n\n# >>> cc-remote setup >>>\nHost central\n    IdentityFile ~/.ssh/cc-remote_ed25519\n    IdentitiesOnly yes\n# <<< cc-remote setup <<<\n");
    const two = withEntry(one, { pattern: "other", hostName: "h", user: "me", port: "2222" });
    expect(two).toContain("Host central\n    IdentityFile");
    expect(two).toContain("Host other\n    HostName h\n    User me\n    Port 2222");
    const three = withEntry(two, { pattern: "central", identity: "~/.ssh/id_ed25519" });
    expect(three.match(/Host central/g)).toHaveLength(1);
    expect(three).toContain("IdentityFile ~/.ssh/id_ed25519");
    expect(() => withEntry("", { pattern: "bad host" })).toThrow(/unsafe/);
    expect(withEntry("", { pattern: "c", identity: "~/.k" }).startsWith("# >>> cc-remote setup >>>")).toBe(true);
  });
});

describe("progress", () => {
  const capture = (tty: boolean) => {
    let text = "";
    const out = { isTTY: tty, write: (s: string) => (text += s) };
    return { term: new Term(out, tty, { LANG: "en_US.UTF-8", TERM: "xterm" }), text: () => text };
  };

  test("plain mode: a start line and an end line per step", () => {
    const c = capture(false);
    let now = 0;
    const p = new Progress(c.term, 3, true, () => now);
    p.begin("Checking central");
    now = 1500;
    p.end("fail", "claude not logged in", "central");
    expect(c.text()).toBe("[1/3] Checking central...\n[1/3] ✗ central (1s): claude not logged in\n");
  });

  test("terminal mode: a spinner on a fake clock, frozen before other output, then the end line", () => {
    const c = capture(true);
    let now = 0;
    let tick: (() => void) | undefined;
    const timers = { setInterval: (f: () => void) => ((tick = f), 1), clearInterval: () => (tick = undefined) };
    const p = new Progress(c.term, 7, false, () => now, timers);
    p.begin("Checking this machine");
    now = 2000;
    tick!();
    p.say("        ✓ ssh");
    expect(tick).toBeUndefined();
    p.end("warn", "rg not found");
    const text = c.text();
    expect(text).toContain("\r\x1b[K  [1/7] \x1b[36m⠋\x1b[0m Checking this machine…  \x1b[2m0s\x1b[0m");
    expect(text).toContain("\x1b[36m⠙\x1b[0m Checking this machine…  \x1b[2m2s\x1b[0m");
    expect(text).toContain("  [1/7] \x1b[36m⋯\x1b[0m Checking this machine…\n        ✓ ssh\n");
    expect(text).toEndWith("  [1/7] \x1b[33m⚠\x1b[0m Checking this machine  \x1b[2m2s\x1b[0m — rg not found\n");
  });

  test("ASCII markers without a UTF-8 locale; NO_COLOR turns colour off", () => {
    let text = "";
    const term = new Term({ isTTY: true, write: (s: string) => (text += s) }, true, { LANG: "C", NO_COLOR: "1" });
    expect([term.mark("pass"), term.mark("warn"), term.mark("fail")]).toEqual(["ok", "WARN", "FAIL"]);
    expect(term.color).toBe(false);
    expect(text).toBe("");
  });
});

describe("CC_REMOTE_NO_VERSION_CACHE", () => {
  test("=1 turns the version cache off both ways", () => {
    const saved = { dir: versionCache.dir, env: process.env.CC_REMOTE_NO_VERSION_CACHE };
    versionCache.dir = join(dir, "version-cache");
    try {
      rememberVersion("h1", "2.1.300 (Claude Code)");
      expect(cachedVersion("h1")).toBe("2.1.300 (Claude Code)");
      process.env.CC_REMOTE_NO_VERSION_CACHE = "1";
      expect(cachedVersion("h1")).toBeUndefined();
      rememberVersion("h2", "2.1.301 (Claude Code)");
      delete process.env.CC_REMOTE_NO_VERSION_CACHE;
      expect(cachedVersion("h2")).toBeUndefined();
      expect(cachedVersion("h1")).toBe("2.1.300 (Claude Code)");
    } finally {
      versionCache.dir = saved.dir;
      if (saved.env === undefined) delete process.env.CC_REMOTE_NO_VERSION_CACHE;
      else process.env.CC_REMOTE_NO_VERSION_CACHE = saved.env;
    }
  });
});
