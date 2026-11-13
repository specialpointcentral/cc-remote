import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspace } from "../src/tools/util";
import type { HostProcess } from "../src/host-process";
import { RELAY_PATH } from "../src/relay";
import { checkSharedConnection, hostDir, launch, tellTools } from "../src/ssh";
import { versionCache } from "../src/version";
import { fakeHost, TEAMS_OFF } from "./fakehost";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-reconnect-")));
const host = fakeHost(dir);
const KEYS = ["CC_REMOTE_SSH", "FAKE_SSH_LOG", "FAKE_HOST_HOME", "FAKE_HOST_CONFIG", "CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_VERSION", "FAKE_MASTER", "FAKE_SSH_DOWN", "FAKE_SSH_SLOW",
  "CC_REMOTE_RECONNECT_GRACE", "CC_REMOTE_LINK_TIMEOUT", "CC_REMOTE_CONTROL_PERSIST", "CC_REMOTE_KEEPALIVE_TIMEOUT"];
const saved = { env: Object.fromEntries(KEYS.map((k) => [k, Bun.env[k]])), cache: { ...versionCache } };
const STREAM = ["--input-format", "stream-json"];
// Each case starts python daemons and waits through reconnects.
const SPAWNS = 60_000;

beforeAll(() => {
  for (const k of KEYS) delete Bun.env[k];
  Object.assign(Bun.env, host.env, { CLAUDE_CONFIG_DIR: join(dir, "local-config"), FAKE_HOST_CONFIG: join(dir, "host-config") });
});
beforeEach(() => {
  host.reset();
  for (const k of ["FAKE_CLAUDE_VERSION", "FAKE_MASTER", "FAKE_SSH_DOWN", "FAKE_SSH_SLOW", "CC_REMOTE_RECONNECT_GRACE", "CC_REMOTE_LINK_TIMEOUT"]) delete Bun.env[k];
  Object.assign(Bun.env, host.env);
  versionCache.dir = mkdtempSync(join(dir, "cache-"));
});
afterEach(async () => {
  // Every case ends with nothing of its own left on the "host".
  await until(() => hostProcesses().length === 0, 15_000).catch(() => {});
  expect(hostProcesses()).toEqual([]);
  expect(runs()).toEqual([]);
});
afterAll(() => {
  // A case that failed half way may have left a daemon running from the host's home.
  for (const p of hostProcesses()) process.kill(Number(p.split(" ")[0]), "SIGKILL");
  for (const k of KEYS) {
    if (saved.env[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = saved.env[k];
  }
  Object.assign(versionCache, saved.cache);
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
};

/** Processes running from the fake host's home: the relay's daemons and bridges, and the fake claude. */
function hostProcesses(): string[] {
  const found: string[] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (cmd.includes(host.home) && !cmd.includes("bun ")) found.push(`${pid} ${cmd.trim()}`);
    } catch {}
  }
  return found;
}

const runRoot = () => join(host.home, ".cc-remote", "run");
const runs = () => (existsSync(runRoot()) ? readdirSync(runRoot()).filter((n) => !n.endsWith(".log")) : []);

let projects = 0;
const project = () => {
  const p = join(dir, `project-${++projects}`);
  mkdirSync(p, { recursive: true });
  return p;
};

/** A stream session as the SDK starts one, with what it prints and how it ends. */
function session(cwd: string, args: string[] = STREAM, found?: Parameters<typeof launch>[6]) {
  const s = { out: "", err: "", exit: undefined as [number | null, NodeJS.Signals | null] | undefined, child: undefined as unknown as HostProcess };
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    s.err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  s.child = launch("box", cwd, args, {}, [], undefined, found);
  s.child.stdout.on("data", (chunk: Buffer) => (s.out += chunk));
  const ended = new Promise((done) => s.child.stdout.on("end", done));
  const exited = new Promise<void>((done) => s.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    s.exit = [code, signal];
    process.stderr.write = write;
    done();
  }));
  return { ...s, get s() { return s; }, done: () => Promise.all([ended, exited]).then(() => s) };
}

