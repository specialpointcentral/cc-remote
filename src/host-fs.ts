import { posix } from "node:path";
import type { Ready } from "./host-files";
import { REFUSED } from "./host-process";
import { keyFor } from "./sessions";
import type { ExecResult } from "./relay";
import { quote } from "./sh";
import { rsh } from "./ssh";

/** Runs a shell script on the host over the session's relay (see HostProcess.exec). */
type Exec = (script: string, input?: Uint8Array) => Promise<ExecResult>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How long one read or write of a host file may take. The link's keepalives catch a dead one sooner. */
const TIMEOUT_MS = 120_000;

/** What the read script exits with for a missing file and for a directory. */
const MISSING = 20;
const DIRECTORY = 21;

/**
 * The host's own files among those the model reaches with the file tools. claude keeps some files
 * of its own on the host and tells the model to read or write them, while Read, Write and Edit run
 * here; the same path on this machine is another file, or none:
 *
 * - the plan file, which plan mode has the model write, and which ExitPlanMode reads back on the
 *   host to put the plan in front of the user (`<config>/plans/`);
 * - the session's project folder (`<config>/projects/<host folder>/`): a tool result too large
 *   for the context, which claude saves there and has the model Read; the auto memory; subagent
 *   transcripts;
 * - user-scope subagent memory (`<config>/agent-memory/`);
 * - a background task's output file, in claude's temp folder (`.../claude-<uid>/<host folder>/<session>/tasks/`).
 *
 * Read, Write, Edit, and Glob given one of these folders, go to the host: over the session's relay
 * connection when claude runs under the relay, with no ssh of their own; otherwise one ssh command
 * each, on the shared connection.
 * The scratchpad, also in claude's temp folder, stays here: the model writes it with Write and
 * reads it with Bash, which only runs here. Skills and plugins are left alone too: a path under
 * `<config>/skills/` names a local file just as well when both homes have the same path.
 */
export class HostFiles {
  /** The host's plans folder. */
  readonly plans: string;
  /** Where markdown files are memory, which claude writes without asking: the auto memory, and subagents'. */
  private readonly memory: string[];
  private readonly roots: string[];
  private readonly tasks: RegExp;
  private readonly home: string;

  constructor(readonly host: string, where: Pick<Ready, "home" | "config" | "folder">, private readonly exec?: Exec) {
    this.home = posix.normalize(where.home);
    const config = posix.resolve(where.folder, where.config);
    const key = keyFor(where.folder);
    const project = posix.join(config, "projects", key);
    const agents = posix.join(config, "agent-memory");
    this.plans = posix.join(config, "plans");
    this.memory = [posix.join(project, "memory"), agents];
    this.roots = [this.plans, project, agents];
    this.tasks = new RegExp(`/claude-\\d+/${escape(key)}/[^/]+/tasks(/|$)`);
  }

  /** The host's view of what the session-start check found, if it found a usable one. */
  static from(host: string, where: Pick<Ready, "home" | "config" | "folder">, exec?: Exec): HostFiles | undefined {
    const absolute = (p: string) => p.startsWith("/");
    return absolute(where.home) && absolute(where.folder) && where.config ? new HostFiles(host, where, exec) : undefined;
  }

  /** Runs a command on the host: over the relay while the session has one, else over ssh. */
  private run(script: (start: string) => string, input?: Uint8Array) {
    return run(this.host, script, input, this.exec);
  }

  /** The host path a tool was given, normalized, when it names one of the host's own files. */
  own(path: string): string | undefined {
    const full = path === "~" || path.startsWith("~/") ? posix.join(this.home, path.slice(1)) : path;
    if (!full.startsWith("/")) return undefined;
    const p = posix.normalize(full);
    return this.roots.some((r) => p === r || p.startsWith(`${r}/`)) || this.tasks.test(p) ? p : undefined;
  }

  /**
   * What the file is, when it is one claude edits without asking in any mode, as it edits its own:
   * a plan file, right in the plans folder, or a memory file. Markdown only, as claude has it.
   */
  selfEdited(path: string): "plan" | "memory" | undefined {
    const p = this.own(path);
    if (!p?.endsWith(".md")) return undefined;
    if (posix.dirname(p) === this.plans) return "plan";
    return this.memory.some((m) => p.startsWith(`${m}/`)) ? "memory" : undefined;
  }

