import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_EVENTS, widenMatcher } from "../names";
import { WINDOWS } from "../platform";
import { projectKey, projectsDir } from "../sessions";
import { argument } from "../ssh";
import type { Workspace } from "../tools/util";
import { type HookConfig, type LocalHook, loadHooks, stillConfigured } from "./config";
import { condition, matcherMatches } from "./match";
import { asyncContext, hookOutput } from "./result";
import { type Outcome, type RunOptions, runCommand, runHttp } from "./run";

export { loadHooks } from "./config";

type Json = Record<string, any>;

/**
 * The local hooks' callback ids: one per hook. The carrier, on UserPromptSubmit, brings Claude what
 * async hooks left, and what a new session's SessionStart hooks print.
 */
const ID = "cc-remote-hook-";
const CARRIER = "cc-remote-hooks-carrier";

/** Claude Code's default timeout for a command or http hook on an event, in seconds. */
function defaultTimeout(event: string): number {
  if (["UserPromptSubmit", "PreModelSwitch", "PostModelSwitch"].includes(event)) return 30;
  if (event === "MessageDisplay") return 10;
  if (event === "SessionEnd") {
    const ms = Number(process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS);
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 1.5;
  }
  return 600;
}

/** The hook's own timeout, else the event's default. SessionEnd hooks get at most a minute. */
export function timeoutSeconds(hook: Pick<LocalHook, "event" | "handler">): number {
  const own = typeof hook.handler.timeout === "number" && hook.handler.timeout > 0 ? hook.handler.timeout : undefined;
  const seconds = own ?? defaultTimeout(hook.event);
  return hook.event === "SessionEnd" ? Math.min(seconds, 60) : seconds;
}

/**
 * Room for an answer to cross the link: claude's timer for a callback must not run out before
 * ours, since on PreToolUse claude blocks the tool when a callback doesn't answer, while a command
 * hook that times out lets the call go on to the permission check.
 */
const MARGIN = 30;

/** Events whose hooks may write `export` lines for the shell to CLAUDE_ENV_FILE. */
const ENV_FILE_EVENTS = ["SessionStart", "Setup"];

const isDirectory = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/**
 * One session's hooks from this machine's settings (config.ts), run on this machine. Each gets a
 * callback id of its own in claude's `initialize`, the way cc-remote's policy hook does (policy.ts),
 * so claude runs them in parallel with the SDK's own hooks and merges their answers; the proxy
 * passes claude's `hook_callback` requests for them here, and they never reach the SDK.
 *
 * Each run gets the hook input as Claude Code would give it on this machine: `cwd` is where the
 * local shell is, `transcript_path` the local mirror of the transcript (written up to the request
 * by the proxy, which handles the stream in order), and the host's scratchpad isn't mentioned.
 * Async hooks run in the background; what they leave for Claude comes with the next prompt, through
 * a carrier callback on UserPromptSubmit, which also runs the SessionStart hooks of a new session
 * (sessionStarted).
 */
export class LocalHooks {
  private readonly ids = new Map<string, LocalHook>();
  private readonly running = new Map<string, AbortController>();
  private readonly pending: string[] = [];
  private readonly transcripts: string;
  private told = new Set<string>();
  /**
   * Whether claude has called a SessionStart hook of ours back. In print mode claude starts the
   * startup ones before it reads the SDK's initialize, so for a new session none comes: the first
   * prompt runs them here instead, and brings Claude what they print (carry).
   */
  private sessionStarted = false;

  constructor(readonly config: HookConfig, private readonly session: { root: string; args: string[]; ws?: Workspace }) {
    config.local.forEach((h, i) => this.ids.set(`${ID}${i}`, h));
    this.transcripts = join(projectsDir(), projectKey(session.root));
  }

  /** What the host claude runs itself, for its `--settings`. */
  get host(): Record<string, unknown[]> {
    return this.config.host;
  }

  private tell(message: string) {
    if (this.told.has(message)) return;
    this.told.add(message);
    console.error(`cc-remote: ${message}`);
  }

