/**
 * What the live Orca checks (test/live/orca.test.ts) run on: a real orcad from a bundle on a
 * throwaway profile, its JSON-lines RPC, the Claude Command wrapper that records each launch, and
 * the guards that keep a small machine usable: free memory checked before each start and watched
 * while running, every process of the run found again by a marker in its environment and stopped.
 *
 *   bun test/live/orca-live.ts cleanup <token>    stops every process of the run marked <token>
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { call, inspect, type Runtime } from "../../src/setup/orca";

export const ROOT = join(import.meta.dir, "..", "..");

/** Memory, in MB "available": needed before orcad or a claude turn starts; below ABORT the run stops. */
export const MIN_START_MB = 1000;
export const ABORT_MB = 700;

export function availableMb(): number {
  const line = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
  return line ? Math.floor(Number(line[1]) / 1024) : 0;
}

export function requireMemory(what: string) {
  const mb = availableMb();
  if (mb < MIN_START_MB) throw new Error(`only ${mb} MB available, ${MIN_START_MB} MB needed before ${what}; not starting it`);
}

/** Asks `fn` every 2 s (never more often) until it gives something or the deadline passes. */
export async function waitFor<T>(what: string, seconds: number, fn: () => T | undefined | false | Promise<T | undefined | false>, detail = () => ""): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${seconds}s waiting for ${what}. ${detail()}`.trim());
    await Bun.sleep(2_000);
  }
}

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

const ancestors = (): Set<number> => {
  const out = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    try {
      pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      out.add(pid);
    } catch {
      break;
    }
  }
  return out;
};

/** This user's processes whose environment or command line carries the run's marker, but not us or our parents. */
export function marked(token: string): { pid: number; cmd: string; argv: string[] }[] {
  const uid = process.getuid!();
  const skip = ancestors();
  const found: { pid: number; cmd: string; argv: string[] }[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (skip.has(pid)) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) continue;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      let env = "";
      try {
        env = readFileSync(`/proc/${pid}/environ`, "utf8");
      } catch {}
      if (cmd.includes(token) || env.split("\0").includes(`CC_REMOTE_LIVE_TOKEN=${token}`)) {
        found.push({ pid, cmd: cmd.replaceAll("\0", " ").slice(0, 160), argv: cmd.split("\0").filter(Boolean) });
      }
    } catch {}
  }
  return found;
}

/** Stops every marked process: SIGTERM, then SIGKILL for what's left after 3 s. Returns what it found. */
export async function stopMarked(token: string): Promise<string[]> {
  const first = marked(token);
  for (const p of first) try { process.kill(p.pid, "SIGTERM"); } catch {}
  if (first.length) await Bun.sleep(3_000);
  for (const p of marked(token)) try { process.kill(p.pid, "SIGKILL"); } catch {}
  if (first.length) await Bun.sleep(500);
  return first.map((p) => `${p.pid} ${p.cmd}`);
}

/** Stops the fake host's namespace (test/e2e/fakessh --stop) for a state folder. */
export function stopFakeHost(state: string) {
  Bun.spawnSync([join(ROOT, "test/e2e/fakessh"), "--stop"], { env: { ...process.env, FAKE_HOST_STATE: state }, timeout: 10_000 });
}

/** Orca Server's RPC on a profile, found again through orca-runtime.json for every call, so a restart is followed. */
export class OrcaRpc {
  constructor(readonly profile: string) {}

  runtime(): Runtime {
    const found = inspect(this.profile);
    if (!found || "problem" in found) throw new Error(`no live Orca runtime on ${this.profile}${found ? `: ${found.problem}` : ""}`);
    return found;
  }

  call(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<any> {
    return call(this.runtime(), method, params, timeoutMs);
  }

  async ready(): Promise<any> {
    try {
      const status = await this.call("status.get", {}, 5_000);
      return status?.graphStatus === "ready" && (status.capabilities ?? []).includes("agent-session.structured.v1") ? status : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False), as Orca's fingerprints are taken. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => (value as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const fingerprint = (method: string, sessionId: string, fields: unknown) =>
  createHash("sha256").update(canonical({ method, sessionId, fields })).digest("hex");

export const operationId = () => `${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}`;

export type Launch = { at: number; pid: number; parent: string; cwd: string; args: string[]; env: string[]; orcaAppVersion?: string };

/**
 * The Claude Command: records argv, the names (never the values) of the environment Orca gave it,
 * and the build that started it, then runs cc-remote from this checkout as `cc-remote claude`. With
 * no `host`, the "server" is test/e2e/fakessh, isolated: the host side runs here, in a mount
 * namespace of its own, with this machine's Claude login.
 */
export function writeClaudeCommand(o: { work: string; token: string; log: string; state: string; cache: string; realHome: string; host?: string }): string {
  const bun = process.execPath;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const ssh = join(o.work, "fakessh");
  const exports = o.host
    ? `export CC_REMOTE_LIVE_TOKEN=${q(o.token)} XDG_CACHE_HOME=${q(o.cache)}`
    : `export CC_REMOTE_LIVE_TOKEN=${q(o.token)} CC_REMOTE_SSH=${q(ssh)} REAL_HOME=${q(o.realHome)} FAKE_HOST_ISOLATED=1 FAKE_HOST_STATE=${q(o.state)} XDG_CACHE_HOME=${q(o.cache)}`;
  if (!o.host) {
    // The host side keeps the real login, whatever CLAUDE_CONFIG_DIR Orca gives its chats.
    writeFileSync(ssh, `#!/bin/sh\nCLAUDE_CONFIG_DIR=${q(join(o.realHome, ".claude"))} exec ${q(join(ROOT, "test/e2e/fakessh"))} "$@"\n`);
    chmodSync(ssh, 0o755);
  }
  const command = join(o.work, "claude-cmd");
  const logger = `${q(bun)} ${q(join(import.meta.dir, "log-launch.ts"))}`;
  const ccRemote = `${q(bun)} ${q(join(ROOT, "src/main.ts"))} --host ${q(o.host || "fakehost")} claude "$@"`;
  // A one-off `claude -p` (no stream-json input, such as a chat title) isn't exec'd, so its exit
  // status and output can be recorded too; everything else is, so Orca's signals reach cc-remote.
  writeFileSync(command, `#!/bin/sh
${logger} ${q(o.log)} "$@" || exit 1
${exports}
oneoff= stream=
for a in "$@"; do case "$a" in -p|--print) oneoff=1 ;; --input-format|--input-format=*) stream=1 ;; esac; done
if [ -n "$oneoff" ] && [ -z "$stream" ]; then
  out=$(mktemp "${o.work}/oneoff.XXXXXX") || exit 1
  ${ccRemote} > "$out"
  status=$?
  cat "$out"
  ${logger} --exit ${q(o.log)} $$ "$status" "$out"
  rm -f "$out"
  exit "$status"
fi
exec ${ccRemote}
`);
  chmodSync(command, 0o755);
  return command;
}

