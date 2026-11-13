import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { F, type Frame, FrameReader, frame, GONE_TOKEN, ProtocolError, RELAY_HASH, RELAY_PATH, RELAY_SOURCE, RelayClient } from "../src/relay";

const RELAY = join(import.meta.dir, "..", "src", "relay.py");
const dir = mkdtempSync(join(tmpdir(), "cc-remote-relay-"));
afterAll(() => {
  // A case that failed half way may have left a daemon running from one of its homes.
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.some((e) => e.startsWith(`HOME=${dir}/`))) process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

// Tests here start python and wait on processes, which takes seconds on a busy machine.
const SPAWNS = 30_000;

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** A RelayClient whose sends and events are recorded. */
function recorded() {
  const sent: Frame[] = [];
  const reader = new FrameReader();
  let out = "";
  const exits: [number | null, string | null][] = [];
  let hellos = 0;
  const client = new RelayClient({
    output: (b) => (out += decode(b)),
    stderr: () => {},
    exit: (code, signal) => exits.push([code, signal]),
    hello: () => hellos++,
  });
  const connect = () => client.connect((b) => sent.push(...reader.push(b)));
  return { client, sent, connect, out: () => out, exits, hellos: () => hellos };
}

describe("frames", () => {
  test("round-trip with large values, cut anywhere", () => {
    const frames = [frame(F.OUT, 2 ** 40 + 5, text("hello")), frame(F.PING, 7), frame(F.IN, 0, new Uint8Array(70_000).fill(1))];
    const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      bytes.set(f, at);
      at += f.length;
    }
    for (const step of [1, 7, 13, 4096, bytes.length]) {
      const reader = new FrameReader();
      const got: Frame[] = [];
      for (let i = 0; i < bytes.length; i += step) got.push(...reader.push(bytes.subarray(i, i + step)));
      expect(got.map((f) => [f.type, f.value, f.payload.length])).toEqual([[F.OUT, 2 ** 40 + 5, 5], [F.PING, 7, 0], [F.IN, 0, 70_000]]);
      expect(decode(got[0]!.payload)).toBe("hello");
    }
  });

  test("refuse a stream that can't be the relay's", () => {
    const bad = new Uint8Array(13);
    new DataView(bad.buffer).setUint32(9, 0xffffffff);
    expect(() => new FrameReader().push(bad)).toThrow(ProtocolError);
  });
});

