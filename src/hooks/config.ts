import { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk";
import { TOOL_EVENTS, widenMatcher } from "../names";
import { identity, readSettings, settingsSources } from "../rules";
import { argument, settingsObject } from "../ssh";

/**
 * The hooks of this machine's Claude Code settings. claude on the host reads only the host's
 * settings, so these would never run; cc-remote reads them here, from the files Claude Code itself
 * would read on this machine, and runs them: command and http hooks here (index.ts), prompt and
 * MCP tool hooks, which need the model or claude's own MCP connections, through the host claude's
 * `--settings`. The rules follow Claude Code's hooks reference:
 *
 * - Sources: managed settings (the file and its drop-ins) and the `--settings` flag always; the
 *   user, project and local files as `--setting-sources` names them (all of them without the
 *   flag, none of them with `--bare`). Hooks merge across files; the same handler under the same
 *   matcher in several files runs once.
 * - `disableAllHooks` takes the value of the highest file that sets it (managed, flag, local,
 *   project, user). Set outside managed settings it stops all but the managed hooks; in managed
 *   settings, all of them.
 * - Managed `allowManagedHooksOnly`, or `strictPluginOnlyCustomization` locking hooks, leaves only
 *   the managed hooks. Hooks of the `--settings` flag count as not managed there: the reference
 *   doesn't say, and that is the stricter reading.
 * - A handler with `if` runs only on the tool events; elsewhere it never runs.
 * - `allowedHttpHookUrls` and `httpHookAllowedEnvVars` merge across the files read.
 */

/** One hook handler as settings write it. */
export type Handler = {
  type: string;
  command?: string;
  args?: string[];
  timeout?: number;
  async?: boolean;
  asyncRewake?: boolean;
  shell?: string;
  onFailure?: string;
  if?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  [key: string]: unknown;
};

/** Where a hook came from. */
export type Source = "managed" | "flag" | "local" | "project" | "user";

/** A hook cc-remote runs on this machine: a command or http handler, under its event and matcher. */
export type LocalHook = { event: string; matcher?: string; handler: Handler; source: Source; key: string };

/** A matcher group as settings and `--settings` lay them out. */
export type Group = { matcher?: string; hooks: Handler[] };

export type HookConfig = {
  /** Command and http hooks, run here. */
  local: LocalHook[];
  /** Prompt and MCP tool hooks, for the host claude's `--settings`, with tool matchers widened to the local tools. */
  host: Record<string, Group[]>;
  /** Hooks that run nowhere, and why, for one line on stderr. */
  left: string[];
  /** The http hooks' URL and environment variable allowlists, when a settings file sets them. */
  http: { urls?: string[]; envVars?: string[] };
};

/**
 * Events claude on the host can't report as they happen here: its directory never changes (the
 * shell is local), it watches and loads the host's files, and worktrees are refused (policy.ts).
 */
export const UNSUPPORTED: Record<string, string> = {
  CwdChanged: "the server's claude never changes directory",
  FileChanged: "the server's claude watches its own folder",
  ConfigChange: "the server's claude watches its own settings",
  InstructionsLoaded: "cc-remote puts your CLAUDE.md files in the prompt itself",
  DirectoryAdded: "directories are added on the server",
  WorktreeCreate: "worktrees are turned off",
  WorktreeRemove: "worktrees are turned off",
};

/** Events hooks of this machine run for. */
export const SUPPORTED: string[] = HOOK_EVENTS.filter((e) => !(e in UNSUPPORTED));

type Loaded = { source: Source; path: string; settings: Record<string, unknown> };

/** The order Claude Code ranks settings in, highest first. */
const RANK: Source[] = ["managed", "flag", "local", "project", "user"];

/** The command line's `--settings` values, as objects. */
function flagSettings(args: string[], cwd: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = a === "--settings" ? args[++i] : a.startsWith("--settings=") ? a.slice("--settings=".length) : undefined;
    const settings = value === undefined ? undefined : settingsObject(value, cwd);
    if (settings) out.push(settings);
  }
  return out;
}

/** The sources `--setting-sources` lets in besides managed settings and the flag. */
function allowedSources(args: string[]): Set<Source> {
  if (args.includes("--bare")) return new Set();
  const named = argument(args, "--setting-sources");
  if (named === undefined) return new Set(["user", "project", "local"]);
  return new Set(named.split(",").map((s) => s.trim()).filter((s): s is Source => ["user", "project", "local"].includes(s)));
}

const warned = new Set<string>();
/** Says once per process that a file's hooks can't be known. */
function warn(problem: string) {
  if (warned.has(problem)) return;
  warned.add(problem);
  console.error(`cc-remote: ${problem}, so its hooks don't run`);
}

/** The settings files read, highest rank first; within a rank the later file wins, so it comes first. */
function filePaths(root: string, args: string[]): [Source, string][] {
  const sources = settingsSources(root);
  const allowed = allowedSources(args);
  return [
    ...[...sources.managed].reverse().map((p): [Source, string] => ["managed", p]),
    ...(allowed.has("local") ? [...sources.local].reverse().map((p): [Source, string] => ["local", p]) : []),
    ...(allowed.has("project") ? [["project", sources.project] as [Source, string]] : []),
    ...(allowed.has("user") ? [["user", sources.user] as [Source, string]] : []),
  ];
}