  /** The file's content, or why there is none. Throws when the host can't be asked. */
  async read(path: string): Promise<Uint8Array<ArrayBuffer> | "missing" | "directory"> {
    const r = await this.run((start) =>
      `f=${quote(path)}; if [ -d "$f" ]; then exit ${DIRECTORY}; elif [ -f "$f" ]; then ${start} && exec cat -- "$f"; else exit ${MISSING}; fi`);
    if (r.code === MISSING) return "missing";
    if (r.code === DIRECTORY) return "directory";
    if (r.code !== 0 || !r.out) throw new Error(`could not read ${path} on ${this.host}${r.err ? `: ${r.err}` : ""}`);
    return r.out;
  }

  /** The files below a folder, as paths relative to it, at most `max` of them; "missing" when there is no such folder. */
  async list(dir: string, max = 10_000): Promise<string[] | "missing"> {
    const r = await this.run((start) => `cd -- ${quote(dir)} 2>/dev/null || exit ${MISSING}; ${start} && find . -type f | head -n ${max}`);
    if (r.code === MISSING) return "missing";
    if (r.code !== 0 || !r.out) throw new Error(`could not list ${dir} on ${this.host}${r.err ? `: ${r.err}` : ""}`);
    return new TextDecoder().decode(r.out).split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, "")).sort();
  }

  /**
   * Writes the file in place, as the local Write does, making its folder first; whatever it creates
   * is private, as claude keeps these. Returns whether the file was there before.
   */
  async write(path: string, content: string): Promise<boolean> {
    const r = await this.run((start) =>
      `umask 077; f=${quote(path)}; mkdir -p -- "$(dirname -- "$f")" || exit 1; if [ -d "$f" ]; then exit ${DIRECTORY}; fi; e=0; [ ! -e "$f" ] || e=1; cat > "$f" && ${start} && echo "$e"`,
      new TextEncoder().encode(content));
    if (r.code === DIRECTORY) throw new Error(`EISDIR: illegal operation on a directory, open '${path}' on ${this.host}`);
    if (r.code !== 0 || !r.out) throw new Error(`could not write ${path} on ${this.host}${r.err ? `: ${r.err}` : ""}`);
    return new TextDecoder().decode(r.out).trim() === "1";
  }
}

/**
 * Runs one shell command on the host: over the session's relay when given one and it's still
 * there, else with ssh, on a connection of its own when sshd refuses the shared one another
 * session. `script` gets a command that prints a line of its own, after which the output is the
 * command's: a chatty shell startup on the host prints before it. `out` is undefined when that
 * line never came.
 */
async function run(host: string, script: (start: string) => string, input?: Uint8Array, exec?: Exec): Promise<{ code: number; out?: Uint8Array<ArrayBuffer>; err: string }> {
  const token = `cc-remote-v1-file-${crypto.randomUUID()}`;
  const marker = new TextEncoder().encode(`${token}\n`);
  const relayed = exec ? await viaRelay(exec, script(`printf '%s\\n' ${quote(token)}`), input) : undefined;
  if (relayed) {
    const at = Buffer.from(relayed.out).indexOf(marker);
    return { code: relayed.code, out: at < 0 ? undefined : relayed.out.subarray(at + marker.length), err: relayed.err.trim().slice(0, 2_000) };
  }
  for (const shared of [true, false]) {
    const proc = Bun.spawn([...rsh(shared), "-T", host, script(`printf '%s\\n' ${quote(token)}`)], {
      stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS, windowsHide: true, env: process.env,
    });
    const [all, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 255 && shared && REFUSED.test(err)) continue;
    const at = Buffer.from(all).indexOf(marker);
    return { code, out: at < 0 ? undefined : all.subarray(at + marker.length), err: err.trim().slice(0, 2_000) };
  }
  throw new Error("unreachable");
}

/**
 * The command's result over the relay; undefined when the session has no relay (any more), so
 * ssh runs it instead. A relay that is reconnecting holds it until it's back.
 */
async function viaRelay(exec: Exec, script: string, input?: Uint8Array): Promise<ExecResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the host did not answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([exec(script, input), timeout]);
  } catch (e) {
    if ((e as Error).message.startsWith("the host did not answer")) throw e;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
