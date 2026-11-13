import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, type Fs, installed, layout } from "../src/install/layout";
import { inUse } from "../src/update/inuse";
import { main } from "../src/update/index";
import { checksumFor } from "../src/update/release";

/**
 * `cc-remote update` against a fake GitHub (the latest-release API, the assets and SHA256SUMS on
 * a local server) and a managed install in a temporary home. The "binaries" are shell scripts
 * that print their version and play doctor; a running old version is a copy of the real `sleep`.
 */
const ASSET = `cc-remote-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
type Doctor = "ok" | "old" | "unreachable";
const releases = new Map<string, { body: string; sum?: string }>();
let latest = "0.3.0";
let server: ReturnType<typeof Bun.serve>;
const requests: string[] = [];

/** A release whose binary prints `version` (or `prints`) and whose doctor behaves as told. */
function release(version: string, options: { doctor?: Doctor; prints?: string; badSum?: boolean } = {}) {
  const doctor = {
    ok: 'echo "remote claude: 2.1.323 (Claude Code)"; echo ok; exit 0',
    old: 'echo "remote claude: 2.1.200 (Claude Code)"; echo "cc-remote: claude on central is 2.1.200, older than the 2.1.400 cc-remote needs." >&2; exit 1',
    unreachable: 'echo "cc-remote: could not run claude on central" >&2; exit 1',
  }[options.doctor ?? "ok"];
  const body = `#!/bin/sh\ncase "$1" in\n  --version) echo "${options.prints ?? version} (cc-remote, claude-agent-acp 0.99.1)";;\n  doctor) [ "$CC_REMOTE_NO_VERSION_CACHE" = 1 ] || { echo "cache not off" >&2; exit 3; }; ${doctor};;\n  *) exec sleep 600;;\nesac\n`;
  const sum = new Bun.CryptoHasher("sha256").update(options.badSum ? `${body}tampered` : body).digest("hex");
  releases.set(version, { body, sum });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === "/api/latest") return Response.json({ tag_name: `v${latest}` });
      const m = path.match(/^\/releases\/(?:download\/v([^/]+)|latest\/download)\/(.+)$/);
      const r = m && releases.get(m[1] ?? latest);
      if (!m || !r) return new Response("not found", { status: 404 });
      if (m[2] === "SHA256SUMS") return new Response(`${r.sum}  ${ASSET}\n${"0".repeat(64)}  cc-remote-other\n`);
      if (m[2] === ASSET) return new Response(r.body);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

let dirs: string[] = [];
let children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const c of children) c.kill();
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  releases.clear();
  latest = "0.3.0";
  requests.length = 0;
});

