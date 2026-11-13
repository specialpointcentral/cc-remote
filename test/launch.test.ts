import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkScript, missingIn } from "../src/host-files";
import type { HostProcess } from "../src/host-process";
import { projectKey } from "../src/sessions";
import { hostDir, launch, rsh, spawner, type Upload } from "../src/ssh";
import { archive } from "../src/tar";
import { cachedVersion, MIN_CLAUDE, older, rememberVersion, tooOld, versionCache } from "../src/version";
import { fakeHost } from "./fakehost";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-launch-"));
const host = fakeHost(dir);
const KEYS = ["CC_REMOTE_SSH", "FAKE_SSH_LOG", "FAKE_HOST_HOME", "FAKE_HOST_CONFIG", "CLAUDE_CONFIG_DIR", "FAKE_REFUSE_SHARED", "FAKE_NOISE", "FAKE_CLAUDE_VERSION", "CC_REMOTE_CONTROL_PERSIST", "CC_REMOTE_KEEPALIVE_TIMEOUT"];
const savedEnv = Object.fromEntries(KEYS.map((k) => [k, Bun.env[k]]));
const savedCache = { ...versionCache };
const hostConfig = join(dir, "host-config");

beforeAll(() => {
  for (const k of KEYS) delete Bun.env[k];
  Object.assign(Bun.env, host.env, { CLAUDE_CONFIG_DIR: join(dir, "local-config"), FAKE_HOST_CONFIG: hostConfig });
});
beforeEach(() => {
  host.reset();
  for (const k of ["FAKE_REFUSE_SHARED", "FAKE_NOISE", "FAKE_CLAUDE_VERSION", "CC_REMOTE_CONTROL_PERSIST", "CC_REMOTE_KEEPALIVE_TIMEOUT"]) delete Bun.env[k];
  Object.assign(Bun.env, host.env);
  versionCache.dir = mkdtempSync(join(dir, "cache-"));
});
afterAll(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = savedEnv[k];
  }
  Object.assign(versionCache, savedCache);
  rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, content = path) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

let projects = 0;
/** A fresh local project directory. */
const project = () => {
  const p = join(dir, `project-${++projects}`);
  mkdirSync(p, { recursive: true });
  return p;
};

/** Where the fake host keeps a local directory's folder. */
const onHost = (cwd: string, ...rest: string[]) => join(host.home, hostDir(cwd), ...rest);

type Run = { out: string; err: string; code: number | null; signal: NodeJS.Signals | null; channels: number; child: HostProcess };

/**
 * Launches like the SDK does: writes `input` at once, before claude can be up, then ends stdin,
 * and collects what reaches stdout and stderr until the exit.
 */
async function run(cwd: string, args: string[], { uploads = [] as Upload[], input = "hello\n", end = true } = {}): Promise<Run> {
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const child = launch("box", cwd, args, { FROM: "sdk" }, uploads);
    child.stdin.write(input);
    if (end) child.stdin.end();
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    const ended = new Promise((done) => child.stdout.on("end", done));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done, fail) => {
      child.on("exit", (c: number | null, s: NodeJS.Signals | null) => done([c, s]));
      child.on("error", fail);
    });
    await ended;
    return { out, err, code, signal, channels: child.channels, child };
  } finally {
    process.stderr.write = write;
  }
}

