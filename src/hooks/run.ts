import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { WINDOWS } from "../platform";
import { quote } from "../sh";
import { loginLaunch } from "../tools/login";
import { groups, type Launch, stop } from "../tools/shell";
import type { Handler } from "./config";

/** What running one hook came to. An http hook's answer is read as a command's exit 0 with its body on stdout. */
export type Outcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "failed"; message: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "skipped"; reason: string };

export type RunOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  /** None for an async hook, which Claude Code doesn't time out. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Not stopped when cc-remote exits, output not read: a SessionEnd hook, which outlives the session. */
  detach?: boolean;
};

/** Output kept per stream; the rest is read and dropped, so the hook never blocks writing. */
const CAP = 1 << 20;

/** A stream's text as it arrives, for reading to its end or giving up on. */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state = { text: "" };
  const done = (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        if (state.text.length < CAP) state.text += decoder.decode(r.value, { stream: true });
      }
    } catch {}
  })();
  return { state, done, cancel: () => reader.cancel().catch(() => {}) };
}

/** Git Bash, which Claude Code runs shell-form hooks with on Windows when it's installed. */
function gitBash(): string | undefined {
  const set = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && existsSync(set)) return set;
  const git = Bun.which("git");
  const bash = git && join(dirname(dirname(git)), "bin", "bash.exe");
  return bash && existsSync(bash) ? bash : undefined;
}

/**
 * How a command hook starts. Exec form (`args`) runs the executable with those arguments, after
 * putting the project folder in for `${CLAUDE_PROJECT_DIR}`; shell form hands the command to
 * `sh -c`, as Claude Code does on macOS and Linux. Either way it starts in the login shell's
 * environment the local Bash tool uses (tools/login.ts), so what the profile sets up is found also
 * when an app such as Orca started cc-remote. On Windows: Git Bash, or PowerShell when it isn't
 * there or `shell` says so.
 */
async function launchFor(h: Handler, cwd: string, projectDir: string): Promise<Launch> {
  const words = Array.isArray(h.args) ? [h.command!, ...h.args.map(String)].map((w) => w.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir)) : undefined;
  if (WINDOWS) {
    if (words) return { argv: words };
    const bash = h.shell === "powershell" ? undefined : gitBash();
    return { argv: bash ? [bash, "-c", h.command!] : [Bun.which("pwsh") ?? "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", h.command!] };
  }
  return loginLaunch(words ? `exec ${words.map(quote).join(" ")}` : `exec sh -c ${quote(h.command!)}`, cwd);
}

async function runOnce(h: Handler, input: string, o: RunOptions): Promise<Outcome & { retry?: boolean }> {
  let launch: Launch;
  try {
    launch = await launchFor(h, o.cwd, o.env.CLAUDE_PROJECT_DIR ?? o.cwd);
  } catch (e) {
    return { kind: "failed", message: `could not start: ${(e as Error).message}` };
  }
  if (o.signal?.aborted) {
    launch.done?.();
    return { kind: "cancelled" };
  }
  let proc: Bun.Subprocess<Uint8Array, "pipe" | "ignore", "pipe" | "ignore">;
  try {
    const out = o.detach ? "ignore" : "pipe";
    proc = Bun.spawn(launch.argv, { cwd: o.cwd, env: o.env, detached: !WINDOWS, windowsHide: true, stdin: new TextEncoder().encode(input), stdout: out, stderr: out });
  } catch (e) {
    launch.done?.();
    return { kind: "failed", message: `could not start: ${(e as Error).message}` };
  }
  if (!o.detach) groups.add(proc.pid);
  let timedOut = false;
  const timer = o.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop(proc.pid); }, o.timeoutMs);
  const onAbort = () => stop(proc.pid);
  o.signal?.addEventListener("abort", onAbort);
  const streams = o.detach ? [] : [collect(proc.stdout as ReadableStream<Uint8Array>), collect(proc.stderr as ReadableStream<Uint8Array>)];
  const code = await proc.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  groups.delete(proc.pid);
  const retry = launch.done?.() === true && !timedOut && !o.signal?.aborted;
  // Something the hook left running in the background can hold the pipes open. Don't wait for it.
  await Promise.race([Promise.all(streams.map((s) => s.done)), Bun.sleep(200)]);
  streams.forEach((s) => s.cancel());
  if (o.signal?.aborted) return { kind: "cancelled" };
  if (timedOut) return { kind: "timeout" };
  return { kind: "exit", code, stdout: streams[0]?.state.text ?? "", stderr: streams[1]?.state.text ?? "", retry };
}

/**
 * Runs a command hook with the hook input on stdin, as Claude Code runs one: in its own process
 * group, stopped at the timeout with SIGTERM and five seconds later SIGKILL, as the Bash tool's
 * commands are. A launch whose login shell snapshot failed to load gets one more, which starts a
 * login shell instead.
 */
export async function runCommand(h: Handler, input: string, o: RunOptions): Promise<Outcome> {
  const first = await runOnce(h, input, o);
  const result = first.kind === "exit" && first.retry ? await runOnce(h, input, o) : first;
  if (result.kind === "exit") delete result.retry;
  return result;
}

/** Whether an `allowedHttpHookUrls` pattern, with `*` as a wildcard, takes a URL. Host names compare without case or a final dot. */
export function urlAllowed(pattern: string, url: string): boolean {
  const normalized = url.replace(/^([a-z][\w+.-]*:\/\/[^/?#]*?)\.(?=[:/?#]|$)/i, "$1");
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(normalized);
}

/** Header values with `$VAR` and `${VAR}` filled in, for the variables both the hook and the settings allow; others become empty. */
function headersFor(h: Handler, env: Record<string, string | undefined>, limit?: string[]): Record<string, string> {
  const allowed = new Set((h.allowedEnvVars ?? []).filter((v) => !limit || limit.includes(v)));
  const fill = (value: string) => value.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, a, b) => (allowed.has(a ?? b) ? (env[a ?? b] ?? "") : ""));
  const headers = h.headers && typeof h.headers === "object" ? h.headers : {};
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, fill(v)]));
}

/**
 * Sends the hook input to an http hook as a POST, as Claude Code does. A 2xx answer with an empty
 * body is a success with no output; with a JSON object, that object is the hook's output; with
 * anything else, or any other status, or no connection, the hook failed. A URL the settings'
 * `allowedHttpHookUrls` doesn't take isn't sent at all.
 */
export async function runHttp(h: Handler, input: string, o: RunOptions & { urls?: string[]; envVars?: string[] }): Promise<Outcome> {
  const url = String(h.url);
  if (o.urls && !o.urls.some((p) => urlAllowed(p, url))) return { kind: "skipped", reason: `${url} is not in allowedHttpHookUrls` };
  const timeout = o.timeoutMs === undefined ? undefined : AbortSignal.timeout(o.timeoutMs);
  const signals = [o.signal, timeout].filter((s): s is AbortSignal => !!s);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headersFor(h, o.env, o.envVars), "Content-Type": "application/json" },
      body: input,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    const body = (await res.text()).trim();
    if (!res.ok) return { kind: "failed", message: `the server answered ${res.status}` };
    if (body && !body.startsWith("{")) return { kind: "failed", message: `the answer is not JSON: ${body.slice(0, 200)}` };
    return { kind: "exit", code: 0, stdout: body, stderr: "" };
  } catch (e) {
    if (o.signal?.aborted) return { kind: "cancelled" };
    if (timeout?.aborted) return { kind: "timeout" };
    return { kind: "failed", message: `the request failed: ${(e as Error).message}` };
  }
}
