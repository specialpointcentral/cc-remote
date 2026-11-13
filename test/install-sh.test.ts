import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh against a fake release server, with `uname`, `sysctl` and `ldd` stubbed to stand for
 * other machines, in a temporary home. The release binary is a script that prints its version and
 * records any other run (setup) to a file.
 */
const SCRIPT = join(import.meta.dir, "..", "install.sh");
const requests: string[] = [];
let tamper = false;
let server: ReturnType<typeof Bun.serve>;
const binary = (version: string) => `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version} (cc-remote, claude-agent-acp 0.99.1)"; exit 0; fi\nprintf '%s\\n' "$*" >> "$HOME/ran"\n`;
const sum = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const m = path.match(/^\/(?:latest\/download|download\/v([^/]+))\/(.+)$/);
      if (!m) return new Response("no", { status: 404 });
      const version = m[1] ?? "0.3.0";
      const names = ["cc-remote-linux-x64", "cc-remote-linux-arm64", "cc-remote-darwin-arm64"];
      if (m[2] === "SHA256SUMS") return new Response(names.map((n) => `${sum(tamper ? "x" : binary(version))}  ${n}`).join("\n") + "\n");
      return names.includes(m[2]!) ? new Response(binary(version)) : new Response("no", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  tamper = false;
  requests.length = 0;
});

/** Runs install.sh as a machine with this uname (and sysctl/ldd answers). */
async function run(args: string[], machine: { s?: string; m?: string; translated?: string; musl?: boolean } = {}, env: Record<string, string> = {}, existing?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "ccr-install-"));
  dirs.push(home);
  const stubs = join(home, "stubs");
  mkdirSync(stubs);
  const stub = (name: string, body: string) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("uname", `case "$1" in -s) echo "${machine.s ?? "Linux"}";; -m) echo "${machine.m ?? "x86_64"}";; *) echo "${machine.s ?? "Linux"}";; esac`);
  stub("sysctl", `echo "${machine.translated ?? "0"}"`);
  stub("ldd", machine.musl ? 'echo "musl libc (x86_64)" >&2; exit 1' : 'echo "ldd (GNU libc) 2.36"');
  writeFileSync(join(home, ".bashrc"), "# mine\n");
  writeFileSync(join(home, ".profile"), "# mine\n");
  existing?.(home);
  // Not spawnSync: the release server answers from this same process.
  const r = Bun.spawn(["sh", SCRIPT, ...args], {
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, CC_REMOTE_RELEASE_BASE: server.url.href.replace(/\/$/, ""), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text()]);
  return { code: await r.exited, out, err, home };
}

describe("install.sh", () => {
  test("installs the latest release in the versioned layout, without touching shell startup files", async () => {
    const r = await run(["--no-setup"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const stable = join(r.home, ".local", "bin", "cc-remote");
    expect(readlinkSync(stable)).toBe(join(r.home, ".local", "share", "cc-remote", "versions", "0.3.0", "cc-remote"));
    expect(lstatSync(join(r.home, ".local", "share", "cc-remote", "versions", "0.3.0")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(r.home, ".local", "share", "cc-remote", "install.json"), "utf8"))).toMatchObject({ current: "0.3.0", source: "github:specialpointcentral/cc-remote" });
    expect(lstatSync(join(r.home, ".local", "share", "cc-remote", "install.json")).mode & 0o777).toBe(0o600);
    expect(r.out).toContain("0.3.0 (cc-remote, claude-agent-acp 0.99.1)");
    expect(r.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(readFileSync(join(r.home, ".bashrc"), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(r.home, ".profile"), "utf8")).toBe("# mine\n");
    expect(requests).toEqual(["/latest/download/cc-remote-linux-x64", "/latest/download/SHA256SUMS"]);
    expect(readdirSync(join(r.home, ".local", "share", "cc-remote", "versions"))).toEqual(["0.3.0"]);
  });

  test("CC_REMOTE_VERSION installs that release and records the previous one", async () => {
    const r = await run(["--no-setup"], {}, { CC_REMOTE_VERSION: "0.2.1" }, (home) => {
      mkdirSync(join(home, ".local", "share", "cc-remote"), { recursive: true });
      writeFileSync(join(home, ".local", "share", "cc-remote", "install.json"), '{"current":"0.2.0"}');
    });
    expect(r.code).toBe(0);
    expect(requests[0]).toBe("/download/v0.2.1/cc-remote-linux-x64");
    expect(JSON.parse(readFileSync(join(r.home, ".local", "share", "cc-remote", "install.json"), "utf8"))).toMatchObject({ current: "0.2.1", previous: "0.2.0" });
  });

  test("a checksum mismatch installs nothing", async () => {
    tamper = true;
    const r = await run(["--no-setup"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("doesn't match SHA256SUMS");
    expect(existsSync(join(r.home, ".local", "bin", "cc-remote"))).toBe(false);
    expect(readdirSync(join(r.home, ".local", "share", "cc-remote", "versions"))).toEqual([]);
  });

  test("maps machines to builds: arm64 Linux, Apple Silicon under Rosetta; refuses Intel Macs and musl", async () => {
    expect((await run(["--no-setup"], { m: "aarch64" })).code).toBe(0);
    expect(requests.at(-2)).toBe("/latest/download/cc-remote-linux-arm64");
    expect((await run(["--no-setup"], { s: "Darwin", m: "x86_64", translated: "1" })).code).toBe(0);
    expect(requests.at(-2)).toBe("/latest/download/cc-remote-darwin-arm64");
    const intel = await run(["--no-setup"], { s: "Darwin", m: "x86_64" });
    expect(intel.code).toBe(1);
    expect(intel.err).toContain("no build for Intel Macs");
    const musl = await run(["--no-setup"], { musl: true });
    expect(musl.code).toBe(1);
    expect(musl.err).toContain("musl");
  });

  test("an existing regular file at the stable path is moved aside, not lost", async () => {
    const r = await run(["--no-setup"], {}, {}, (home) => {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "cc-remote"), "old copy");
    });
    expect(r.code).toBe(0);
    const aside = readdirSync(join(r.home, ".local", "bin")).find((f) => f.startsWith("cc-remote.unmanaged-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(r.home, ".local", "bin", aside!), "utf8")).toBe("old copy");
    expect(r.out).toContain("Moved the existing");
  });

  test("runs setup afterwards with the arguments it was given", async () => {
    const r = await run(["--host", "central", "--yes"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.home, "ran"), "utf8")).toBe("setup --host central --yes\n");
  });
});
