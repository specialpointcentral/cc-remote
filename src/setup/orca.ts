import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { alive, readPrivateJson } from "./files";

/**
 * Orca Server on this machine, through its own local RPC: JSON lines over the Unix socket its
 * profile's `orca-runtime.json` names, authenticated with the token there. Setup reads and sets
 * the Claude agent's command, environment and permission mode with it, the way Orca's own settings
 * screen does; Orca's database is never touched. Ported from remote-harness's OrcaClient
 * (`orca-session.py`), with the profile locations and calls of orcad 1.4.254 (read in its bundle).
 */
export const VERIFIED = ["1.4.254"];

export class OrcaError extends Error {}

export type Runtime = { profile: string; endpoint: string; runtimeId: string; token: string; pid: number };

type Env = Record<string, string | undefined>;

/**
 * Where profiles may be, in order: the flag or CC_REMOTE_ORCA_PROFILE, then orcad's own choice
 * (ORCA_USER_DATA, else $XDG_DATA_HOME/Orca, else ~/.orca: `fne()` in the bundle), then the desktop
 * app's (ORCA_USER_DATA_PATH, else ~/Library/Application Support/orca on macOS and
 * ${XDG_CONFIG_HOME:-~/.config}/orca elsewhere: the CLI's `ph()`).
 */
export function profileCandidates(env: Env, home: string, platform: NodeJS.Platform, flag?: string): string[] {
  const list = [
    flag,
    env.CC_REMOTE_ORCA_PROFILE,
    env.ORCA_USER_DATA,
    env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "Orca") : undefined,
    join(home, ".orca"),
    env.ORCA_USER_DATA_PATH,
    platform === "darwin" ? join(home, "Library", "Application Support", "orca") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "orca"),
  ].filter((p): p is string => !!p && isAbsolute(p));
  return [...new Set(list)];
}

/** A profile's runtime, when it holds a live one; else why not, or undefined when there's none. */
export function inspect(profile: string): Runtime | { problem: string } | undefined {
  let info;
  try {
    info = lstatSync(profile);
  } catch {
    return undefined;
  }
  const uid = process.getuid!();
  if (!info.isDirectory()) return undefined;
  if (info.uid !== uid || info.mode & 0o022) return { problem: "the profile folder isn't controlled by this user only" };
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(join(profile, "orca-runtime.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== uid || file.mode & 0o077) return { problem: "orca-runtime.json isn't a private file of this user" };
    text = readFileSync(fd, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : { problem: `orca-runtime.json can't be read (${code})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let meta: { runtimeId?: unknown; authToken?: unknown; pid?: unknown; transports?: unknown; transport?: unknown };
  try {
    meta = JSON.parse(text);
  } catch {
    return { problem: "orca-runtime.json isn't valid JSON" };
  }
  const transports = (Array.isArray(meta.transports) ? meta.transports : [meta.transport]) as { kind?: unknown; endpoint?: unknown }[];
  const endpoint = transports.find((t) => t?.kind === "unix")?.endpoint;
  if (typeof endpoint !== "string" || !isAbsolute(endpoint) || typeof meta.authToken !== "string" || !meta.authToken || typeof meta.runtimeId !== "string" || !meta.runtimeId) {
    return { problem: "the profile has no authenticated local Unix transport" };
  }
  const pid = Number(meta.pid);
  if (!alive(pid)) return { problem: "not running (its runtime file is left over)" };
  try {
    const sock = lstatSync(endpoint);
    if (!sock.isSocket() || sock.uid !== uid) return { problem: "its socket isn't owned by this user" };
  } catch {
    return { problem: "not running (its socket is gone)" };
  }
  return { profile, endpoint, runtimeId: meta.runtimeId, token: meta.authToken, pid };
}

const MAX_FRAME = 8 * 1024 * 1024;

/** One RPC call: a request line, then the answer with its id, skipping keepalive frames. */
export function call(rt: Runtime, method: string, params: unknown = {}, timeoutMs = 5_000): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    try {
      const sock = lstatSync(rt.endpoint);
      if (!sock.isSocket() || sock.uid !== process.getuid!()) return reject(new OrcaError("the Orca runtime socket isn't owned by this user"));
    } catch {
      return reject(new OrcaError("Orca Server's socket is gone"));
    }
    const socket = createConnection(rt.endpoint);
    let pending = "";
    let settled = false;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new OrcaError(`Orca Server didn't answer ${method}`)), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, authToken: rt.token, method, params })}\n`));
    socket.on("error", (e) => finish(new OrcaError(`Orca Server didn't complete ${method}: ${e.message}`)));
    socket.on("close", () => finish(new OrcaError(`Orca Server closed the connection during ${method}`)));
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      if (pending.length > MAX_FRAME) return finish(new OrcaError(`Orca Server's answer to ${method} is too large`));
      for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          return finish(new OrcaError(`Orca Server sent something other than JSON for ${method}`));
        }
        if (frame?._keepalive === true) continue;
        if (frame?.id !== id || frame?._meta?.runtimeId !== rt.runtimeId) return finish(new OrcaError("the Orca Server runtime changed"));
        if (frame.ok !== true) return finish(new OrcaError(`Orca Server refused ${method}: ${frame.error?.message ?? "no reason given"}`));
        return finish(undefined, frame.result);
      }
    });
  });
}

/** Waits until the runtime's workspace graph is ready, as Orca's own clients do (10 s). */
export async function ready(rt: Runtime, timeoutMs = 10_000, wait = (ms: number) => Bun.sleep(ms)): Promise<{ appVersion?: string; graphStatus?: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = await call(rt, "status.get");
      if (status?.graphStatus === "ready") return status;
    } catch {}
    if (Date.now() >= deadline) return undefined;
    await wait(500);
  }
}