describe("RelayClient", () => {
  test("delivers claude's output once, however the daemon replays it", () => {
    const r = recorded();
    r.connect();
    r.client.receive(frame(F.HELLO, 0));
    r.client.receive(frame(F.OUT, 0, text("abc")));
    r.client.receive(frame(F.OUT, 3, text("def")));
    // A replay after a reconnect starts at what the client said it had, or overlaps it.
    r.client.receive(frame(F.OUT, 0, text("abcdef")));
    r.client.receive(frame(F.OUT, 4, text("efgh")));
    expect(r.out()).toBe("abcdefgh");
    expect(r.client.outReceived).toBe(8);
    expect(() => r.client.receive(frame(F.OUT, 10, text("x")))).toThrow(ProtocolError);
  });

  test("says where its output stands on each connection and acknowledges what arrived", () => {
    const r = recorded();
    r.connect();
    expect(r.sent.map((f) => [f.type, f.value])).toEqual([[F.HELLO_CLIENT, 0]]);
    r.client.receive(frame(F.HELLO, 0));
    r.client.receive(frame(F.OUT, 0, text("12345")));
    r.client.ping();
    expect(r.sent.slice(1).map((f) => f.type)).toEqual([F.PING, F.OUT_ACK]);
    expect(r.sent.at(-1)!.value).toBe(5);
    r.client.disconnect();
    r.sent.length = 0;
    r.connect();
    expect(r.sent[0]).toMatchObject({ type: F.HELLO_CLIENT, value: 5 });
  });

  test("keeps input until the daemon acknowledges it, and sends the rest again on a new connection", () => {
    const r = recorded();
    r.connect();
    r.client.write(text("one\n"));
    r.client.write(text("two\n"));
    r.client.receive(frame(F.IN_ACK, 4));
    expect(r.client.unacknowledged).toBe(4);
    r.client.disconnect();
    // Written while no connection is there: kept, sent later.
    r.client.write(text("three\n"));
    r.client.end();
    r.client.terminate();
    r.sent.length = 0;
    r.connect();
    const ins = r.sent.filter((f) => f.type === F.IN);
    expect(ins.map((f) => [f.value, decode(f.payload)])).toEqual([[4, "two\n"], [8, "three\n"]]);
    expect(r.sent.find((f) => f.type === F.CLOSE_IN)!.value).toBe(14);
    expect(r.sent.some((f) => f.type === F.TERM)).toBe(true);
    // A hello that acknowledges part of a chunk keeps the rest.
    r.client.receive(frame(F.HELLO, 10));
    r.sent.length = 0;
    r.connect();
    expect(r.sent.filter((f) => f.type === F.IN).map((f) => [f.value, decode(f.payload)])).toEqual([[10, "ree\n"]]);
    expect(() => r.client.receive(frame(F.IN_ACK, 99))).toThrow(ProtocolError);
  });

  test("an exit acknowledges everything, says bye once, and fails the commands still waiting", async () => {
    const r = recorded();
    r.connect();
    const pending = r.client.exec("true");
    r.client.receive(frame(F.OUT, 0, text("last")));
    r.client.receive(frame(F.EXIT, 0, text("SIGTERM")));
    r.client.receive(frame(F.EXIT, 0, text("SIGTERM")));
    expect(r.exits).toEqual([[null, "SIGTERM"]]);
    expect(r.sent.filter((f) => f.type === F.BYE)).toHaveLength(1);
    expect(r.sent.find((f) => f.type === F.OUT_ACK)!.value).toBe(4);
    await expect(pending).rejects.toThrow("exited");
    const other = recorded();
    other.connect();
    other.client.receive(frame(F.EXIT, 3));
    expect(other.exits).toEqual([[3, null]]);
  });

  test("routes command results by id and asks again after a reconnect", async () => {
    const r = recorded();
    r.connect();
    const a = r.client.exec("echo a", text("in"));
    const b = r.client.exec("echo b");
    const request = r.sent.find((f) => f.type === F.EXEC)!;
    const size = new DataView(request.payload.buffer, request.payload.byteOffset).getUint32(0);
    expect(decode(request.payload.subarray(4, 4 + size))).toBe("echo a");
    expect(decode(request.payload.subarray(4 + size))).toBe("in");
    r.client.disconnect();
    r.sent.length = 0;
    r.connect();
    expect(r.sent.filter((f) => f.type === F.EXEC).map((f) => f.value)).toEqual([1, 2]);
    const result = (id: number, code: number, out: string, err: string) => {
      const o = text(out);
      const payload = new Uint8Array(8 + o.length + err.length);
      new DataView(payload.buffer).setInt32(0, code);
      new DataView(payload.buffer).setUint32(4, o.length);
      payload.set(o, 8);
      payload.set(text(err), 8 + o.length);
      return frame(F.RESULT, id, payload);
    };
    r.client.receive(result(2, 1, "", "nope"));
    r.client.receive(result(1, 0, "a\n", ""));
    r.client.receive(result(1, 0, "dup", ""));
    expect(await a).toMatchObject({ code: 0, err: "" });
    expect(decode((await a).out)).toBe("a\n");
    expect(await b).toMatchObject({ code: 1, err: "nope" });
  });
});