  /** The initialize request with a matcher and a callback id for each local hook, once. */
  register(request: Json): Json {
    if (this.config.left.length) this.tell(`these hooks from your settings don't run: ${[...new Set(this.config.left)].join("; ")}`);
    const hooks: Record<string, Json[]> = { ...request.hooks };
    const ours = (m: Json | undefined) => Array.isArray(m?.hookCallbackIds) && m.hookCallbackIds.some((id: unknown) => this.owns(id));
    if (Object.values(hooks).some((matchers) => Array.isArray(matchers) && matchers.some(ours))) return request;
    const add = (event: string, entry: Json) => { hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry]; };
    for (const [id, hook] of this.ids) {
      const matcher = TOOL_EVENTS.includes(hook.event) ? widenMatcher(hook.matcher) : hook.matcher;
      add(hook.event, { ...(matcher === undefined ? {} : { matcher }), hookCallbackIds: [id], timeout: Math.ceil(timeoutSeconds(hook)) + MARGIN });
    }
    const starts = this.startHooks();
    if (starts.length || this.config.local.some((h) => h.handler.async === true || h.handler.asyncRewake === true)) {
      const longest = Math.max(30, ...starts.map((h) => timeoutSeconds(h)));
      add("UserPromptSubmit", { hookCallbackIds: [CARRIER], timeout: Math.ceil(longest) + MARGIN });
    }
    return this.ids.size ? { ...request, hooks } : request;
  }

  private startHooks(): LocalHook[] {
    return [...this.ids.values()].filter((h) => h.event === "SessionStart");
  }

  owns(id: unknown): boolean {
    return typeof id === "string" && (this.ids.has(id) || (id === CARRIER && this.ids.size > 0));
  }

  /** Where hooks run: the local shell's directory, or the project's when that one is gone. */
  private cwd(): string {
    const cwd = this.session.ws?.cwd;
    return cwd && isDirectory(cwd) ? cwd : this.session.root;
  }

  /** Whether the hook takes this call: still configured, its own matcher on the built-in tool name, and its condition. */
  private applies(hook: LocalHook, input: Json, cwd: string): boolean {
    if (!stillConfigured(this.session.root, this.session.args, hook.key)) return false;
    if (TOOL_EVENTS.includes(hook.event) && typeof input.tool_name === "string" && !matcherMatches(hook.matcher, input.tool_name)) return false;
    return hook.handler.if === undefined || condition(String(hook.handler.if), input, { root: this.session.root, cwd });
  }

  /** The hook input with this machine's paths. */
  localInput(input: Json, cwd: string): Json {
    const out: Json = { ...input, cwd };
    for (const key of ["transcript_path", "agent_transcript_path"]) {
      const rest = typeof out[key] === "string" ? out[key].match(/\/projects\/[^/]+\/(.+)$/)?.[1] : undefined;
      if (rest) out[key] = join(this.transcripts, rest);
    }
    delete out.scratchpad_dir;
    return out;
  }

  /** The file SessionStart and Setup hooks write `export` lines to, which the local Bash runs before each command. */
  private envFile(): string | undefined {
    const ws = this.session.ws;
    if (!ws || WINDOWS) return undefined;
    if (!ws.envFile) {
      const dir = mkdtempSync(join(tmpdir(), "cc-remote-env-"));
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      ws.envFile = join(dir, "env.sh");
      writeFileSync(ws.envFile, "", { mode: 0o600 });
    }
    return ws.envFile;
  }

  /** Claude Code's environment for a hook: its own, minus the OpenTelemetry exporters', plus the project folder. */
  private env(hook: LocalHook, input: Json): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OTEL_") && k !== "CLAUDE_ENV_FILE"));
    env.CLAUDE_PROJECT_DIR = this.session.root;
    if (typeof input.effort?.level === "string") env.CLAUDE_EFFORT = input.effort.level;
    const envFile = ENV_FILE_EVENTS.includes(hook.event) ? this.envFile() : undefined;
    if (envFile) env.CLAUDE_ENV_FILE = envFile;
    return env;
  }

  private run(hook: LocalHook, body: string, options: RunOptions): Promise<Outcome> {
    if (hook.handler.type !== "http") return runCommand(hook.handler, body, options);
    return runHttp(hook.handler, body, { ...options, urls: this.config.http.urls, envVars: this.config.http.envVars }).then((outcome) => {
      if (outcome.kind === "skipped") this.tell(`not sending an http hook: ${outcome.reason}`);
      return outcome;
    });
  }

  /**
   * Runs one hook for an event's input, which the hook already takes, and comes to its answer. A
   * SessionEnd hook outlives the session, as it would locally, since claude is going away and reads
   * nothing back; an async one runs in the background and leaves what it prints for the next prompt.
   */
  private start(hook: LocalHook, data: Json, cwd: string, signal?: AbortSignal): Promise<HookJSONOutput> {
    const event = typeof data.hook_event_name === "string" ? data.hook_event_name : hook.event;
    const body = JSON.stringify(this.localInput(data, cwd));
    const options: RunOptions = { cwd, env: this.env(hook, data), timeoutMs: timeoutSeconds(hook) * 1000 };
    const command = hook.handler.type === "command";
    if (event === "SessionEnd" && command) {
      void this.run(hook, body, { ...options, detach: true });
      return Promise.resolve({});
    }
    if (command && (hook.handler.async === true || hook.handler.asyncRewake === true)) {
      const rewake = hook.handler.asyncRewake === true;
      void this.run(hook, body, { ...options, timeoutMs: rewake ? options.timeoutMs : undefined }).then((o) => this.pending.push(...asyncContext(o, rewake)));
      return Promise.resolve({ async: true });
    }
    return this.run(hook, body, { ...options, signal })
      .then((outcome) => hookOutput(event, outcome, hook.handler.onFailure))
      .catch((e): HookJSONOutput => ({ systemMessage: `${event} hook error: ${(e as Error).message}` }));
  }

  /** Answers claude's callback for one of ours with `reply`, once the hook is done; a cancelled one gets no answer. */
  answer(requestId: string, callbackId: string, input: Json | undefined, reply: (output: HookJSONOutput) => void): void {
    const data = input ?? {};
    const abort = new AbortController();
    this.running.set(requestId, abort);
    const done = (output: HookJSONOutput) => { if (this.running.delete(requestId)) reply(output); };
    if (callbackId === CARRIER) return void this.carry(data).then(done);
    const hook = this.ids.get(callbackId);
    if (hook?.event === "SessionStart") this.sessionStarted = true;
    const cwd = this.cwd();
    if (!hook || !this.applies(hook, data, cwd)) return done({});
    void this.start(hook, data, cwd, abort.signal).then(done);
  }

  /**
   * The carrier's answer on UserPromptSubmit: what finished async hooks left, and on the first
   * prompt of a session whose SessionStart claude didn't call back, what the SessionStart hooks
   * print, run now with the prompt's session, transcript and directory.
   */
  private async carry(prompt: Json): Promise<HookJSONOutput> {
    const messages: string[] = [];
    if (!this.sessionStarted && this.startHooks().length) {
      this.sessionStarted = true;
      const { prompt: _, ...common } = prompt;
      const data = { ...common, hook_event_name: "SessionStart", source: startSource(this.session.args) };
      const cwd = this.cwd();
      const hooks = this.startHooks().filter((h) => matcherMatches(h.matcher, data.source) && this.applies(h, data, cwd));
      const contexts: string[] = [];
      for (const output of (await Promise.all(hooks.map((h) => this.start(h, data, cwd)))) as Json[]) {
        if (typeof output.hookSpecificOutput?.additionalContext === "string" && output.hookSpecificOutput.additionalContext) contexts.push(output.hookSpecificOutput.additionalContext);
        if (typeof output.systemMessage === "string") messages.push(output.systemMessage);
      }
      this.pending.unshift(...contexts);
    }
    return {
      ...(messages.length ? { systemMessage: messages.join("\n") } : {}),
      ...(this.pending.length ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit" as const, additionalContext: this.pending.splice(0).join("\n\n") } } : {}),
    };
  }

  /** Stops the hook claude cancelled the request for. False when it wasn't one of ours. */
  cancel(requestId: string): boolean {
    const abort = this.running.get(requestId);
    if (!abort) return false;
    this.running.delete(requestId);
    abort.abort();
    return true;
  }
}

/** How the session started, as SessionStart's matcher and `source` name it. */
function startSource(args: string[]): string {
  if (args.includes("--fork-session")) return "fork";
  return argument(args, "--resume", "-r") !== undefined || args.includes("--continue") || args.includes("-c") ? "resume" : "startup";
}

/** The hooks of this machine's settings for a session started with these arguments in `root`. */
export const sessionHooks = (root: string, args: string[], ws?: Workspace) => new LocalHooks(loadHooks(root, args), { root, args, ws });