export type Discovery = { live: (Runtime & { appVersion?: string })[]; problems: { profile: string; problem: string }[]; installed?: string };

/** Every live Orca runtime of this user's, and the profiles that look like one but aren't usable. */
export async function discover(env: Env, home: string, platform: NodeJS.Platform, flag?: string): Promise<Discovery> {
  const out: Discovery = { live: [], problems: [] };
  const seen = new Set<string>();
  for (const profile of profileCandidates(env, home, platform, flag)) {
    let real = profile;
    try {
      real = realpathSync(profile);
    } catch {}
    if (seen.has(real)) continue;
    seen.add(real);
    const found = inspect(profile);
    if (!found) continue;
    if ("problem" in found) {
      out.problems.push({ profile, problem: found.problem });
      continue;
    }
    const status = await ready(found);
    if (status) out.live.push({ ...found, appVersion: status.appVersion });
    else out.problems.push({ profile, problem: "Orca Server didn't become ready" });
  }
  const active = readPrivateJson(join(home, ".orca-remote", "orcad-active.json"));
  if (typeof active?.activeAppVersion === "string") out.installed = active.activeAppVersion;
  return out;
}

/** How Orca 1.4.254 takes its 1.4 patch releases: verified, a newer patch of a verified line, or neither. */
export function versionSupport(version: string | undefined): "verified" | "newer" | "unverified" {
  if (version && VERIFIED.includes(version)) return "verified";
  const m = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (m && VERIFIED.some((v) => {
    const [a, b, c] = v.split(".").map(Number);
    return Number(m[1]) === a && Number(m[2]) === b && Number(m[3]) > c!;
  })) return "newer";
  return "unverified";
}

/**
 * Whether Orca would run this Claude Command, by the rules of its `oLs()`: no NUL, CR, LF, `$` or
 * backtick anywhere, no word with `| & ; < > ( ) { } [ ] * ? !`, and no `NAME=value` prefix.
 * Quotes and backslashes are refused too, since cc-remote's own path never needs them. Returns
 * the program and its arguments, or why it isn't runnable.
 */
export function validateCommand(value: string): { program: string; prefixArgs: string[] } | { error: string } {
  const text = value.trim();
  if (!text) return { error: "empty" };
  if (/[\0\r\n$`]/.test(text)) return { error: "contains $, a backtick or a line break" };
  const words = text.split(/\s+/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return { error: "starts with an environment assignment" };
  const bad = words.find((w) => /[|&;<>(){}[\]*?!"'\\]/.test(w));
  if (bad) return { error: `"${bad}" has a character Orca refuses` };
  return { program: words[0]!, prefixArgs: words.slice(1) };
}

/** A command as Orca compares them: words separated by single spaces. */
export const normalizeCommand = (value: string) => value.trim().split(/\s+/).filter(Boolean).join(" ");

/**
 * The Claude permission mode new native chats get, and whether it's Orca's untouched default.
 * Orca 1.4.254 stores one choice for all agents (agentPermissionDefault) with per-agent overrides;
 * getAgentLaunch reports them as `agentPermission` (QZo). Older settings without that use the
 * global nativeChatPermissionMode, which settings.get reports.
 */
export type Permission =
  | { model: "agent-permission"; current: string; override?: string; def: string; isDefault: boolean }
  | { model: "legacy"; current: string; isDefault: boolean };

export function permissionOf(launch: any, settings: any): Permission {
  const ap = launch?.agentPermission;
  if (ap && typeof ap === "object") {
    const override = typeof ap.overrides?.claude === "string" ? ap.overrides.claude : undefined;
    const def = typeof ap.default === "string" ? ap.default : "own";
    return { model: "agent-permission", current: override ?? def, override, def, isDefault: override === undefined && def === "full-access" };
  }
  const current = typeof settings?.nativeChatPermissionMode === "string" ? settings.nativeChatPermissionMode : "full-access";
  return { model: "legacy", current, isDefault: current === "full-access" };
}

/** Sets Claude's permission mode to auto, for Claude only where Orca allows that. Returns the new value. */
export async function setPermissionAuto(rt: Runtime, p: Permission): Promise<string | undefined> {
  if (p.model === "agent-permission") {
    const result = await call(rt, "settings.mutateAgentLaunch", { type: "permission", agent: "claude", choice: "auto" });
    return result?.settings?.agentPermission?.overrides?.claude;
  }
  const result = await call(rt, "settings.update", { nativeChatPermissionMode: "auto" });
  return result?.settings?.nativeChatPermissionMode;
}

/** Sets the Claude Command. Orca stores it trimmed; an empty value restores its default `claude`. */
export async function setCommand(rt: Runtime, value: string): Promise<string | undefined> {
  const result = await call(rt, "settings.mutateAgentLaunch", { type: "command", agent: "claude", value });
  return result?.settings?.agentCmdOverrides?.claude;
}

/** Sets one variable of the Claude agent's environment. Orca reports only the names afterwards. */
export async function setEnv(rt: Runtime, name: string, value: string): Promise<string[]> {
  const result = await call(rt, "settings.mutateAgentLaunch", { type: "environment-set", agent: "claude", name, value });
  return result?.settings?.environmentNames?.claude ?? [];
}

/** Orca Server's own environment, which its chats start from (Linux: /proc/<pid>/environ). */
export function processEnv(pid: number): Record<string, string> | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return undefined;
  }
}
