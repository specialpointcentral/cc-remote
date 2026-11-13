import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { grantsSession } from "./grants";
import { bundle, checkScript, installScript, type Need, type Ready, readyFields } from "./host-files";
import { HostFiles } from "./host-fs";
import { HostProcess } from "./host-process";
import { WINDOWS } from "./platform";
import { projectTrees } from "./project-claude";
import { proxy } from "./proxy";
import { localTranscript } from "./sessions";
import { quote } from "./sh";
import type { Workspace } from "./tools/util";
import { cachedVersion, rememberVersion, tooOld } from "./version";

export { quote };

/** A positive whole number of seconds from the environment, or the default. */
function seconds(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
}

/**
 * Client keepalives: a probe every 15 seconds, and the link counts as dead after
 * CC_REMOTE_KEEPALIVE_TIMEOUT seconds without an answer, 5 minutes by default. A laptop that
 * sleeps briefly or changes networks keeps its sessions, and a dead link still fails instead of
 * hanging the protocol for good.
 */
function keepalive(): string[] {
  const timeout = seconds(Bun.env.CC_REMOTE_KEEPALIVE_TIMEOUT, 300);
  const interval = Math.min(15, timeout);
  return ["-o", `ServerAliveInterval=${interval}`, "-o", `ServerAliveCountMax=${Math.ceil(timeout / interval)}`];
}

/** No connection sharing, for when sshd refuses the shared connection another session. */
const UNSHARED = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

/**
 * The ssh command, like rsync's RSYNC_RSH: `CC_REMOTE_SSH="ssh -p 2222"`, plus compression (the
 * stream is JSON, and transcripts go up in it) and keepalives when that command is ssh. These are
 * passed on the command line, so nothing in ~/.ssh/config has to change. OpenSSH keeps the first
 * value it sees: an earlier `-o` in `CC_REMOTE_SSH` still wins, and these beat the config file.
 *
 * By default sessions share one connection, since an ACP client may open several at once and probe
 * besides; it stays open CC_REMOTE_CONTROL_PERSIST after the last one ends (1h by default), so the
 * next session starts without a handshake. Windows' OpenSSH can't multiplex, so there each session
 * has its own. Without `shared`, the command opens a connection of its own wherever it would
 * have shared one.
 */
export const rsh = (shared = true) => {
  const options = ["-o", "Compression=yes", ...keepalive()];
  const custom = Bun.env.CC_REMOTE_SSH?.split(/\s+/).filter(Boolean);
  if (custom?.length) {
    if (!/^ssh(\.exe)?$/i.test(custom[0]!.split(/[\\/]/).pop()!)) return custom;
    // Ahead of the command's own options, which may name a shared connection.
    return shared ? [...custom, ...options] : [custom[0]!, ...UNSHARED, ...custom.slice(1), ...options];
  }
  if (WINDOWS) return ["ssh", ...options];
  if (!shared) return ["ssh", ...UNSHARED, ...options];
  const socket = `/tmp/cc-remote-${userInfo().uid}-%C`;
  const persist = Bun.env.CC_REMOTE_CONTROL_PERSIST?.trim() || "1h";
  return ["ssh", "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", `ControlPersist=${persist}`, ...options];
};

/** Native installs of claude live in ~/.local/bin, which non-interactive ssh shells often leave off PATH. */
export const REMOTE_PATH = `PATH="$HOME/.local/bin:$PATH"`;

/** A local path as a POSIX path for the host: `C:\Users\me` becomes `/C/Users/me`. */
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "/$1");

/** The host folder a local directory maps to, relative to the host's home. */
export const hostDir = (cwd: string) => `.cc-remote/ws/${hostname()}${posix(cwd)}`;

/** Enters a stable per-directory folder on the host, so sessions and --continue have a home. */
const enter = (cwd: string) => {
  const dir = `"$HOME"/${quote(hostDir(cwd))}`;
  return `mkdir -p ${dir} && cd ${dir}`;
};

