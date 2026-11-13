import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/setup/index";
import { versionCache } from "../src/version";
import { fakeHost } from "./fakehost";
import { fakeOrca } from "./fakeorca";

/**
 * A whole machine for setup's flow tests, in a temporary folder: a home with a managed cc-remote
 * install (a script running this checkout), a fake central server, a PATH of stub tools (sudo and
 * apt-get that record their calls; apt-get "installs" rg and git), an os-release, and optionally a
 * fake Orca Server in ~/.orca whose pid is a `sleep` started with this world's environment.
 * Nothing real is read or written: not ~/.ssh, ~/.config, ~/.cache, ~/.local, nor ~/.orca.
 */
const BUN = process.execPath;
const CHMOD = Bun.which("chmod") ?? "/bin/chmod";
const MAIN = join(import.meta.dir, "..", "src", "main.ts");

export type World = ReturnType<typeof world>;

export function world(options: { orca?: boolean | { legacy?: boolean }; tools?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccr-setup-"));
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const links = join(dir, "links");
  for (const d of [home, stubs, links]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const host = fakeHost(join(dir, "fake"));
  const calls = join(dir, "calls.log");

  // The managed install: versions/0.1.0/cc-remote, and the stable link to it.
  const version = join(home, ".local", "share", "cc-remote", "versions", "0.1.0");
  mkdirSync(version, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(version, "cc-remote"), `#!/bin/sh\nexec ${BUN} ${MAIN} "$@"\n`, { mode: 0o755 });
  symlinkSync(join(version, "cc-remote"), join(home, ".local", "bin", "cc-remote"));

  // Real tools setup may run here; rg and git are missing until apt-get "installs" them.
  const stub = (name: string, body: string) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const t of options.tools ?? ["sh", "bash", "grep", "ssh-keygen"]) {
    // rg and git as stubs, so the tests don't depend on what this machine has installed.
    if (t === "rg") stub("rg", 'echo "ripgrep 13.0.0"');
    else if (t === "git") stub("git", 'echo "git version 2.39.5"');
    else if (Bun.which(t)) symlinkSync(Bun.which(t)!, join(links, t));
  }
  stub("sudo", `printf 'sudo %s\\n' "$*" >> ${calls}\n[ "$1" = -n ] && shift\nexec "$@"`);
  stub("apt-get", `printf 'apt-get %s\\n' "$*" >> ${calls}\nfor p; do case "$p" in ripgrep) printf '#!/bin/sh\\necho "ripgrep 13.0.0"\\n' > ${stubs}/rg; ${CHMOD} 755 ${stubs}/rg;; git) printf '#!/bin/sh\\necho "git version 2.39.5"\\n' > ${stubs}/git; ${CHMOD} 755 ${stubs}/git;; esac; done`);
  stub("ssh-copy-id", `printf 'ssh-copy-id %s\\n' "$*" >> ${calls}\n${Bun.which("mkdir")} -p "$FAKE_HOST_HOME/.ssh" && ${Bun.which("cat")} "$2" >> "$FAKE_HOST_HOME/.ssh/authorized_keys" && echo "Number of key(s) added: 1"`);
  const osRelease = join(dir, "os-release");
  writeFileSync(osRelease, 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12"\n');

  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host central\n    HostName 203.0.113.7\n    User me\n", { mode: 0o600 });

  const env: Record<string, string> = {
    HOME: home,
    PATH: `${join(home, ".local", "bin")}:${stubs}:${links}`,
    SHELL: Bun.which("bash") ?? "/bin/bash",
    LANG: "en_US.UTF-8",
    XDG_CACHE_HOME: join(home, ".cache"),
    CC_REMOTE_RELEASE_API: "http://127.0.0.1:9/",
    FAKE_AUTH_STATUS: "in",
    FAKE_HELP: "auto",
    FAKE_HOST_PATH: "/usr/bin:/bin",
    ...host.env,
  };

  let orca: ReturnType<typeof fakeOrca> | undefined;
  let sleeper: ReturnType<typeof Bun.spawn> | undefined;
  if (options.orca) {
    // orcad's environment, which the end-to-end check reads from /proc/<pid>/environ.
    sleeper = Bun.spawn([Bun.which("sleep")!, "600"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    orca = fakeOrca(join(home, ".orca"), { pid: sleeper.pid, legacy: typeof options.orca === "object" && options.orca.legacy });
  }

  return {
    dir, home, host, env, osRelease, orca, stubs,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []),
    stable: join(home, ".local", "bin", "cc-remote"),
    file: (...p: string[]) => join(home, ...p),
    cleanup() {
      orca?.stop();
      sleeper?.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every file and folder under a path with its mode, size and modification time. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let info;
    try {
      info = lstatSync(p);
    } catch {
      return;
    }
    out.push(`${p} ${info.mode.toString(8)} ${info.isDirectory() ? "-" : info.size} ${info.isDirectory() ? "-" : info.mtimeMs}`);
    if (info.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(root);
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
export const plain = (s: string) => s.replace(ANSI, "");

/** An answer to give once the output since the last one matches. */
export type Answer = { expect: RegExp; keys: string[] };

/**
 * Runs `cc-remote setup` in this process, as from a terminal when `tty`: the world's environment
 * becomes process.env for the run (rsh() reads it there), and keystrokes are typed as prompts
 * appear. Returns the exit status, the output without ANSI codes, and the answers left unused.
 */
export async function runSetup(w: World, argv: string[], options: { tty?: boolean; answers?: Answer[]; env?: Record<string, string> } = {}) {
  const saved = { ...process.env };
  const savedCache = versionCache.dir;
  for (const k of Object.keys(process.env)) if (/^(CC_REMOTE_|FAKE_|ORCA_|XDG_|SSH_AUTH_SOCK|SSH_AGENT|NO_COLOR|FORCE_COLOR|LC_|LANG)/.test(k)) delete process.env[k];
  Object.assign(process.env, w.env, options.env ?? {});
  versionCache.dir = join(w.home, ".cache", "cc-remote");
  const stdin = Object.assign(new PassThrough(), { isTTY: !!options.tty, setRawMode() { return stdin; } });
  const stdout = Object.assign(new PassThrough(), { isTTY: !!options.tty, columns: 120 });
  let text = "";
  stdout.on("data", (d: Buffer) => {
    text += d.toString();
  });
  const pending = [...(options.answers ?? [])];
  let done = false;
  const typist = (async () => {
    let seen = 0;
    while (!done) {
      const next = pending[0];
      if (next && next.expect.test(plain(text.slice(seen)))) {
        seen = text.length;
        pending.shift();
        for (const key of next.keys) {
          await Bun.sleep(15);
          stdin.write(key);
        }
        continue;
      }
      await Bun.sleep(15);
    }
  })();
  try {
    const code = await main(argv, { stdin, stdout, env: process.env, osRelease: w.osRelease, root: false });
    return { code, out: plain(text), left: pending.length };
  } finally {
    done = true;
    await typist;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    versionCache.dir = savedCache;
  }
}

export const chmod = chmodSync;
