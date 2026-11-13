import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { bash as makeBash } from "../src/tools/bash";
import { loginShell, resetSnapshots, snapshotFile, snapshots } from "../src/tools/login";
import { stopping } from "../src/tools/shell";
import { workspace } from "../src/tools/util";
import { call, fixtureShell, isolate } from "./fixture";

/** What the profile leaves behind must reach every command, whether from a login shell or the snapshot. */
const PROFILE = `printf 'login\\n' >> "$FIXTURE_LOGIN_LOG"
export PROFILE_VALUE=from-profile
export PATH="$HOME/toolchain:$PATH"
fixture_function() { printf function-ok; }
umask 027
export SSH_CONNECTION=profile-connection
`;

const COMMAND = `printf '%s|' "$PROFILE_VALUE"; fixture_function; printf '|%s|%s|%s|' "$DEV_CONFIG" "$(umask)" "\${SSH_CONNECTION-unset}"
case ":$PATH:" in *":$HOME/toolchain:"*) printf toolchain ;; esac; echo; echo command-stderr >&2; exit 17`;

let env: ReturnType<typeof isolate>;
let profile: string, shellLog: string, loginLog: string, snapshot: string;
let bash: ReturnType<typeof makeBash>;

beforeEach(() => {
  env = isolate();
  profile = join(env.home, ".bash_profile");
  shellLog = join(env.home, "shell-runs");
  loginLog = join(env.home, "profile-runs");
  writeFileSync(profile, PROFILE);
  Object.assign(process.env, { FIXTURE_SHELL_LOG: shellLog, FIXTURE_LOGIN_LOG: loginLog, DEV_CONFIG: "caller-config", SSH_CONNECTION: "caller-connection" });
  // The shared cache, inside the temporary home.
  snapshots.cacheDir = join(env.home, ".cache", "cc-remote", "shell");
  snapshot = snapshotFile()!;
  bash = makeBash(workspace(env.home));
});
afterEach(() => {
  delete process.env.DEV_CONFIG;
  delete process.env.SSH_CONNECTION;
  env.restore();
});

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const flags = () => lines(shellLog);
const logins = () => lines(loginLog).length;

/** The command's output is the same whichever way the environment was built, apart from per-connection values. */
async function run(command = COMMAND, connection = "caller-connection") {
  const result = await call(bash, { command });
  if (command === COMMAND) {
    expect(result).toEqual({ text: `from-profile|function-ok|caller-config|0027|${connection}|toolchain\ncommand-stderr\nExit code 17`, error: true });
  }
  return result;
}

