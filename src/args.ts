import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { hostTools, keepsMonitor, PREFIX, READS } from "./names";
import { redaction } from "./redact";
import { hostDir, reconnectGrace, type Upload } from "./ssh";

/** Flags that take several values; as in claude's parser, the values run up to the next flag. */
const VARIADIC = new Set(["--add-dir", "--mcp-config", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools"]);

/** Flags that take a JSON value or the path of a file holding it. The host can't read the file. */
const JSON_OR_FILE = new Set(["--settings", "--agents"]);

/** Flags that name a file whose text is the value. The host gets the text. */
const TEXT_FILE: Record<string, string> = { "--system-prompt-file": "--system-prompt", "--append-system-prompt-file": "--append-system-prompt" };

/** How a claude command line from a local SDK becomes one for claude on the host. */
export type HostLaunch = {
  /** The arguments for claude on the host. */
  args: string[];
  /** Local plugins the host gets a copy of first. */
  uploads: Upload[];
  /** `--add-dir` directories. They are local, so the host doesn't get them; the prompt names them. */
  addDirs: string[];
  /** The servers of `--mcp-config`. They are local and get bridged instead of started on the host. */
  mcpServers: Record<string, McpServerConfig>;
  /** `--strict-mcp-config`: no MCP servers but the ones the command line names. */
  strictMcpConfig: boolean;
  /** The permission mode claude starts in. */
  mode: string;
};

/**
 * A name for a local plugin (a directory, or a .zip) on the host that changes whenever its files
 * do, so a copy already there is a current one. Under redaction it has placeholders, and it
 * changes with what redaction replaces, as the filtered copy does.
 */
function fingerprint(path: string): string {
  const r = redaction();
  return r.on ? r.text(plainFingerprint(path, `\nredacted ${r.stamp}`)) : plainFingerprint(path);
}

function plainFingerprint(path: string, salt = ""): string {
  const info = statSync(path);
  const files = info.isDirectory()
    ? readdirSync(path, { recursive: true, encoding: "utf8" }).sort().map((f) => {
        const s = statSync(join(path, f));
        return `${f}:${s.size}:${s.mtimeMs}`;
      })
    : [`:${info.size}:${info.mtimeMs}`];
  const ext = info.isDirectory() ? "" : extname(path);
  return `${basename(path, ext).replace(/[^\w.-]/g, "_")}-${Bun.hash(`${path}\n${files.join("\n")}${salt}`).toString(36)}${ext}`;
}

/** The flags that name a local plugin, which the host gets a copy of. */
const PLUGIN_FLAGS = new Set(["--plugin-dir", "--plugin-dir-no-mcp"]);

/** From the host folder for `cwd`, up to the host's home: the plugins live there, outside any one project. */
const toHome = (cwd: string) => "../".repeat(hostDir(cwd).split("/").filter(Boolean).length);

/**
 * A local plugin as the host gets it: copied up first, and found there at `path`, from claude's
 * folder. Undefined, with a note, when it isn't readable here, or has no path: an empty one would
 * be the project's folder.
 */
function hostPlugin(value: string, cwd: string): { path: string; upload: Upload } | undefined {
  if (!value) {
    console.error("cc-remote: leaving out a plugin with an empty path");
    return undefined;
  }
  const local = resolve(cwd, value);
  try {
    const remote = `.cc-remote/plugins/${fingerprint(local)}`;
    return { path: `${toHome(cwd)}${remote}`, upload: { local, remote } };
  } catch {
    console.error(`cc-remote: leaving out the plugin ${local}, which is not readable here`);
    return undefined;
  }
}

/**
 * A command line with its plugins copied up as hostLaunch has them, and the rest as it is: for
 * claude-agent-acp's sessions, whose other options cc-remote sets itself (options.ts).
 */
export function hostPlugins(argv: string[], cwd: string): { args: string[]; uploads: Upload[] } {
  const args: string[] = [];
  const uploads: Upload[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!PLUGIN_FLAGS.has(flag)) {
      args.push(a);
      continue;
    }
    const plugin = hostPlugin(eq > 0 ? a.slice(eq + 1) : (argv[++i] ?? ""), cwd);
    if (plugin) {
      args.push(`${flag}=${plugin.path}`);
      uploads.push(plugin.upload);
    }
  }
  return { args, uploads };
}

/**
 * The plugins an SDK lists in its initialize request (pluginDelivery: 'initialize') as the host
 * gets them: copied up, each named by its path there, which redaction then leaves as it is. One
 * that can't be copied is left out of the list, and counted.
 */
export function hostPluginList(plugins: unknown, cwd: string): { plugins: unknown[]; uploads: Upload[]; leftOut: number } {
  const out = { plugins: [] as unknown[], uploads: [] as Upload[], leftOut: 0 };
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (p?.type !== "local") {
      out.plugins.push(p);
      continue;
    }
    const plugin = hostPlugin(typeof p.path === "string" ? p.path : "", cwd);
    if (!plugin) {
      out.leftOut++;
      continue;
    }
    redaction().keep(plugin.path);
    out.plugins.push({ ...p, path: plugin.path });
    out.uploads.push(plugin.upload);
  }
  return out;
}

