import { tool } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WINDOWS } from "../platform";
import { refusal, type ShellTool } from "../rules";
import { err, ok, type Workspace } from "./util";

export const MAX_OUTPUT = 30_000;
export const TMP = tmpdir();
let calls = 0;

/**
 * Every command runs in its own process group (a process tree on Windows), so stopping it stops
 * everything it started. Ctrl-C doesn't reach other groups, so whatever is still running is
 * stopped when cc-remote exits.
 */
export const groups = new Set<number>();

/** How long a group gets between SIGTERM and SIGKILL. Settable for tests. */
export const stopping = { graceMs: 5_000 };

const taskkill = (pid: number) =>
  Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });

const signal = (pid: number, name: NodeJS.Signals) => {
  try { process.kill(-pid, name); } catch {}
};

/**
 * Asks a group to stop with SIGTERM, so commands can clean up, and kills whatever is left once the
 * grace period ends. Windows has no such signal; there the tree is killed at once.
 */
export function stop(pid: number) {
  if (WINDOWS) return void taskkill(pid);
  signal(pid, "SIGTERM");
  setTimeout(() => signal(pid, "SIGKILL"), stopping.graceMs).unref();
}

/**
 * Runs as cc-remote exits, when no timer will fire any more: SIGTERM now, and a detached sh, which
 * outlives us, sends the SIGKILLs after the grace period.
 */
export const killAll = () => {
  const pids = [...groups];
  if (WINDOWS) return void pids.forEach(taskkill);
  if (!pids.length) return;
  for (const pid of pids) signal(pid, "SIGTERM");
  const targets = pids.map((pid) => `-${pid}`).join(" ");
  try {
    Bun.spawn(["sh", "-c", `sleep ${stopping.graceMs / 1000}; kill -s KILL -- ${targets} 2>/dev/null`], {
      detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    }).unref();
  } catch {}
};

/** One process a shell starts for a command. */
export type Launch = {
  argv: string[];
  /**
   * Runs once the process has exited, to remove files written for it. Returns true when the
   * command itself never started (a login shell snapshot that failed to load), so it is safe to
   * launch it once more.
   */
  done?: () => boolean | void;
};

/** How one shell runs a command. The script it runs writes its final directory to $__CC_REMOTE_PWD, unless that is empty. */
export type Shell = {
  name: ShellTool;
  description: string;
  /** May take a while the first time: Bash captures the login environment then. */
  launch: (command: string, ws: Workspace) => Launch | Promise<Launch>;
  stopHint: (pid: number) => string;
};

const spawn = (argv: string[], ws: Workspace, pwdFile: string, dest: "pipe" | number) =>
  Bun.spawn(argv, {
    cwd: ws.cwd,
    detached: !WINDOWS,
    windowsHide: true,
    stdin: "ignore",
    stdout: dest,
    stderr: dest,
    env: { ...Bun.env, __CC_REMOTE_PWD: pwdFile },
  });

type Result = { out: string; code: number; timedOut: boolean; retry?: boolean };

/** Like Claude Code's Bash: the working directory persists between calls, through ws.cwd. */
async function runOnce(shell: Shell, ws: Workspace, command: string, timeoutMs: number, abort?: AbortSignal): Promise<Result> {
  const launch = await shell.launch(command, ws);
  if (abort?.aborted) {
    launch.done?.();
    return { out: "Command was cancelled before it started", code: 130, timedOut: false };
  }
  const pwdFile = join(TMP, `cc-remote-pwd-${process.pid}-${++calls}`);
  const proc = spawn(launch.argv, ws, pwdFile, "pipe");
  groups.add(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(proc.pid); }, timeoutMs);
  const onAbort = () => stop(proc.pid);
  abort?.addEventListener("abort", onAbort);

  // Both streams land in one buffer in the order they arrive, as a terminal would show them.
  let out = "";
  const readers = [proc.stdout, proc.stderr].map((s) => (s as ReadableStream<Uint8Array>).getReader());
  const reading = Promise.all(readers.map(async (reader) => {
    const decoder = new TextDecoder();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if (out.length <= MAX_OUTPUT) out += decoder.decode(r.value, { stream: true });
    }
  }));
  const code = await proc.exited;
  clearTimeout(timer);
  abort?.removeEventListener("abort", onAbort);
  groups.delete(proc.pid);
  const retry = launch.done?.() === true && !timedOut && !abort?.aborted;
  // A backgrounded child (`cmd &`) can hold the pipe open after the shell exits. Don't wait for it.
  await Promise.race([reading, Bun.sleep(200)]);
  await Promise.all(readers.map((r) => r.cancel()));
  const pwd = Bun.file(pwdFile);
  const newCwd = (await pwd.text().catch(() => "")).trim();
  if (newCwd) ws.cwd = newCwd;
  await pwd.delete().catch(() => {});
  return { out, code, timedOut, retry };
}

/** A command whose launch failed before it started gets one more launch, which knows better. */
async function run(shell: Shell, ws: Workspace, command: string, timeoutMs: number, abort?: AbortSignal) {
  const first = await runOnce(shell, ws, command, timeoutMs, abort);
  return first.retry ? runOnce(shell, ws, command, timeoutMs, abort) : first;
}

/** run_in_background: output goes to a file the model can Read; the command stops with cc-remote. */
async function background(shell: Shell, ws: Workspace, command: string) {
  const launch = await shell.launch(command, ws);
  const output = join(TMP, `cc-remote-bg-${process.pid}-${Date.now()}.log`);
  const fd = openSync(output, "a");
  const proc = spawn(launch.argv, ws, "", fd);
  closeSync(fd);
  proc.unref();
  groups.add(proc.pid);
  proc.exited.then(() => {
    groups.delete(proc.pid);
    launch.done?.();
  });
  return ok(
    `Command running in background with ID: ${proc.pid}. Output is being written to: ${output}. Read that file to check its output. Stop it with ${shell.name}: ${shell.stopHint(proc.pid)}. It stops when this session ends.`,
  );
}

export const shellTool = (shell: Shell) => (ws: Workspace) => tool(
  shell.name,
  shell.description,
  {
    command: z.string().describe("The command to execute"),
    timeout: z.number().optional().describe("Optional timeout in milliseconds (max 600000)"),
    description: z.string().optional().describe("Clear, concise description of what this command does in 5-10 words"),
    run_in_background: z.boolean().optional().describe("Set to true to run this command in the background. Read the output file it returns to check on it."),
  },
  async ({ command, timeout, run_in_background }, extra) => {
    // The user's deny rules hold in every mode. In bypassPermissions claude never asks us first.
    const denied = refusal(command, ws.root, shell.name);
    if (denied) return err(denied);
    if (run_in_background) return background(shell, ws, command);
    const limit = Math.min(Math.max(timeout ?? 120_000, 1_000), 600_000);
    const { out, code, timedOut } = await run(shell, ws, command, limit, (extra as { signal?: AbortSignal })?.signal);

    let text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n\n... [output truncated]` : out.trimEnd();
    if (timedOut) text += `${text ? "\n" : ""}Command timed out after ${limit}ms`;
    else if (code !== 0) text += `${text ? "\n" : ""}Exit code ${code}`;
    if (timedOut || code !== 0) return err(text);
    return ok(text || "(No output)");
  },
);