describe("relay.py", () => {
  /** A home for the relay's run folders, and a way to talk to it as cc-remote does, over python's stdio. */
  function host(home = mkdtempSync(join(dir, "home-"))) {
    const events = { out: "", err: "", exits: [] as [number | null, string | null][], hellos: 0 };
    const client = new RelayClient({
      output: (b) => (events.out += decode(b)),
      stderr: (b) => (events.err += decode(b)),
      exit: (code, signal) => events.exits.push([code, signal]),
      hello: () => events.hellos++,
    });
    let current: ChildProcess | undefined;
    const open = (args: string[]) => {
      const child = spawn("python3", ["-S", RELAY, ...args], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr!.on("data", (b) => (stderr += b));
      child.stdout!.on("data", (b: Buffer) => {
        if (current === child) client.receive(b);
      });
      current = child;
      client.connect((b) => child.stdin!.write(b));
      const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      return { child, closed, stderr: () => stderr };
    };
    const drop = async (c: { child: ChildProcess; closed: Promise<unknown> }) => {
      client.disconnect();
      current = undefined;
      c.child.kill("SIGKILL");
      await c.closed;
    };
    const runs = () => (existsSync(join(home, ".cc-remote", "run")) ? readdirSync(join(home, ".cc-remote", "run")).filter((n) => !n.endsWith(".log")) : []);
    return { home, events, client, open, drop, runs };
  }

  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check();) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(20);
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("is Python 3.6 code, without newer syntax or library calls", () => {
    // Python 3.11's parser checks syntax against an older grammar; the calls are checked by name.
    const check = String.raw`
import ast, sys
src = open(sys.argv[1]).read()
tree = ast.parse(src, feature_version=(3, 6))
keywords = {"capture_output", "text"}
banned = {"asyncio", "dataclasses", "contextvars", "breakpoint", "monotonic_ns", "time_ns",
          "nullcontext", "removeprefix", "removesuffix", "isascii", "fromisoformat", "close_range", "pidfd_open",
          "waitstatus_to_exitcode", "get_running_loop", "create_task", "shlex.join", "memfd_create"}
found = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Attribute) and node.attr in banned: found.add(node.attr)
    if isinstance(node, ast.Name) and node.id in banned: found.add(node.id)
    if isinstance(node, ast.keyword) and node.arg in keywords | banned: found.add(node.arg)
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        for alias in node.names:
            if alias.name.split(".")[0] in banned: found.add(alias.name)
    if isinstance(node, ast.NamedExpr if hasattr(ast, "NamedExpr") else ()): found.add(":=")
print(" ".join(sorted(found)))
`;
    const r = Bun.spawnSync(["python3", "-c", check, RELAY]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("");
  });

  test("goes up under a name that changes with its content", () => {
    expect(RELAY_PATH).toBe(`.cc-remote/bin/relay-${RELAY_HASH}.py`);
    expect(decode(RELAY_SOURCE)).toBe(readFileSync(RELAY, "utf8"));
  });

  test("carries claude's stream across a dropped connection, every byte once each way", async () => {
    const h = host();
    const first = h.open(["run", "a1", "--session", "s-1", "--grace", "30", "--", "sh", "-c", 'while read l; do echo "got:$l"; done; echo end >&2; exit 3']);
    h.client.write(text("one\ntwo\n"));
    await until(() => h.events.out === "got:one\ngot:two\n");
    expect(readFileSync(join(h.home, ".cc-remote", "run", "a1", "session"), "utf8").trim()).toBe("s-1");
    expect(statSync(join(h.home, ".cc-remote", "run", "a1")).mode & 0o777).toBe(0o700);
    expect(statSync(join(h.home, ".cc-remote", "run")).mode & 0o777).toBe(0o700);
    await h.drop(first);
    // Written while the link is down, and right after the reconnect.
    h.client.write(text("three\n"));
    const second = h.open(["attach", "a1"]);
    h.client.write(text("four\n"));
    await until(() => h.events.out.endsWith("got:four\n"));
    expect(h.events.hellos).toBe(2);
    h.client.end();
    await until(() => h.events.exits.length > 0);
    expect(h.events.out).toBe("got:one\ngot:two\ngot:three\ngot:four\n");
    expect(h.events.err).toBe("end\n");
    expect(h.events.exits).toEqual([[3, null]]);
    expect(await second.closed).toBe(0);
    await until(() => h.runs().length === 0);
  }, SPAWNS);

  test("keeps output written while no one is attached, and the bridge's exit closes every inherited fd", async () => {
    const h = host();
    // Output in bursts larger than a frame, some of it while detached.
    const script = 'read l; head -c 300000 /dev/zero | tr "\\0" a; echo; read l; head -c 200000 /dev/zero | tr "\\0" b; echo; read l; true';
    const first = h.open(["run", "b1", "--grace", "30", "--", "sh", "-c", script]);
    h.client.write(text("go\n"));
    await until(() => h.events.out.length >= 300_001);
    await h.drop(first);
    // The next burst happens with no connection: the daemon keeps it.
    h.client.write(text("go\n"));
    await Bun.sleep(300);
    // An attach whose ssh side keeps an extra pipe open, as sshd's channel would: when the bridge
    // ends, the pipe must close, though the daemon lives on.
    const second = h.open(["attach", "b1"]);
    await until(() => h.events.out.length >= 300_001 + 200_001);
    expect(h.events.out).toBe(`${"a".repeat(300_000)}\n${"b".repeat(200_000)}\n`);
    await h.drop(second);
    expect(h.runs()).toEqual(["b1"]);
    // A run whose stdout is held by us: once its bridge goes, its stdout must reach EOF.
    const probe = spawn("python3", ["-S", RELAY, "run", "b2", "--grace", "30", "--", "sleep", "30"], { env: { ...process.env, HOME: h.home }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let eofs = 0;
    for (const s of [probe.stdout!, probe.stderr!, probe.stdio[3] as Readable]) s.on("end", () => eofs++).resume();
    await until(() => existsSync(join(h.home, ".cc-remote", "run", "b2", "pid")));
    const daemon = Number(readFileSync(join(h.home, ".cc-remote", "run", "b2", "pid"), "utf8"));
    probe.kill("SIGKILL");
    await until(() => eofs === 3, 5_000);
    expect(alive(daemon)).toBe(true);
    // Reaping, as a later start of the same session does: b2 has no session, so it stays.
    Bun.spawnSync(["python3", "-S", RELAY, "reap", "s-none"], { env: { ...process.env, HOME: h.home } });
    expect(alive(daemon)).toBe(true);
    process.kill(daemon, "SIGTERM");
    await until(() => !alive(daemon) && !h.runs().includes("b2"));
    // b1 ends at the end of its input.
    const third = h.open(["attach", "b1"]);
    h.client.end();
    await until(() => h.events.exits.length > 0);
    expect(h.events.exits).toEqual([[0, null]]);
    await third.closed;
    await until(() => h.runs().length === 0);
  }, SPAWNS);

  test("stops claude's whole process group when told to, and on its grace running out", async () => {
    const h = host();
    const pids = join(h.home, "pids");
    // claude with a child in its group, both ignoring nothing.
    const first = h.open(["run", "c1", "--grace", "30", "--", "sh", "-c", `sleep 60 & echo $$ $! > ${pids}; wait`]);
    await until(() => existsSync(pids) && readFileSync(pids, "utf8").trim().split(" ").length === 2);
    const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
    h.client.terminate();
    await until(() => h.events.exits.length > 0);
    expect(h.events.exits[0]![1]).toBe("SIGTERM");
    await first.closed;
    await until(() => !alive(shell!) && !alive(sleeper!) && h.runs().length === 0);

    // No one attached: after the grace, SIGTERM, then SIGKILL for what ignores it.
    const g = host();
    const stubborn = join(g.home, "stubborn");
    const second = g.open(["run", "c2", "--grace", "1", "--", "sh", "-c", `trap '' TERM; echo $$ > ${stubborn}; while :; do sleep 1; done`]);
    await until(() => existsSync(stubborn) && readFileSync(stubborn, "utf8").trim() !== "");
    const pid = Number(readFileSync(stubborn, "utf8"));
    await g.drop(second);
    expect(alive(pid)).toBe(true);
    await until(() => !alive(pid) && g.runs().length === 0, 15_000);
  }, SPAWNS);

  test("reap stops the daemons of a session, and attach then finds none", async () => {
    const h = host();
    const first = h.open(["run", "d1", "--session", "sess-x", "--grace", "30", "--", "sleep", "60"]);
    await until(() => h.events.hellos === 1 && existsSync(join(h.home, ".cc-remote", "run", "d1", "session")));
    const daemon = Number(readFileSync(join(h.home, ".cc-remote", "run", "d1", "pid"), "utf8"));
    await h.drop(first);
    // A stale folder with no daemon behind it goes too, but not one of another machine sharing this home.
    mkdirSync(join(h.home, ".cc-remote", "run", "dead"));
    writeFileSync(join(h.home, ".cc-remote", "run", "dead", "session"), "sess-x\n");
    mkdirSync(join(h.home, ".cc-remote", "run", "elsewhere"));
    writeFileSync(join(h.home, ".cc-remote", "run", "elsewhere", "session"), "sess-x\n");
    writeFileSync(join(h.home, ".cc-remote", "run", "elsewhere", "host"), "another-machine\n");
    const reap = Bun.spawnSync(["python3", "-S", RELAY, "reap", "sess-x"], { env: { ...process.env, HOME: h.home } });
    expect(reap.exitCode).toBe(0);
    expect(alive(daemon)).toBe(false);
    expect(h.runs()).toEqual(["elsewhere"]);
    rmSync(join(h.home, ".cc-remote", "run", "elsewhere"), { recursive: true });
    const gone = h.open(["attach", "d1"]);
    expect(await gone.closed).toBe(3);
    expect(gone.stderr()).toContain(GONE_TOKEN);
  }, SPAWNS);

  test("reap stops a live daemon under a home too long for an absolute socket path", async () => {
    // Over the 108 bytes a socket path may have, counted from /.
    const home = join(mkdtempSync(join(dir, "home-")), "h".repeat(120));
    mkdirSync(home);
    const h = host(home);
    const first = h.open(["run", "l1", "--session", "sess-long", "--grace", "30", "--", "sleep", "60"]);
    await until(() => h.events.hellos === 1 && existsSync(join(home, ".cc-remote", "run", "l1", "session")));
    const daemon = Number(readFileSync(join(home, ".cc-remote", "run", "l1", "pid"), "utf8"));
    await h.drop(first);
    const reap = Bun.spawnSync(["python3", "-S", RELAY, "reap", "sess-long"], { env: { ...process.env, HOME: home } });
    expect(reap.exitCode).toBe(0);
    expect(alive(daemon)).toBe(false);
    expect(h.runs()).toEqual([]);
  }, SPAWNS);

  test("runs commands for cc-remote, and reports a claude that can't start as claude would", async () => {
    const h = host();
    const first = h.open(["run", "e1", "--grace", "30", "--", "cat"]);
    const r = await h.client.exec("printf 'x%s' \"$(cat)\"; echo oops >&2; exit 4", text("in"));
    expect(decode(r.out)).toBe("xin");
    expect(r).toMatchObject({ code: 4, err: "oops\n" });
    h.client.end();
    await until(() => h.events.exits.length > 0);
    await first.closed;

    const g = host();
    g.open(["run", "e2", "--grace", "30", "--", "no-such-claude-here"]);
    await until(() => g.events.exits.length > 0);
    expect(g.events.exits).toEqual([[127, null]]);
    expect(g.events.err).toContain("cannot run no-such-claude-here");
    await until(() => g.runs().length === 0);
  }, SPAWNS);
});