/** The shell command the host runs: enter the folder, run `check` when given, then exec claude. */
export function remoteCommand(args: string[], env: Record<string, string>, cwd: string, check?: string): string {
  const vars = Object.entries(env).map(([k, v]) => quote(`${k}=${v}`));
  return `${enter(cwd)} && ${check ? `${check} && ` : ""}${REMOTE_PATH} exec env ${vars.join(" ")} claude ${args.map(quote).join(" ")}`;
}

/** Runs claude on the host with these arguments, for `cc-remote --cli`. */
export function runRemote(host: string, args: string[], cwd: string): Promise<number> {
  const [ssh, ...flags] = rsh();
  const tty = process.stdin.isTTY && process.stdout.isTTY ? "-t" : "-T";
  const child = spawn(ssh!, [...flags, tty, host, remoteCommand(args, {}, cwd)], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}

/**
 * What the host's `claude --version` prints: the cached answer while it's fresh, unless `live`,
 * else asked over ssh and cached. Undefined when claude can't be run there.
 */
export async function hostVersion(host: string, live = false): Promise<string | undefined> {
  const cached = live ? undefined : cachedVersion(host);
  if (cached) return cached;
  const proc = Bun.spawn([...rsh(), "-T", host, `${REMOTE_PATH} claude --version`], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) return undefined;
  rememberVersion(host, out);
  return out;
}

/** A flag's value, written either as `--flag value` or as `--flag=value`, the SDK's usual form. */
export function argument(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a)) return args[i + 1];
    const eq = a.indexOf("=");
    if (eq > 0 && names.includes(a.slice(0, eq))) return a.slice(eq + 1);
  }
  return undefined;
}

/** A local file or directory claude on the host needs a copy of, such as a plugin, and where it goes. */
export type Upload = { local: string; remote: string };

/**
 * Teammates of an agent team would run on the host with the host's tools, out of reach of the
 * local ones, so every claude cc-remote starts has agent teams off.
 */
const NO_TEAMS = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" };