const BANNER = `ARGS [--input-format] [stream-json]${TEAMS_OFF}\nTEAMS=0\n`;

describe("a stream session under the relay", () => {
  test("starts under the relay in one channel once the host has it, and its run folder goes at the end", async () => {
    const cwd = project();
    const first = session(cwd);
    first.child.stdin.write("hello\n");
    await until(() => first.s.out === `${BANNER}hello\n`);
    // The relay went up with the first start, private and executable.
    expect(statSync(join(host.home, RELAY_PATH)).mode & 0o777).toBe(0o700);
    expect(statSync(join(host.home, ".cc-remote", "bin")).mode & 0o777).toBe(0o700);
    expect(first.child.channels).toBe(3);
    expect(runs()).toHaveLength(1);
    first.child.stdin.end();
    expect((await first.done()).exit).toEqual([0, null]);
    expect(first.s.err).toBe("");

    host.reset();
    const second = session(cwd);
    second.child.stdin.end("again\n");
    const s = await second.done();
    expect(s.out).toBe(`${BANNER}again\n`);
    expect(s.exit).toEqual([0, null]);
    expect(second.child.channels).toBe(1);
    expect(host.calls()).toHaveLength(1);
    expect(host.calls()[0]).toContain(" run ");
  }, SPAWNS);

  test("a dropped connection reconnects on one of its own, with nothing lost or repeated either way", async () => {
    const cwd = project();
    const s = session(cwd);
    s.child.stdin.write("one\n");
    await until(() => s.s.out === `${BANNER}one\n`);
    const before = s.child.link!;
    process.kill(before, "SIGKILL");
    // Written while the link is down.
    s.child.stdin.write("two\n");
    await until(() => s.s.out === `${BANNER}one\ntwo\n`);
    expect(s.child.link).not.toBe(before);
    s.child.stdin.write("three\n");
    await until(() => s.s.out.endsWith("three\n"));
    // Twice more, the second while the first reconnect's connection is in use.
    process.kill(s.child.link!, "SIGKILL");
    s.child.stdin.write("four\n");
    await until(() => s.s.out.endsWith("four\n"));
    s.child.stdin.end();
    const done = await s.done();
    expect(done.out).toBe(`${BANNER}one\ntwo\nthree\nfour\n`);
    expect(done.exit).toEqual([0, null]);
    expect(done.err).toContain("cc-remote: lost the connection to the host; reconnecting\n");
    expect(done.err).toContain("cc-remote: reconnected\n");
    const attaches = host.calls().filter((c) => c.includes(" attach "));
    expect(attaches).toHaveLength(2);
    for (const a of attaches) {
      expect(a).toStartWith("-o ControlMaster=no -o ControlPath=none ");
      expect(a).toContain("-o ConnectTimeout=10 -o BatchMode=yes");
    }
  }, SPAWNS);

  test("a frozen link is found by the heartbeat, and the shared connection is checked", async () => {
    Bun.env.CC_REMOTE_LINK_TIMEOUT = "2";
    // Reconnecting takes most of the timeout, long after the last frame: it must still get through.
    Bun.env.FAKE_SSH_SLOW = "1.5";
    const s = session(project());
    s.child.stdin.write("one\n");
    await until(() => s.s.out.endsWith("one\n"));
    const frozen = s.child.link!;
    process.kill(frozen, "SIGSTOP");
    s.child.stdin.write("two\n");
    await until(() => s.s.out.endsWith("two\n"), 30_000);
    expect(s.child.link).not.toBe(frozen);
    s.child.stdin.end();
    const done = await s.done();
    expect(done.out).toBe(`${BANNER}one\ntwo\n`);
    expect(done.err).toContain("cc-remote: no word from the host for 2s\n");
    // No master is up in the fake, so it went no further than asking.
    expect(host.calls().filter((c) => c.includes("-O check"))).toHaveLength(1);
  }, SPAWNS);

  test("a stale shared connection stops taking new channels", async () => {
    Bun.env.CC_REMOTE_SSH = `${host.ssh} -o ControlMaster=auto -o ControlPath=${dir}/mux-%C`;
    Bun.env.FAKE_MASTER = "up";
    await checkSharedConnection("box");
    expect(host.calls().filter((c) => c.includes(" -O "))).toEqual([expect.stringContaining("-O check box")]);
    host.reset();
    Bun.env.FAKE_MASTER = "stale";
    const err = process.stderr.write.bind(process.stderr);
    let said = "";
    process.stderr.write = ((c: string) => ((said += c), true)) as typeof process.stderr.write;
    try {
      await checkSharedConnection("box");
    } finally {
      process.stderr.write = err;
    }
    const calls = host.calls();
    expect(calls[0]).toContain("-O check box");
    expect(calls[1]).toContain("-o BatchMode=yes -T box true");
    expect(calls[2]).toContain("-O stop box");
    expect(said).toContain("the shared connection to box is not answering");
  }, SPAWNS);

  test("stopping cc-remote stops claude on the host, also while the link is down", async () => {
    const s = session(project());
    s.child.stdin.write("x\n");
    await until(() => s.s.out.endsWith("x\n"));
    expect(s.child.kill("SIGTERM")).toBe(true);
    expect((await s.done()).exit).toEqual([null, "SIGTERM"]);

    // With no way back to the host, it goes after a moment, and the host's grace does the rest.
    Bun.env.CC_REMOTE_RECONNECT_GRACE = "2";
    Bun.env.FAKE_SSH_DOWN = "1";
    const t = session(project());
    t.child.stdin.write("y\n");
    await until(() => t.s.out.endsWith("y\n"));
    process.kill(t.child.link!, "SIGKILL");
    await Bun.sleep(100);
    const asked = Date.now();
    t.child.kill("SIGTERM");
    expect((await t.done()).exit).toEqual([null, "SIGTERM"]);
    expect(Date.now() - asked).toBeLessThan(4_000);
  }, SPAWNS);

  test("gives up when the host's claude is gone or can't be reached within the grace", async () => {
    const s = session(project());
    s.child.stdin.write("x\n");
    await until(() => s.s.out.endsWith("x\n"));
    // The daemon goes (a reboot, a reap), then the link.
    const [run] = runs();
    process.kill(Number(readFileSync(join(runRoot(), run!, "pid"), "utf8")), "SIGTERM");
    await until(() => runs().length === 0);
    const done = await s.done();
    expect(done.exit![0]).toBe(255);
    expect(done.err).toContain("claude on the host is gone");

    Bun.env.CC_REMOTE_RECONNECT_GRACE = "3";
    const t = session(project());
    t.child.stdin.write("y\n");
    await until(() => t.s.out.endsWith("y\n"));
    Bun.env.FAKE_SSH_DOWN = "1";
    process.kill(t.child.link!, "SIGKILL");
    const lost = await t.done();
    expect(lost.exit).toEqual([255, null]);
    expect(lost.err).toContain("could not reconnect to the host (ssh: connect to host box port 22: Network is unreachable)");
    // The host's grace ran out as well: claude and the run folder are gone (checked after each case).
  }, SPAWNS);

  test("a new start of the same session stops the claude an earlier one left running", async () => {
    const cwd = project();
    const id = "11111111-2222-3333-4444-555555555555";
    const first = session(cwd, [...STREAM, "--session-id", id]);
    first.child.stdin.write("first\n");
    await until(() => first.s.out.endsWith("first\n"));
    const [old] = runs();
    expect(readFileSync(join(runRoot(), old!, "session"), "utf8").trim()).toBe(id);
    // As if that cc-remote had died: its link goes and it never comes back.
    Bun.env.FAKE_SSH_DOWN = "1";
    process.kill(first.child.link!, "SIGKILL");
    await until(() => first.s.err.includes("reconnecting"));
    delete Bun.env.FAKE_SSH_DOWN;

    const second = session(cwd, [...STREAM, `--resume=${id}`]);
    second.child.stdin.write("second\n");
    await until(() => second.s.out.endsWith("second\n"));
    expect(runs()).not.toContain(old);
    expect(runs()).toHaveLength(1);
    second.child.stdin.end();
    expect((await second.done()).exit).toEqual([0, null]);
    // The first one finds its claude gone.
    const gone = await first.done();
    expect(gone.exit![0]).toBe(255);
  }, SPAWNS);

  test("runs the host's own file operations over the relay, with no ssh of their own", async () => {
    const cwd = project();
    const ws = workspace(cwd);
    const s = session(cwd, STREAM, tellTools("box", ws));
    s.child.stdin.write("x\n");
    await until(() => s.s.out.endsWith("x\n") && !!ws.host);
    const calls = host.calls().length;
    const plans = join(host.home, ".claude", "plans");
    const plan = join(plans, "p.md");
    expect(await ws.host!.write(plan, "the plan")).toBe(false);
    expect(readFileSync(plan, "utf8")).toBe("the plan");
    expect(new TextDecoder().decode(await ws.host!.read(plan) as Uint8Array)).toBe("the plan");
    expect(await ws.host!.read(join(plans, "none.md"))).toBe("missing");
    expect(await ws.host!.list(plans)).toEqual(["p.md"]);
    expect(host.calls()).toHaveLength(calls);
    s.child.stdin.end();
    await s.done();
    // Once the session is over, they go over ssh again.
    expect(await ws.host!.read(plan)).toBeInstanceOf(Uint8Array);
    expect(host.calls()).toHaveLength(calls + 1);
  }, SPAWNS);

  test("a claude too old to use is stopped under the relay too", async () => {
    Bun.env.FAKE_CLAUDE_VERSION = "2.1.100";
    const s = session(project());
    s.child.stdin.write("x\n");
    const done = await s.done();
    expect(done.exit).toEqual([1, null]);
    expect(done.out).toBe("");
    expect(done.err).toContain("older than the");
  }, SPAWNS);
});