describe("launch", () => {
  test("starts claude in one channel when the host has everything, and keeps the ready line from the SDK", async () => {
    const r = await run(project(), ["--model", "x y"]);
    expect(r.code).toBe(0);
    expect(r.channels).toBe(1);
    expect(host.calls()).toHaveLength(1);
    expect(r.out).toBe("ARGS [--model] [x y]\nTEAMS=0\nhello\n");
    expect(r.err).toBe("");
    // That start also asked for the version, which the next ones take from the cache.
    expect(cachedVersion("box")).toBe("2.1.323 (Claude Code)");
    expect(host.calls()[0]).toContain("claude --version");
    const again = await run(project(), []);
    expect(again.channels).toBe(1);
    expect(host.calls()[1]).not.toContain("claude --version");
  });

  test("passes compression and keepalives, with the caller's earlier options first", async () => {
    Bun.env.CC_REMOTE_SSH = `${host.ssh} -o ServerAliveInterval=60`;
    await run(project(), []);
    const call = host.calls()[0]!;
    expect(call).toStartWith("-o ServerAliveInterval=60 -o Compression=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=20 -T box ");
  });

  test("sends what the host lacks over one more channel, then starts with the input delivered once", async () => {
    const cwd = project();
    const plugin = join(dir, `plugin-${projects}`);
    put(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"p"}');
    put(join(plugin, "skills", "x", "SKILL.md"), "skill");
    put(join(cwd, ".claude", "commands", "deploy.md"), "deploy it");
    const uploads = [{ local: plugin, remote: `.cc-remote/plugins/p-${projects}` }];

    const first = await run(cwd, ["--plugin-dir=x"], { uploads, input: '{"type":"control_request"}\n' });
    expect(first.code).toBe(0);
    expect(first.channels).toBe(3);
    expect(first.out).toBe('ARGS [--plugin-dir=x]\nTEAMS=0\n{"type":"control_request"}\n');
    expect(first.err).toBe("");
    expect(readFileSync(join(host.home, uploads[0]!.remote, ".claude-plugin", "plugin.json"), "utf8")).toBe('{"name":"p"}');
    expect(readFileSync(join(host.home, uploads[0]!.remote, "skills", "x", "SKILL.md"), "utf8")).toBe("skill");
    expect(readFileSync(onHost(cwd, ".claude", "commands", "deploy.md"), "utf8")).toBe("deploy it");
    // The scratch folder is gone.
    expect(readdirSync(join(host.home, ".cc-remote")).filter((n) => n.startsWith(".upload"))).toEqual([]);

    const second = await run(cwd, ["--plugin-dir=x"], { uploads });
    expect(second.channels).toBe(1);
    expect(second.out).toBe("ARGS [--plugin-dir=x]\nTEAMS=0\nhello\n");
  });

  test("resumes a session the host has never seen, putting its transcript where claude looks", async () => {
    const cwd = project();
    const id = `0000000${projects}-1111-2222-3333-444444444444`;
    const local = join(dir, "local-config", "projects", projectKey(cwd), `${id}.jsonl`);
    put(local, '{"type":"user"}\n');
    // claude names the folder after the real path of its working directory.
    const link = join(dir, `host-link-${projects}`);
    symlinkSync(host.home, link);
    Bun.env.FAKE_HOST_HOME = link;
    const key = join(host.home, hostDir(cwd)).replace(/[^a-zA-Z0-9]/g, "-");
    const remote = join(hostConfig, "projects", key, `${id}.jsonl`);

    const first = await run(cwd, ["--resume", id]);
    expect(first.channels).toBe(3);
    expect(readFileSync(remote, "utf8")).toBe('{"type":"user"}\n');
    expect(statSync(remote).mode & 0o777).toBe(0o600);

    // Present now, so not sent again, in either spelling of the flag.
    put(local, '{"type":"user"}\n{"type":"assistant"}\n');
    for (const args of [[`--resume=${id}`], ["-r", id]]) {
      const again = await run(cwd, args);
      expect(again.channels).toBe(1);
      expect(again.out).toContain("hello\n");
    }
    expect(readFileSync(remote, "utf8")).toBe('{"type":"user"}\n');
  });

  test("keeps the host's copy of the project's commands, skills and agents in step with the local ones", async () => {
    const cwd = project();
    put(join(cwd, ".claude", "skills", "review", "SKILL.md"), "v1");
    put(join(cwd, ".claude", "settings.json"), "{}");
    expect((await run(cwd, [])).channels).toBe(3);
    put(onHost(cwd, ".claude", "settings.local.json"), "host rules");
    expect((await run(cwd, [])).channels).toBe(1);

    put(join(cwd, ".claude", "skills", "review", "SKILL.md"), "v2");
    expect((await run(cwd, [])).channels).toBe(3);
    expect(readFileSync(onHost(cwd, ".claude", "skills", "review", "SKILL.md"), "utf8")).toBe("v2");
    expect(readdirSync(onHost(cwd, ".claude")).filter((n) => n.startsWith(".cc-remote-sync-"))).toHaveLength(1);

    // With none left here, the host's go too, without an upload.
    rmSync(join(cwd, ".claude", "skills"), { recursive: true });
    const cleared = await run(cwd, []);
    expect(cleared.channels).toBe(1);
    expect(readdirSync(onHost(cwd, ".claude"))).toEqual(["settings.local.json"]);
  });

  test("sessions starting together each get the trees once, never one inside the other", async () => {
    const cwd = project();
    put(join(cwd, ".claude", "skills", "s", "SKILL.md"), "skill");
    const plugin = join(dir, `plugin-${projects}`);
    put(join(plugin, "skills", "p", "SKILL.md"), "plugin skill");
    const uploads = [{ local: plugin, remote: `.cc-remote/plugins/p-${projects}` }];
    const start = async () => {
      const child = launch("box", cwd, [], {}, uploads);
      child.stdin.end("hi\n");
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk));
      const code = await new Promise((done) => child.on("exit", done));
      return { code, out, channels: child.channels };
    };
    const runs = await Promise.all([start(), start(), start()]);
    for (const r of runs) expect(r).toEqual({ code: 0, out: "ARGS\nTEAMS=0\nhi\n", channels: 3 });
    expect(readdirSync(onHost(cwd, ".claude", "skills"))).toEqual(["s"]);
    expect(readdirSync(join(host.home, uploads[0]!.remote))).toEqual(["skills"]);
    expect(existsSync(join(host.home, ".cc-remote", ".install-lock"))).toBe(false);
  });

  test("shares the host folder with cc-remotes of other stamp formats, removing only its own stamps", async () => {
    const cwd = project();
    put(join(cwd, ".claude", "commands", "c.md"), "v1");
    const foreign = onHost(cwd, ".claude", ".cc-remote-sync-v2-elsewhere");
    put(foreign, "");
    expect((await run(cwd, [])).channels).toBe(3);
    expect(existsSync(foreign)).toBe(true);
    expect((await run(cwd, [])).channels).toBe(1);
    // Another format replaced the trees after us: our stamp reads as stale, and the trees go up again.
    await Bun.sleep(20);
    put(foreign, "");
    expect((await run(cwd, [])).channels).toBe(3);
    expect((await run(cwd, [])).channels).toBe(1);
    rmSync(join(cwd, ".claude"), { recursive: true });
    expect((await run(cwd, [])).channels).toBe(1);
    expect(readdirSync(onHost(cwd, ".claude"))).toEqual([".cc-remote-sync-v2-elsewhere"]);
  });

  test("a shared connection sshd refuses another session gets a connection of its own", async () => {
    Bun.env.CC_REMOTE_SSH = `${host.ssh} -o ControlMaster=auto -o ControlPath=${dir}/mux-%C`;
    Bun.env.FAKE_REFUSE_SHARED = "1";
    const cwd = project();
    put(join(cwd, ".claude", "agents", "a.md"), "agent");
    const r = await run(cwd, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe("ARGS\nTEAMS=0\nhello\n");
    expect(r.err).toBe("");
    // Refused, then missing, upload, start: all after the first on a connection of their own.
    const calls = host.calls();
    expect(calls).toHaveLength(4);
    expect(calls[0]).not.toContain("ControlPath=none");
    for (const call of calls.slice(1)) expect(call).toStartWith("-o ControlMaster=no -o ControlPath=none -o ControlMaster=auto");
  });

  test("what the host prints before claude starts goes to stderr, never to the SDK", async () => {
    Bun.env.FAKE_NOISE = "1";
    const r = await run(project(), []);
    expect(r.out).toBe("ARGS\nTEAMS=0\nhello\n");
    expect(r.err).toContain("welcome to the host\n");
    expect(r.err).toContain("a login warning\n");
    expect(r.err).not.toContain("cc-remote-ready");
  });

  test("refuses a host claude older than the minimum, live and then from the cache", async () => {
    Bun.env.FAKE_CLAUDE_VERSION = "2.1.100";
    const live = await run(project(), [], { end: false });
    expect(live.code).toBe(1);
    expect(live.out).toBe("");
    expect(live.err).toContain(`claude on box is 2.1.100, older than the ${MIN_CLAUDE} cc-remote needs`);
    const cached = await run(project(), []);
    expect(cached.code).toBe(1);
    expect(cached.channels).toBe(0);
    expect(cached.err).toContain("older than");
  });

  test("kill stops claude and reports the signal", async () => {
    const cwd = project();
    const child = launch("box", cwd, [], {});
    await new Promise((up) => child.stdout.once("data", up));
    const exited = new Promise((done) => child.on("exit", (code: number | null, signal: string | null) => done([code, signal])));
    expect(child.kill("SIGTERM")).toBe(true);
    expect(await exited).toEqual([null, "SIGTERM"]);
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("a failing ssh is reported with its own status, and an ssh that can't start as an error", async () => {
    Bun.env.CC_REMOTE_SSH = join(dir, "bin", "failing");
    put(Bun.env.CC_REMOTE_SSH, "#!/bin/sh\necho 'ssh: connect to host box port 22: Connection refused' >&2\nexit 255\n");
    Bun.spawnSync(["chmod", "+x", Bun.env.CC_REMOTE_SSH]);
    const failed = await run(project(), []);
    expect(failed.code).toBe(255);
    expect(failed.channels).toBe(1);
    expect(failed.err).toContain("Connection refused");

    Bun.env.CC_REMOTE_SSH = join(dir, "bin", "missing-ssh");
    const child = launch("box", project(), [], {});
    const error = await new Promise<Error>((done) => child.on("error", done));
    expect(error.message).toContain("ENOENT");
  });
});

describe("spawner", () => {
  test("gives the SDK a process whose input, held until claude is up, goes through the proxy", async () => {
    const cwd = project();
    put(join(cwd, ".claude", "commands", "c.md"), "a command");
    const abort = new AbortController();
    const sdk = spawner("box", cwd, {})({ command: "claude", args: ["--input-format", "stream-json"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, signal: abort.signal });
    const line = JSON.stringify({ type: "user", message: { role: "user", content: `in ${join(host.home, hostDir(cwd))}` } });
    sdk.stdin.write(`${line}\n`);
    let out = "";
    sdk.stdout.on("data", (chunk: Buffer) => (out += chunk));
    await new Promise<void>((up) => {
      const check = () => (out.includes('"type":"user"') ? up() : setTimeout(check, 10));
      check();
    });
    // The echo comes back once, with the host folder mapped back to the local one.
    expect(out.split("\n").filter((l) => l.startsWith("{"))).toEqual([JSON.stringify({ type: "user", message: { role: "user", content: `in ${cwd}` } })]);
    expect(out).toContain("ARGS [--input-format] [stream-json]");
    expect(host.calls()).toHaveLength(3);
    expect(host.calls()[2]).toContain("'CLAUDE_CODE_ENTRYPOINT=sdk-ts'");
    const exited = new Promise((done) => sdk.once("exit", (code: number | null, signal: string | null) => done([code, signal])));
    abort.abort();
    expect(await exited).toEqual([null, "SIGTERM"]);
    expect(sdk.killed).toBe(true);
  });
});

describe("the check", () => {
  test("reports what's missing by index, and stops before claude", () => {
    const tokens = { ready: "READY-x", missing: "MISSING-x" };
    const script = checkScript(
      [{ kind: "plugin", local: "/l", remote: ".cc-remote/plugins/a" }, { kind: "plugin", local: "/l", remote: ".cc-remote/plugins/b" }],
      false,
      tokens,
    );
    const home = mkdtempSync(join(dir, "check-"));
    mkdirSync(join(home, ".cc-remote", "plugins", "a"), { recursive: true });
    const r = Bun.spawnSync(["sh", "-c", `${script} && echo claude`], { env: { HOME: home, PATH: Bun.env.PATH! } });
    expect(r.exitCode).toBe(97);
    expect(r.stdout.toString()).toBe("");
    expect(missingIn(r.stderr.toString().trim(), tokens)).toEqual([1]);
    mkdirSync(join(home, ".cc-remote", "plugins", "b"));
    const ok = Bun.spawnSync(["sh", "-c", `${script} && echo claude`], { env: { HOME: home, PATH: Bun.env.PATH! } });
    expect(ok.stdout.toString()).toBe("READY-x\nclaude\n");
    expect(missingIn("READY-x", tokens)).toBeUndefined();
  });
});

describe("rsh", () => {
  test("compresses, shares a connection for an hour, and tolerates five minutes of silence by default", () => {
    delete Bun.env.CC_REMOTE_SSH;
    const ssh = rsh();
    expect(ssh).toContain("ControlMaster=auto");
    expect(ssh).toContain("ControlPersist=1h");
    expect(ssh.slice(-6)).toEqual(["-o", "Compression=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=20"]);
  });

  test("takes the persistence and the keepalive tolerance from the environment", () => {
    delete Bun.env.CC_REMOTE_SSH;
    Bun.env.CC_REMOTE_CONTROL_PERSIST = "10m";
    Bun.env.CC_REMOTE_KEEPALIVE_TIMEOUT = "60";
    expect(rsh()).toContain("ControlPersist=10m");
    expect(rsh()).toContain("ServerAliveCountMax=4");
    Bun.env.CC_REMOTE_KEEPALIVE_TIMEOUT = "10";
    expect(rsh().slice(-4)).toEqual(["-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=1"]);
    Bun.env.CC_REMOTE_KEEPALIVE_TIMEOUT = "soon";
    expect(rsh()).toContain("ServerAliveCountMax=20");
  });

  test("a custom ssh keeps its own options first; without sharing, ours come before them", () => {
    Bun.env.CC_REMOTE_SSH = "/usr/bin/ssh -o ServerAliveInterval=60 -p 2222";
    expect(rsh()).toEqual(["/usr/bin/ssh", "-o", "ServerAliveInterval=60", "-p", "2222", "-o", "Compression=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=20"]);
    expect(rsh(false).slice(0, 5)).toEqual(["/usr/bin/ssh", "-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    Bun.env.CC_REMOTE_SSH = "tsh ssh";
    expect(rsh()).toEqual(["tsh", "ssh"]);
    delete Bun.env.CC_REMOTE_SSH;
    expect(rsh(false)).not.toContain("ControlMaster=auto");
  });
});

describe("version cache", () => {
  test("remembers the host's answer for the TTL, in a private file", () => {
    expect(cachedVersion("h")).toBeUndefined();
    rememberVersion("h", "2.1.323 (Claude Code)\n", 1_000);
    expect(cachedVersion("h", 1_000 + versionCache.ttlMs - 1)).toBe("2.1.323 (Claude Code)");
    expect(cachedVersion("h", 1_000 + versionCache.ttlMs)).toBeUndefined();
    expect(cachedVersion("other", 1_000)).toBeUndefined();
    const [file] = readdirSync(versionCache.dir);
    expect(statSync(join(versionCache.dir, file!)).mode & 0o777).toBe(0o600);
    expect(statSync(versionCache.dir).mode & 0o777).toBe(0o700);
    // Something that isn't a version isn't remembered.
    rememberVersion("junk", "command not found");
    expect(cachedVersion("junk")).toBeUndefined();
    // A cache file in a format this cc-remote doesn't know reads as no cache.
    const path = join(versionCache.dir, file!);
    expect(file).toStartWith("claude-version-v1-");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), format: 2 }));
    expect(cachedVersion("h", 1_000)).toBeUndefined();
    writeFileSync(path, "{not json");
    expect(cachedVersion("h", 1_000)).toBeUndefined();
  });

  test("tells a too-old claude", () => {
    expect(older("2.1.267", MIN_CLAUDE)).toBe(true);
    expect(older(MIN_CLAUDE, MIN_CLAUDE)).toBe(false);
    expect(older("2.2.0", MIN_CLAUDE)).toBe(false);
    expect(tooOld("h", "2.1.200 (Claude Code)")).toContain("Run `claude update` on h");
    expect(tooOld("h", "2.1.323 (Claude Code)")).toBeUndefined();
    expect(tooOld("h", "")).toBeUndefined();
  });
});

describe("tar", () => {
  test("carries paths too long for ustar in a pax header", () => {
    const long = `${"d".repeat(120)}/${"e".repeat(160)}/${"f".repeat(110)}.md`;
    const out = mkdtempSync(join(dir, "tar-"));
    const r = Bun.spawnSync(["tar", "-xf", "-", "-C", out], { stdin: archive([{ path: long, data: new TextEncoder().encode("deep"), mode: 0o644, mtime: 0 }, { path: "short", data: new Uint8Array(), mode: 0o755, mtime: 0 }]), stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(readFileSync(join(out, long), "utf8")).toBe("deep");
    expect(statSync(join(out, "short")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(out, "PaxHeader"))).toBe(false);
  });
});