/** A `--settings` value as an object: inline JSON, or a local file holding it. Undefined when it is neither. */
function settingsObject(value: string, cwd: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(/^\s*\{/.test(value) ? value : readFileSync(resolve(cwd, value), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * claude's arguments with nothing left that turns agent teams on: an `--agent-teams` flag goes, and
 * the settings get NO_TEAMS in their `env`, merged into the caller's own `--settings` (Orca passes
 * `{"fastMode":false}`) as one flag at the end. A settings file's `env` outranks the environment
 * claude starts with, so the host's user settings could otherwise turn teams back on; these flag
 * settings outrank the user's. A value that is no JSON object, inline or in a local file, stays
 * where it was, before ours, which claude takes as the last word.
 */
export function teamsOff(args: string[], cwd: string): string[] {
  const out: string[] = [];
  let merged: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--agent-teams" || a.startsWith("--agent-teams=")) continue;
    if (a !== "--settings" && !a.startsWith("--settings=")) {
      out.push(a);
      continue;
    }
    const value = a === "--settings" ? (args[++i] ?? "") : a.slice("--settings=".length);
    const settings = settingsObject(value, cwd);
    if (settings) merged = { ...merged, ...settings, env: { ...merged.env, ...settings.env } };
    else out.push("--settings", value);
  }
  return [...out, "--settings", JSON.stringify({ ...merged, env: { ...merged.env, ...NO_TEAMS } })];
}

/**
 * How a start checks the host's claude version: not at all while the cached one is fresh (or, when
 * that one is too old, by refusing outright); otherwise the check prints it, at most once per TTL.
 */
function versionCheck(host: string): { refuse?: string; ask?: string; ready?: (rest: string) => string | undefined } {
  const known = cachedVersion(host);
  if (known) return { refuse: tooOld(host, known) };
  return {
    ask: `${REMOTE_PATH} claude --version`,
    ready: (rest) => {
      rememberVersion(host, rest);
      return tooOld(host, rest);
    },
  };
}

/**
 * Starts claude on the host, in one ssh channel when the host has everything the session needs:
 * the plugins in `uploads`, the transcript of a session to resume, and the project's commands,
 * skills and agents. The remote command checks for them first and starts claude only when they're
 * all there; otherwise cc-remote sends what's missing over one more channel and starts it again.
 * What the SDK writes in the meantime waits for the claude that starts. `found` gets what the check
 * reports about the host's folders, as claude starts.
 */
export function launch(host: string, cwd: string, args: string[], env: Record<string, string>, uploads: Upload[] = [], signal?: AbortSignal, found?: (where: Ready) => void): HostProcess {
  const needs: Need[] = uploads.map((u) => ({ kind: "plugin", ...u }));
  const resume = argument(args, "--resume", "-r");
  const transcript = resume ? localTranscript(resume, cwd) : undefined;
  if (resume && transcript) needs.push({ kind: "transcript", local: transcript, sessionId: resume });
  const project = projectTrees(cwd);
  if (project.files.length) needs.push({ kind: "project", files: project.files, stamp: project.stamp });

  // Versioned like the rest of what cc-remote leaves on a stream or a host, though only this
  // process reads these.
  const nonce = crypto.randomUUID();
  const tokens = { ready: `cc-remote-v1-ready-${nonce}`, missing: `cc-remote-v1-missing-${nonce}` };
  const version = versionCheck(host);
  const check = checkScript(needs, !project.files.length, tokens, version.ask);
  const command = remoteCommand(teamsOff(args, cwd), { ...env, ...NO_TEAMS }, cwd, check);
  const ssh = (shared: boolean) => [...rsh(shared), "-T", host];

  return new HostProcess({
    start: (shared) => [...ssh(shared), command],
    upload: (missing, shared) => {
      if (project.skipped.length && missing.some((i) => needs[i]!.kind === "project")) {
        console.error(`cc-remote: not copying to the host: ${project.skipped.join(", ")}`);
      }
      return { argv: [...ssh(shared), `${enter(cwd)} && ${installScript(needs, missing)}`], input: bundle(needs, missing) };
    },
    tokens,
    ready: (rest) => {
      const where = readyFields(rest);
      found?.(where);
      return version.ready?.(where.version);
    },
    refuse: version.refuse,
    signal,
  });
}

/** The host process where the proxy expects a ChildProcess: it uses only what both offer. */
export const asChild = (host: HostProcess) => host as unknown as ChildProcess;

/** Hands what a launch found about the host's folders to the local tools of the session in `ws`. */
export const tellTools = (host: string, ws?: Workspace) => (where: Ready) => {
  if (ws) ws.host = HostFiles.from(host, where);
};

/**
 * The SDK normally spawns claude locally and talks to it over stdin/stdout. We hand it ssh
 * instead; the protocol, tool calls included, rides over the same two pipes. `ws` is the
 * workspace the session's local tools share.
 */
export function spawner(host: string, cwd: string, env: Record<string, string>, ws?: Workspace) {
  return (options: SpawnOptions): SpawnedProcess => {
    // ssh forwards no environment, so pass along what the SDK and ACP added for claude.
    const added = Object.fromEntries(
      Object.entries(options.env).filter(
        (e): e is [string, string] => e[1] !== undefined && process.env[e[0]] !== e[1] && e[0] !== "CLAUDE_CONFIG_DIR",
      ),
    );
    const child = launch(host, cwd, options.args, { ...added, ...env }, [], options.signal, tellTools(host, ws));
    const mode = argument(options.args, "--permission-mode") ?? "default";
    return proxy(asChild(child), { cwd, hostDir: hostDir(cwd), mode, ws, sessionId: grantsSession(options.args) });
  };
}