const isJson = (value: string) => /^\s*[{[]/.test(value);

function readJson(value: string, cwd: string): unknown {
  return JSON.parse(isJson(value) ? value : readFileSync(resolve(cwd, value), "utf8"));
}

/** A file's text in place of its path, when it's readable here; else the value as it was. */
function inline(value: string, cwd: string): string {
  try {
    return readFileSync(resolve(cwd, value), "utf8");
  } catch {
    return value;
  }
}

/**
 * Rewrites the command line a local SDK gives `claude` for the claude on the host. Paths on this
 * machine don't exist there: plugins are copied up, settings files are inlined, extra directories
 * and MCP configs stay here. With `stream` (stream-json input, so an SDK on the other end), the
 * local tools come in as the `cc` server, so the built-ins they replace are turned off and the
 * transcript is mirrored back. Without it (a one-off `-p`), the host's tools are only turned off.
 */
export function hostLaunch(argv: string[], cwd: string, stream: boolean): HostLaunch {
  const out: string[] = [];
  const launch: HostLaunch = { args: out, uploads: [], addDirs: [], mcpServers: {}, strictMcpConfig: false, mode: "default" };
  const allowed: string[] = [];
  const disallowed: string[] = [];
  // A stream session under the relay keeps claude's Monitor, whose commands run here: its tools are named, not denied.
  const relayed = stream && reconnectGrace() > 0;
  let tools: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const values = (): string[] => {
      if (eq > 0) return [a.slice(eq + 1)];
      const taken: string[] = [];
      if (VARIADIC.has(flag)) while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) taken.push(argv[++i]!);
      else if (i + 1 < argv.length) taken.push(argv[++i]!);
      return taken;
    };

    if (flag === "--add-dir") launch.addDirs.push(...values().map((d) => resolve(cwd, d)));
    else if (flag === "--allowedTools" || flag === "--allowed-tools") allowed.push(...values());
    else if (flag === "--disallowedTools" || flag === "--disallowed-tools") disallowed.push(...values());
    else if (flag === "--tools" && keepsMonitor(relayed)) (tools ??= []).push(...values());
    else if (flag === "--mcp-config") {
      for (const value of values()) {
        try {
          Object.assign(launch.mcpServers, (readJson(value, cwd) as { mcpServers?: object }).mcpServers);
        } catch (e) {
          console.error(`cc-remote: ignoring the MCP config ${value.slice(0, 80)}: ${(e as Error).message}`);
        }
      }
    } else if (PLUGIN_FLAGS.has(flag)) {
      const [value = ""] = values();
      const plugin = hostPlugin(value, cwd);
      if (plugin) {
        launch.uploads.push(plugin.upload);
        out.push(`${flag}=${plugin.path}`);
      }
    } else if (JSON_OR_FILE.has(flag)) {
      const [value = ""] = values();
      out.push(flag, isJson(value) ? value : inline(value, cwd));
    } else if (TEXT_FILE[flag]) {
      const [value = ""] = values();
      const text = inline(value, cwd);
      out.push(...(text === value ? [flag, value] : [TEXT_FILE[flag]!, text]));
    } else {
      if (flag === "--strict-mcp-config") launch.strictMcpConfig = true;
      if (flag === "--permission-mode") launch.mode = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] ?? launch.mode);
      // claude's older spelling of bypassPermissions; claude's init message would correct it later.
      if (flag === "--dangerously-skip-permissions") launch.mode = "bypassPermissions";
      out.push(a);
    }
  }

  // One occurrence each, ours added to the caller's, so nothing depends on how repeats combine.
  if (stream) allowed.push(...READS.map((t) => PREFIX + t));
  if (allowed.length) out.push(`--allowedTools=${allowed.join(",")}`);
  const host = hostTools(relayed, tools);
  if (keepsMonitor(relayed)) out.push(`--tools=${host.tools!.join(",")}`);
  out.push(`--disallowedTools=${[...disallowed, ...host.disallowed].join(",")}`);
  if (stream && !out.includes("--session-mirror")) out.push("--session-mirror");
  return launch;
}