describe("without the relay", () => {
  test("a host without python3 3.6 starts claude as it is, saying so once", async () => {
    // A python3 too old for the relay, first on the PATH claude gets.
    const bin = join(host.home, ".local", "bin", "python3");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    rmSync(join(host.home, RELAY_PATH), { force: true });
    chmodSync(bin, 0o755);
    try {
      const s = session(project());
      s.child.stdin.end("hi\n");
      const done = await s.done();
      expect(done.out).toBe(`${BANNER}hi\n`);
      expect(done.exit).toEqual([0, null]);
      expect(done.err).toContain("box has no python3 3.6 or later, so a dropped connection ends the session's claude");
      expect(host.calls().every((c) => !c.includes(" attach "))).toBe(true);
      // Uploaded nothing for a relay it can't run.
      expect(existsSync(join(host.home, RELAY_PATH))).toBe(false);
    } finally {
      rmSync(bin);
    }
  }, SPAWNS);

  test("CC_REMOTE_RECONNECT_GRACE=0 turns it off; one-off runs never use it", async () => {
    Bun.env.CC_REMOTE_RECONNECT_GRACE = "0";
    const s = session(project());
    s.child.stdin.end("hi\n");
    expect((await s.done()).out).toBe(`${BANNER}hi\n`);
    expect(host.calls()[0]).not.toContain(" run ");
    delete Bun.env.CC_REMOTE_RECONNECT_GRACE;
    host.reset();
    const p = session(project(), ["-p"]);
    p.child.stdin.end();
    await p.done();
    expect(host.calls()[0]).not.toContain("python3");
    expect(hostDir(dir)).toContain(".cc-remote/ws/");
  }, SPAWNS);
});