/** The launches recorded so far, a one-off's exit status and output joined to it. */
export function launches(log: string): (Launch & { exit?: number; output?: string })[] {
  if (!existsSync(log)) return [];
  const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const list = rows.filter((r) => r.exitOf === undefined);
  for (const end of rows.filter((r) => r.exitOf !== undefined)) {
    const launch = list.findLast((l) => l.pid === end.exitOf && l.at <= end.at);
    if (launch) Object.assign(launch, { exit: end.status, output: end.output });
  }
  return list;
}

/** The processes in a process group, as "pid command". */
function group(pgid: number): string[] {
  const out: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ");
      if (Number(fields[2]) === pgid) out.push(`${entry} ${readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 120)}`);
    } catch {}
  }
  return out;
}

/** One orcad from a CLI built by orca-bundle.ts, in its own process group, logging to a file. */
export class OrcaServer {
  private child?: ReturnType<typeof Bun.spawn>;
  constructor(readonly o: { cli: string; port: number; env: Record<string, string>; log: string; cwd: string }) {}

  async start(rpc: OrcaRpc, seconds = 120): Promise<any> {
    requireMemory("starting orcad");
    mkdirSync(this.o.cwd, { recursive: true });
    // setsid: a process group of its own, so stop() can tell what the server left running.
    this.child = Bun.spawn(["setsid", this.o.cli, "serve", "--no-pairing", "--port", String(this.o.port)], {
      cwd: this.o.cwd,
      env: this.o.env,
      stdin: "ignore",
      stdout: Bun.file(this.o.log),
      stderr: Bun.file(`${this.o.log}.err`),
    });
    const child = this.child;
    return waitFor("Orca Server to become ready", seconds, async () => {
      if (child.exitCode !== null) throw new Error(`orcad exited (${child.exitCode}): ${this.tail()}`);
      return rpc.ready();
    }, () => this.tail());
  }

  tail(): string {
    let text = "";
    for (const f of [this.o.log, `${this.o.log}.err`]) try { text += readFileSync(f, "utf8").slice(-1500); } catch {}
    return text;
  }

  /**
   * Stops orcad as a service stop or the desktop's update does, with SIGTERM to its pid, so it
   * winds down its chats itself; SIGKILL after 20 s. Returns what it started that's still running
   * (in its process group) a few seconds later; the run's final cleanup stops those.
   */
  async stop(): Promise<{ seconds: number; left: string[] }> {
    const child = this.child;
    if (!child || child.exitCode !== null) return { seconds: 0, left: [] };
    const started = Date.now();
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(20_000).then(() => false)]);
    if (!exited) try { process.kill(child.pid, "SIGKILL"); } catch {}
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    await Bun.sleep(3_000);
    return { seconds, left: group(child.pid) };
  }
}

if (import.meta.main) {
  const [verb, token] = process.argv.slice(2);
  if (verb !== "cleanup" || !token || token.length < 12) {
    console.error("usage: bun test/live/orca-live.ts cleanup <token>");
    process.exit(2);
  }
  const stopped = await stopMarked(token);
  for (const line of stopped) console.error(`stopped ${line}`);
  const left = marked(token);
  if (left.length) {
    console.error(`still running: ${left.map((p) => `${p.pid} ${p.cmd}`).join("; ")}`);
    process.exit(1);
  }
}
