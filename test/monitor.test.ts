import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Watcher, WatchLink } from "../src/host-process";
import { type MonitorInput, Monitors } from "../src/monitor";
import { resetLocalSettings } from "../src/local-settings";
import { stopping } from "../src/tools/shell";
import { workspace } from "../src/tools/util";
import { isolate } from "./fixture";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-remote-monitor-")));
let env: ReturnType<typeof isolate>;
const grace = stopping.graceMs;
beforeAll(() => {
  env = isolate();
  stopping.graceMs = 500;
});
afterAll(() => {
  stopping.graceMs = grace;
  env.restore();
  resetLocalSettings();
  rmSync(dir, { recursive: true, force: true });
});

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
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

/** A link that records what each watch sends, and how far behind the host is said to be. */
function link() {
  const out = new Map<number, string>();
  const err = new Map<number, string>();
  const ends = new Map<number, number>();
  let watcher: Watcher | undefined;
  let behind = 0;
  const l: WatchLink = {
    serve: (w) => (watcher = w),
    output: (id, chunk) => out.set(id, (out.get(id) ?? "") + decode(chunk)),
    stderr: (id, chunk) => err.set(id, (err.get(id) ?? "") + decode(chunk)),
    end: (id, code) => ends.set(id, code),
    pending: () => behind,
  };
  return { l, out, err, ends, watcher: () => watcher!, behind: (n: number) => (behind = n) };
}

let projects = 0;
function setup() {
  const root = join(dir, `project-${++projects}`);
  mkdirSync(join(root, "sub"), { recursive: true });
  const ws = workspace(root);
  const k = link();
  const monitors = new Monitors(ws, k.l);
  const token = (input: MonitorInput) => /monitor ([0-9a-f]{32}) /.exec(String(input.command))![1]!;
  return { root, ws, k, monitors, token };
}

describe("Monitors", () => {
  test("approve rewrites a call into a monitor process of the relay's, readable and keeping its other fields", () => {
    const { monitors, k } = setup();
    expect(k.watcher()).toBe(monitors);
    const input = { command: "tail -f log | grep --line-buffered 'it''s'", description: "errors", timeout_ms: 60_000, persistent: false };
    const rewritten = monitors.approve(input);
    expect(rewritten.command).toMatch(/^"\$CC_REMOTE_PYTHON" -S "\$CC_REMOTE_RELAY" monitor [0-9a-f]{32} 'tail -f log \| grep --line-buffered '\\''it'\\'''\\''s'\\'''$/);
    expect({ ...rewritten, command: undefined }).toEqual({ ...input, command: undefined });
    const socket = monitors.approve({ ws: { url: "ws://localhost:3000/events" }, description: "events", timeout_ms: 1000 });
    expect(socket.ws).toBeUndefined();
    expect(socket.command).toEndWith(" 'ws://localhost:3000/events'");
    // Each call has a token of its own.
    expect(monitors.approve(input).command).not.toBe(rewritten.command);
  });

  test("find and answered: a prompt shows the model's input, and an edited answer gets a new approval", () => {
    const { monitors } = setup();
    const input = { command: "npm run dev", description: "dev", timeout_ms: 1000 };
    const rewritten = monitors.approve(input, true);
    const approval = monitors.find(rewritten)!;
    expect(approval.input).toEqual(input);
    expect(approval.ask).toBe(true);
    expect(monitors.find({ command: "npm run dev" })).toBeUndefined();
    expect(monitors.find(undefined)).toBeUndefined();
    expect(monitors.answered(approval, { ...input })).toBe(rewritten);
    expect(monitors.answered(approval, undefined)).toBe(rewritten);
    const edited = monitors.answered(approval, { ...input, command: "npm run dev -- --port 4000" });
    expect(edited.command).toEndWith(" 'npm run dev -- --port 4000'");
    expect(monitors.find(edited)!.input.command).toBe("npm run dev -- --port 4000");
  });

  test("runs the command here, once, in the shell's directory when it was asked, and reports its end", async () => {
    const { monitors, k, ws, root, token } = setup();
    ws.cwd = join(root, "sub");
    const t = token(monitors.approve({ command: "pwd; echo oops >&2; echo two; exit 4" }));
    ws.cwd = root;
    monitors.start(1, t);
    await until(() => k.ends.has(1));
    expect(k.out.get(1)).toBe(`${join(root, "sub")}\ntwo\n`);
    expect(k.err.get(1)).toBe("oops\n");
    expect(k.ends.get(1)).toBe(4);
    // The token was used up.
    monitors.start(2, t);
    expect(k.ends.get(2)).toBe(1);
    expect(k.err.get(2)).toContain("not approved here, or was run already");
    monitors.start(3, "0".repeat(32));
    expect(k.ends.get(3)).toBe(1);
  }, 20_000);

  test("the user's deny rules hold when the command starts", async () => {
    const { monitors, k, token } = setup();
    const t = token(monitors.approve({ command: "rm -rf build" }));
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(join(env.home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    resetLocalSettings();
    try {
      monitors.start(1, t);
      expect(k.ends.get(1)).toBe(1);
      expect(k.err.get(1)).toContain("denied");
    } finally {
      rmSync(join(env.home, ".claude", "settings.json"), { force: true });
      resetLocalSettings();
    }
  });

  test("a closed watch stops the command's whole process group, with no end reported", async () => {
    const { monitors, k, root, token } = setup();
    const pids = join(root, "pids");
    monitors.start(1, token(monitors.approve({ command: `sleep 30 & echo $! > ${pids}; echo up; wait` })));
    await until(() => k.out.get(1) === "up\n");
    const child = Number(readFileSync(pids, "utf8"));
    expect(alive(child)).toBe(true);
    monitors.closed(1);
    await until(() => !alive(child));
    await Bun.sleep(100);
    expect(k.ends.has(1)).toBe(false);
  }, 20_000);

  test("stdout waits while the host is behind, and goes on once it catches up", async () => {
    const { monitors, k, token } = setup();
    k.behind(2 << 20);
    // The command exits long before the host catches up: its last output still goes.
    monitors.start(1, token(monitors.approve({ command: "echo first; echo second; exit 3" })));
    await Bun.sleep(1_500);
    expect(k.out.get(1)).toBeUndefined();
    expect(k.ends.has(1)).toBe(false);
    k.behind(0);
    monitors.acked(1);
    await until(() => k.ends.has(1));
    expect(k.out.get(1)).toBe("first\nsecond\n");
    expect(k.ends.get(1)).toBe(3);
  }, 20_000);

  test("a WebSocket watch opens here: a line per text frame, a placeholder for binary ones, and its close ends it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open(ws) {
          ws.send("hello");
          ws.send("two\nlines");
          ws.send(new Uint8Array([1, 2, 3]));
          ws.close(1000, "done");
        },
        message() {},
      },
    });
    try {
      const { monitors, k, token } = setup();
      monitors.start(1, token(monitors.approve({ ws: { url: `ws://127.0.0.1:${server.port}/` } })));
      await until(() => k.ends.has(1));
      expect(k.out.get(1)).toBe("hello\ntwo\\nlines\n[binary frame, 3 bytes]\n");
      expect(k.ends.get(1)).toBe(0);
      monitors.start(2, token(monitors.approve({ ws: { url: "not a url" } })));
      await until(() => k.ends.has(2));
      expect(k.ends.get(2)).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