/** The settings the hooks come from, highest rank first, the command line's right below the managed ones. */
function load(root: string, args: string[]): Loaded[] {
  const files: Loaded[] = [];
  const paths = filePaths(root, args);
  const read = ([source, path]: [Source, string]) => {
    const { settings, problem } = readSettings(path);
    if (problem) warn(problem);
    if (settings) files.push({ source, path, settings });
  };
  paths.filter(([s]) => s === "managed").forEach(read);
  files.push(...flagSettings(args, root).reverse().map((settings): Loaded => ({ source: "flag", path: "--settings", settings })));
  paths.filter(([s]) => s !== "managed").forEach(read);
  return files;
}

/** Which sources' hooks run, from the files' switches. */
function running(files: Loaded[]): Set<Source> | "none" {
  const disable = files.find((f) => typeof f.settings.disableAllHooks === "boolean");
  if (disable?.settings.disableAllHooks === true && disable.source === "managed") return "none";
  const managed = files.filter((f) => f.source === "managed");
  const strict = (s: unknown) => s === true || (Array.isArray(s) && s.includes("hooks"));
  const managedOnly = disable?.settings.disableAllHooks === true
    || managed.some((f) => f.settings.allowManagedHooksOnly === true || strict(f.settings.strictPluginOnlyCustomization));
  return new Set(managedOnly ? ["managed"] : RANK);
}

/** The same JSON whatever order a file wrote the keys in, so equal handlers compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

/** The hooks these settings define, as Claude Code would load them for a session root and command line. */
export function loadHooks(root: string, args: string[]): HookConfig {
  const files = load(root, args);
  const config: HookConfig = { local: [], host: {}, left: [], http: {} };
  for (const f of files) {
    const urls = strings(f.settings.allowedHttpHookUrls);
    if (urls) config.http.urls = [...(config.http.urls ?? []), ...urls];
    const envVars = strings(f.settings.httpHookAllowedEnvVars);
    if (envVars) config.http.envVars = [...(config.http.envVars ?? []), ...envVars];
  }
  const sources = running(files);
  if (sources === "none") return config;
  const seen = new Set<string>();
  for (const f of files) {
    if (!sources.has(f.source)) continue;
    const hooks = f.settings.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) continue;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      if (!SUPPORTED.includes(event)) {
        config.left.push(`${event} (${UNSUPPORTED[event] ?? "not a hook event this cc-remote knows"})`);
        continue;
      }
      for (const group of groups) {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
        const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
        for (const handler of group.hooks as Handler[]) {
          if (!handler || typeof handler !== "object") continue;
          // On other events, Claude Code never runs a handler with a condition.
          if (handler.if !== undefined && !TOOL_EVENTS.includes(event)) continue;
          const key = stable([event, matcher ?? "", handler]);
          if (seen.has(key)) continue;
          seen.add(key);
          place(config, { event, matcher, handler, source: f.source, key });
        }
      }
    }
  }
  return config;
}

/** Puts one hook where it runs: here, on the host, or nowhere. */
function place(config: HookConfig, hook: LocalHook) {
  const { event, matcher, handler } = hook;
  if ((handler.type === "command" && typeof handler.command === "string" && handler.command) || (handler.type === "http" && typeof handler.url === "string")) {
    config.local.push(hook);
  } else if (handler.type === "prompt" || handler.type === "mcp_tool") {
    // They need the model, or claude's own MCP connections; the local servers are among those.
    const groups = (config.host[event] ??= []);
    const widened = TOOL_EVENTS.includes(event) ? widenMatcher(matcher) : matcher;
    const group = groups.find((g) => g.matcher === widened);
    if (group) group.hooks.push(handler);
    else groups.push({ ...(widened === undefined ? {} : { matcher: widened }), hooks: [handler] });
  } else if (handler.type === "agent") {
    config.left.push(`an agent hook on ${event} (its subagent would work on the server's files)`);
  } else {
    config.left.push(`a ${String(handler.type)} hook on ${event} (not a hook type this cc-remote knows)`);
  }
}

const current = new Map<string, { identity: string; keys: Set<string> }>();

/**
 * Whether a hook is still in the settings, as they are now. Claude Code reloads hooks when a
 * settings file changes; claude learns of ours only at the start, so a removed or disabled hook
 * stops running at once, and a new one starts with the next session.
 */
export function stillConfigured(root: string, args: string[], key: string): boolean {
  const id = identity(filePaths(root, args).map(([, p]) => p));
  const cacheKey = `${root}\0${args.join("\0")}`;
  let hit = current.get(cacheKey);
  if (hit?.identity !== id) {
    hit = { identity: id, keys: new Set(loadHooks(root, args).local.map((h) => h.key)) };
    current.set(cacheKey, hit);
  }
  return hit.keys.has(key);
}