describe("login shell snapshot", () => {
  test("captures once, then loads the snapshot instead of running the profile", async () => {
    await run();
    // The capture, its two load checks, then the command itself.
    expect(flags()).toEqual(["-lc", "-c", "-c", "-c"]);
    const content = readFileSync(snapshot, "utf8");
    expect(content.startsWith(`# cc-remote shell snapshot (format 1): ${env.shell}\n`)).toBe(true);
    expect(dirname(snapshot)).toBe(join(snapshots.cacheDir, "v1"));
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    // Per-connection values and the command's own pwd file stay with each command.
    for (const absent of ["export SSH_CONNECTION=", "connection", "__CC_REMOTE_PWD"]) expect(content).not.toContain(absent);
    const captured = statSync(snapshot).mtimeMs;
    await run();
    await run();
    expect(logins()).toBe(1);
    expect(flags()).toEqual(["-lc", "-c", "-c", "-c", "-c", "-c"]);
    expect(statSync(snapshot).mtimeMs).toBe(captured);
  });

  test("keeps the working directory and the tool's other behavior", async () => {
    await call(bash, { command: "mkdir -p sub && cd sub" });
    expect((await call(bash, { command: "pwd -P" })).text).toBe(Bun.spawnSync(["realpath", join(env.home, "sub")]).stdout.toString().trim());
    expect(flags().slice(-1)).toEqual(["-c"]);
  });

  test("captures again once a startup file changes", async () => {
    await run();
    await Bun.sleep(30); // past the file system's clock tick
    appendFileSync(profile, "export PROFILE_VALUE=changed\n");
    expect((await call(bash, { command: 'echo "$PROFILE_VALUE"' })).text).toBe("changed");
    expect(logins()).toBe(2);
  });

  test("captures again once the snapshot is too old", async () => {
    snapshots.maxAgeMs = -1;
    await run();
    await run();
    expect(logins()).toBe(2);
    expect(flags().filter((f) => f === "-lc")).toHaveLength(2);
  });

  test("CC_REMOTE_SHELL_SNAPSHOT=off starts a login shell for every command", async () => {
    process.env.CC_REMOTE_SHELL_SNAPSHOT = "off";
    await run(COMMAND, "profile-connection");
    await run(COMMAND, "profile-connection");
    expect(flags()).toEqual(["-lc", "-lc"]);
    expect(existsSync(snapshot)).toBe(false);
  });

  test("a command arriving during a capture starts a login shell", async () => {
    const [a, b] = await Promise.all([call(bash, { command: 'echo "$PROFILE_VALUE"' }), call(bash, { command: 'echo "$PROFILE_VALUE"' })]);
    expect([a.text, b.text]).toEqual(["from-profile", "from-profile"]);
    // The capture and the second command's login shell start together, then the checks and the first command.
    expect(flags().sort()).toEqual(["-c", "-c", "-c", "-lc", "-lc"]);
    expect(logins()).toBe(2);
  });

  test("a snapshot that doesn't load silently is never used, and not retried at once", async () => {
    // Loading this profile's functions changes what printf prints, so the load check fails.
    appendFileSync(profile, "printf() { builtin printf noisy; builtin printf \"$@\"; }\n");
    expect((await call(bash, { command: 'echo "$PROFILE_VALUE"' })).text).toBe("from-profile");
    expect(flags()).toEqual(["-lc", "-c", "-c", "-lc"]);
    expect((await call(bash, { command: 'echo "$PROFILE_VALUE"' })).text).toBe("from-profile");
    expect(flags()).toEqual(["-lc", "-c", "-c", "-lc", "-lc"]);
    expect(existsSync(snapshot)).toBe(false);
  });

  test("a capture that times out falls back to a login shell", async () => {
    // Only the capture sleeps: it runs as `<shell> -lc <script> cc-remote ...`.
    appendFileSync(profile, 'case $0 in cc-remote) sleep 30 ;; esac\n');
    snapshots.captureTimeoutMs = 300;
    const grace = stopping.graceMs;
    stopping.graceMs = 200;
    try {
      const started = Date.now();
      expect((await call(bash, { command: 'echo "$PROFILE_VALUE"' })).text).toBe("from-profile");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(flags()).toEqual(["-lc", "-lc"]);
      await call(bash, { command: "true" });
      expect(flags()).toEqual(["-lc", "-lc", "-lc"]);
    } finally {
      stopping.graceMs = grace;
    }
  });

  test("a snapshot others can write is not loaded", async () => {
    await run();
    const marker = join(env.home, "rejected-snapshot-ran");
    writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace("__cc_snapshot_complete=1\n", `touch '${marker}'\n__cc_snapshot_complete=1\n`));
    chmodSync(snapshot, 0o666);
    await run();
    expect(existsSync(marker)).toBe(false);
    expect(logins()).toBe(2);
    // Left as it is; this process captured its own.
    expect(readFileSync(snapshot, "utf8")).toContain(marker);
    expect(snapshotFile()!.startsWith(snapshots.dir)).toBe(true);
    expect(readFileSync(snapshotFile()!, "utf8")).not.toContain(marker);
  });

  test("files this format doesn't recognize are left alone, and this process keeps its own", async () => {
    mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
    const other = join(snapshots.cacheDir, "v2");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeFileSync(join(other, "anything.sh"), "a future format", { mode: 0o600 });
    writeFileSync(snapshot, "# cc-remote shell snapshot (format 9): /bin/bash\n", { mode: 0o600 });
    await run();
    await run();
    expect(logins()).toBe(1);
    expect(readFileSync(snapshot, "utf8")).toBe("# cc-remote shell snapshot (format 9): /bin/bash\n");
    expect(readFileSync(join(other, "anything.sh"), "utf8")).toBe("a future format");
    rmSync(snapshot);
    writeFileSync(snapshot.replace(/\.sh$/, ".failed"), "not a record", { mode: 0o600 });
    resetSnapshots();
    expect(snapshotFile()!.startsWith(snapshots.dir)).toBe(true);
    expect((await call(bash, { command: 'echo "$PROFILE_VALUE"' })).text).toBe("from-profile");
    expect(readFileSync(snapshot.replace(/\.sh$/, ".failed"), "utf8")).toBe("not a record");
    expect(existsSync(snapshot)).toBe(false);
  });

  test("a snapshot that fails to load runs that command as a login shell instead", async () => {
    await run();
    writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace("__cc_snapshot_complete=1\n", ""));
    await run(COMMAND, "profile-connection");
    expect(flags().slice(4)).toEqual(["-c", "-lc"]);
    expect(existsSync(snapshot)).toBe(false);
    // The failure is remembered: no capture until the retry period ends or a startup file changes.
    await run(COMMAND, "profile-connection");
    expect(flags().slice(6)).toEqual(["-lc"]);
  });

  test("a profile that sets nounset still runs commands", async () => {
    appendFileSync(profile, "set -u\n");
    await run();
    await run();
    expect(logins()).toBe(1);
  });

  test("another login shell runs bash as a login shell", async () => {
    process.env.SHELL = fixtureShell(env.home, "fish");
    await run(COMMAND, "profile-connection");
    await run(COMMAND, "profile-connection");
    expect(flags()).toEqual(["-lc", "-lc"]);
    expect(existsSync(snapshot)).toBe(false);
  });

  test("the snapshot is private, and failures are recorded beside it", async () => {
    await run();
    expect(statSync(snapshots.cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(snapshot)).mode & 0o777).toBe(0o700);
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(snapshot))).toEqual([snapshot.split("/").pop()!]);
  });

  test("a lock left by a process that died is broken; a live one sends commands to a login shell", async () => {
    const lock = snapshot.replace(/\.sh$/, ".lock");
    mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
    writeFileSync(lock, String(process.pid));
    await run(COMMAND, "profile-connection");
    expect(flags()).toEqual(["-lc"]);
    expect(existsSync(snapshot)).toBe(false);
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(lock, String(dead));
    await run();
    expect(flags()).toEqual(["-lc", "-lc", "-c", "-c", "-c"]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(snapshot)).toBe(true);
  });

  test("a lock older than any capture is broken too", async () => {
    const lock = snapshot.replace(/\.sh$/, ".lock");
    mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
    writeFileSync(lock, String(process.pid));
    snapshots.lockStaleMs = -1;
    await run();
    expect(logins()).toBe(1);
    expect(existsSync(snapshot)).toBe(true);
  });

  test("a cache others can write is not used; this process keeps its own", async () => {
    mkdirSync(snapshots.cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(snapshots.cacheDir, 0o777);
    const own = snapshotFile()!;
    expect(own.startsWith(snapshots.dir)).toBe(true);
    await run();
    await run();
    expect(logins()).toBe(1);
    expect(readdirSync(snapshots.cacheDir)).toEqual(["v1"]);
    expect(readdirSync(join(snapshots.cacheDir, "v1"))).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  test("other processes reuse the snapshot, keep their own per-process values, and capture their own for another environment", () => {
    const child = (extra: Record<string, string>) => {
      const childEnv = { ...process.env, XDG_CACHE_HOME: join(env.home, "xdg-cache"), ...extra } as Record<string, string>;
      const script = `import { bash } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tools", "bash"))};
        import { workspace } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tools", "util"))};
        import { snapshots } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tools", "login"))};
        snapshots.log = () => {};
        const r = await bash(workspace(process.cwd())).handler({ command: 'printf "%s|%s" "$PROFILE_VALUE" "$ORCA_AGENT_SESSION_ID"' }, {});
        process.stdout.write(r.content[0].text);`;
      const out = Bun.spawnSync(["bun", "-e", script], { cwd: env.home, env: childEnv, stdin: "ignore" });
      expect(out.stderr.toString()).toBe("");
      return out.stdout.toString();
    };
    expect(child({ ORCA_AGENT_SESSION_ID: "chat-a" })).toBe("from-profile|chat-a");
    expect(flags()).toEqual(["-lc", "-c", "-c", "-c"]);
    expect(child({ ORCA_AGENT_SESSION_ID: "chat-b" })).toBe("from-profile|chat-b");
    expect(flags()).toEqual(["-lc", "-c", "-c", "-c", "-c"]);
    expect(logins()).toBe(1);
    const shared = join(env.home, "xdg-cache", "cc-remote", "shell", "v1");
    expect(readdirSync(shared).filter((n) => n.endsWith(".sh"))).toHaveLength(1);
    expect(readFileSync(join(shared, readdirSync(shared)[0]!), "utf8")).not.toContain("chat-a");
    // A different inherited environment is a different snapshot.
    expect(child({ ORCA_AGENT_SESSION_ID: "chat-c", DEV_CONFIG: "other" })).toBe("from-profile|chat-c");
    expect(logins()).toBe(2);
    expect(readdirSync(shared).filter((n) => n.endsWith(".sh"))).toHaveLength(2);
  }, 20_000);

  test("a failure recorded by one process holds for the next", async () => {
    appendFileSync(profile, "printf() { builtin printf noisy; builtin printf \"$@\"; }\n");
    await call(bash, { command: "true" });
    expect(existsSync(snapshot.replace(/\.sh$/, ".failed"))).toBe(true);
    resetSnapshots();
    await call(bash, { command: "true" });
    expect(flags()).toEqual(["-lc", "-c", "-c", "-lc", "-lc"]);
  });

  test("finds the login shell in the passwd entry when $SHELL is missing", () => {
    const passwd = userInfo().shell;
    const expected = passwd && /\/(bash|zsh)$/.test(passwd) ? passwd : snapshots.bash;
    expect(loginShell({}).path).toBe(expected);
    expect(loginShell({ SHELL: "relative/bash" }).path).toBe(expected);
    expect(loginShell({ SHELL: env.shell })).toEqual({ path: env.shell, kind: "bash" });
  });
});