/** A home with these versions installed (scripts from release()), the first one current. */
function home(versions: string[], options: { host?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccr-update-"));
  dirs.push(dir);
  const env = {
    HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8",
    CC_REMOTE_RELEASE_API: `${server.url}api/latest`, CC_REMOTE_RELEASE_BASE: `${server.url}releases`,
  } as Record<string, string>;
  const l = layout(env, "linux");
  for (const v of versions) {
    if (!releases.has(v)) release(v);
    mkdirSync(join(l.versions, v), { recursive: true, mode: 0o700 });
    writeFileSync(join(l.versions, v, "cc-remote"), releases.get(v)!.body, { mode: 0o755 });
  }
  if (versions.length) {
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    symlinkSync(join(l.versions, versions[0]!, "cc-remote"), l.stable);
    writeFileSync(l.installJson, JSON.stringify({ current: versions[0], previous: versions[1] }), { mode: 0o600 });
  }
  if (options.host) {
    mkdirSync(join(dir, ".config", "cc-remote"), { recursive: true });
    writeFileSync(join(dir, ".config", "cc-remote", "host"), `${options.host}\n`);
  }
  return { dir, env, l };
}

async function update(h: ReturnType<typeof home>, argv: string[] = [], self = { compiled: true, execPath: "/opt/cc-remote" }) {
  let out = "";
  const code = await main(argv, { env: h.env, out: { write: (s: string) => (out += s) }, platform: "linux", self });
  return { code, out };
}

const current = (h: ReturnType<typeof home>) => {
  const state = installed(h.l);
  return state.kind === "managed" ? state.version : state.kind;
};
const install = (h: ReturnType<typeof home>) => JSON.parse(readFileSync(h.l.installJson, "utf8"));

/** Runs a copy of the real `sleep` as the binary of a version, as a session using it would. */
function running(h: ReturnType<typeof home>, version: string) {
  const dir = join(h.l.versions, version);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(join(dir, "cc-remote"), { force: true });
  copyFileSync(realpathSync(Bun.which("sleep")!), join(dir, "cc-remote"));
  const child = Bun.spawn([join(dir, "cc-remote"), "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

describe("cc-remote update", () => {
  test("installs the latest release beside the current one and switches to it", async () => {
    release("0.3.0");
    const h = home(["0.2.0"]);
    const r = await update(h);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updated 0.2.0 → 0.3.0. Running sessions keep 0.2.0 until they end. Undo: cc-remote update --rollback");
    expect(current(h)).toBe("0.3.0");
    expect(install(h)).toMatchObject({ current: "0.3.0", previous: "0.2.0", source: "github:specialpointcentral/cc-remote" });
    expect(lstatSync(h.l.installJson).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(h.l.versions, "0.3.0")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(h.l.versions, "0.3.0", "cc-remote")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(h.l.versions, "0.3.0.partial"))).toBe(false);
    expect((await update(h)).out).toContain("cc-remote 0.3.0 is installed and current.");
  });

  test("never interrupts what runs: a running old version keeps running and is kept; unused ones go", async () => {
    release("0.3.0");
    const h = home(["0.2.0", "0.1.0"]);
    const old = running(h, "0.0.9");
    const current = running(h, "0.2.0");
    release("0.0.8");
    mkdirSync(join(h.l.versions, "0.0.8"), { recursive: true });
    writeFileSync(join(h.l.versions, "0.0.8", "cc-remote"), "unused");
    await Bun.sleep(100);
    const r = await update(h);
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept 0.0.9: still running");
    // Still running, from their own files, after the switch.
    expect(old.exitCode).toBeNull();
    expect(current.exitCode).toBeNull();
    expect(readlinkSync(`/proc/${old.pid}/exe`)).toBe(join(h.l.versions, "0.0.9", "cc-remote"));
    // Current and previous kept, the in-use one kept, 0.1.0 (neither, not running) and 0.0.8 removed.
    expect(existsSync(join(h.l.versions, "0.3.0"))).toBe(true);
    expect(existsSync(join(h.l.versions, "0.2.0"))).toBe(true);
    expect(existsSync(join(h.l.versions, "0.0.9"))).toBe(true);
    expect(existsSync(join(h.l.versions, "0.1.0"))).toBe(false);
    expect(existsSync(join(h.l.versions, "0.0.8"))).toBe(false);
  });

  test("--rollback switches back to the previous version and swaps the record", async () => {
    release("0.3.0");
    const h = home(["0.2.0"]);
    expect((await update(h)).code).toBe(0);
    const r = await update(h, ["--rollback"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Rolled back 0.3.0 → 0.2.0.");
    expect(current(h)).toBe("0.2.0");
    expect(install(h)).toMatchObject({ current: "0.2.0", previous: "0.3.0" });
    expect((await update(h, ["--rollback"])).code).toBe(0);
    expect(current(h)).toBe("0.3.0");
    expect(requests.filter((p) => p.endsWith(ASSET))).toHaveLength(1);
  });

  test("a checksum mismatch aborts: nothing downloaded is kept, nothing switched", async () => {
    release("0.3.0", { badSum: true });
    const h = home(["0.2.0"]);
    const r = await update(h);
    expect(r.code).toBe(1);
    expect(r.out).toContain("doesn't match SHA256SUMS");
    expect(r.out).toContain("Nothing was switched.");
    expect(current(h)).toBe("0.2.0");
    expect(existsSync(join(h.l.versions, "0.3.0"))).toBe(false);
    expect(existsSync(join(h.l.versions, "0.3.0.partial"))).toBe(false);
  });

  test("a binary that reports another version is kept on disk but not switched to", async () => {
    release("0.3.0", { prints: "9.9.9" });
    const h = home(["0.2.0"]);
    const r = await update(h);
    expect(r.code).toBe(1);
    expect(r.out).toContain("didn't report 0.3.0");
    expect(current(h)).toBe("0.2.0");
    expect(existsSync(join(h.l.versions, "0.3.0", "cc-remote"))).toBe(true);
    expect(install(h).current).toBe("0.2.0");
  });

  test("the host check: central's claude must suit the new version; unreachable needs --skip-host-check", async () => {
    release("0.3.0", { doctor: "old" });
    let h = home(["0.2.0"], { host: "central" });
    let r = await update(h);
    expect(r.code).toBe(1);
    expect(r.out).toContain("older than the 2.1.400 cc-remote needs");
    expect(r.out).toContain("Not switched: update claude on central, then run `cc-remote update` again.");
    expect(current(h)).toBe("0.2.0");
    r = await update(h, ["--skip-host-check"]);
    expect(r.code).toBe(1);
    expect(current(h)).toBe("0.2.0");

    release("0.3.0", { doctor: "unreachable" });
    h = home(["0.2.0"], { host: "central" });
    r = await update(h);
    expect(r.code).toBe(1);
    expect(r.out).toContain("pass --skip-host-check to switch anyway");
    expect(current(h)).toBe("0.2.0");
    r = await update(h, ["--skip-host-check"]);
    expect(r.code).toBe(0);
    expect(current(h)).toBe("0.3.0");
  });

  test("without a configured host the check is skipped with a notice; with one that's fine, it passes", async () => {
    release("0.3.0");
    let h = home(["0.2.0"]);
    let r = await update(h);
    expect(r.out).toContain("No central server is configured");
    h = home(["0.2.0"], { host: "central" });
    r = await update(h);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Checking central with the new version");
  });

  test("--version installs that release, older ones too", async () => {
    release("0.1.5");
    const h = home(["0.2.0"]);
    const r = await update(h, ["--version", "v0.1.5"]);
    expect(r.code).toBe(0);
    expect(current(h)).toBe("0.1.5");
    expect(install(h)).toMatchObject({ current: "0.1.5", previous: "0.2.0" });
    expect((await update(h, ["--version", "nope"])).code).toBe(2);
  });

  test("--check shows both versions and changes nothing", async () => {
    latest = "0.4.0";
    const h = home(["0.2.0"]);
    const before = readFileSync(h.l.installJson, "utf8");
    const r = await update(h, ["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed: 0.2.0");
    expect(r.out).toContain("latest:    0.4.0");
    expect(r.out).toContain("Update available");
    expect(readFileSync(h.l.installJson, "utf8")).toBe(before);
    expect(requests.at(-1)).toBe("/api/latest");
  });

  test("refuses an install it doesn't manage, and a source checkout", async () => {
    const h = home([]);
    mkdirSync(join(h.dir, ".local", "bin"), { recursive: true });
    writeFileSync(h.l.stable, "#!/bin/sh\n", { mode: 0o755 });
    let r = await update(h);
    expect(r.code).toBe(1);
    expect(r.out).toContain("isn't managed by install.sh");
    rmSync(h.l.stable);
    r = await update(h, [], { compiled: false, execPath: process.execPath });
    expect(r.code).toBe(1);
    expect(r.out).toContain("runs from source");
  });

  test("a release binary run by hand installs the managed layout", async () => {
    release("0.3.0");
    const h = home([]);
    const r = await update(h);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed cc-remote 0.3.0 at ${h.l.stable}.`);
    expect(current(h)).toBe("0.3.0");
  });
});

describe("the switch", () => {
  test("is atomic: the stable path always resolves while versions switch", async () => {
    const h = home(["0.2.0", "0.3.0"]);
    const watcher = Bun.spawn(["sh", "-c", `n=0; while [ $n -lt 3000 ]; do [ -x "$1" ] || { echo gap; exit 1; }; n=$((n+1)); done`, "sh", h.l.stable], { stdout: "pipe" });
    for (let i = 0; i < 400 && watcher.exitCode === null; i++) activate(h.l, i % 2 ? "0.2.0" : "0.3.0");
    expect(await watcher.exited).toBe(0);
  });

  test("Windows: the old file renamed aside, the new one copied in, put back when the copy fails", () => {
    const l = layout({ HOME: "/h", LOCALAPPDATA: "/L" }, "win32");
    expect(l.stable).toBe(join("/L", "cc-remote", "bin", "cc-remote.exe"));
    const files = new Set([l.stable, join(l.versions, "0.3.0", "cc-remote.exe")]);
    const log: string[] = [];
    const fs = (failCopy: boolean): Fs => ({
      rename: (a, b) => { log.push(`rename ${a} ${b}`); files.delete(a); files.add(b); },
      copy: (a, b) => { if (failCopy) throw new Error("busy"); log.push(`copy ${a} ${b}`); files.add(b); },
      symlink: () => { throw new Error("no links on Windows"); },
      remove: (p) => files.delete(p),
      exists: (p) => files.has(p),
    });
    expect(() => activate(l, "0.3.0", fs(true), 42)).toThrow("busy");
    expect(log).toEqual([`rename ${l.stable} ${l.stable}.old-42`, `rename ${l.stable}.old-42 ${l.stable}`]);
    expect(files.has(l.stable)).toBe(true);
    log.length = 0;
    activate(l, "0.3.0", fs(false), 43);
    expect(log).toEqual([`rename ${l.stable} ${l.stable}.old-43`, `copy ${join(l.versions, "0.3.0", "cc-remote.exe")} ${l.stable}`]);
  });

  test("in-use detection: a running file is in use, an idle folder isn't, and unknown platforms keep everything", () => {
    const h = home([]);
    running(h, "0.0.1");
    mkdirSync(join(h.l.versions, "0.0.2"), { recursive: true });
    if (process.platform === "linux") {
      expect(inUse(join(h.l.versions, "0.0.1"))).toBe(true);
      expect(inUse(join(h.l.versions, "0.0.2"))).toBe(false);
    }
    expect(inUse(join(h.l.versions, "0.0.2"), "darwin", () => `p1\nn${join(h.l.versions, "0.0.2", "cc-remote")}\n`)).toBe(true);
    expect(inUse(join(h.l.versions, "0.0.2"), "darwin", () => undefined)).toBeUndefined();
    expect(inUse(join(h.l.versions, "0.0.2"), "freebsd")).toBeUndefined();
  });

  test("SHA256SUMS lines, text and binary mode", () => {
    const sums = `${"a".repeat(64)}  cc-remote-linux-x64\n${"B".repeat(64)} *cc-remote-darwin-arm64\n`;
    expect(checksumFor(sums, "cc-remote-linux-x64")).toBe("a".repeat(64));
    expect(checksumFor(sums, "cc-remote-darwin-arm64")).toBe("b".repeat(64));
    expect(checksumFor(sums, "cc-remote-windows-x64.exe")).toBeUndefined();
  });
});
