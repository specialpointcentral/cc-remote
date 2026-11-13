import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { PREFIX, READS, REMOVED } from "./names";
import { hostDir, type Upload } from "./ssh";

/** Flags that take several values; as in claude's parser, the values run up to the next flag. */
const VARIADIC = new Set(["--add-dir", "--mcp-config", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools"]);

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
 * do, so a copy already there is a current one.
 */
function fingerprint(path: string): string {
  const info = statSync(path);
  const files = info.isDirectory()
    ? readdirSync(path, { recursive: true, encoding: "utf8" }).sort().map((f) => {
        const s = statSync(join(path, f));
        return `${f}:${s.size}:${s.mtimeMs}`;
      })
    : [`:${info.size}:${info.mtimeMs}`];
  const ext = info.isDirectory() ? "" : extname(path);
  return `${basename(path, ext).replace(/[^\w.-]/g, "_")}-${Bun.hash(`${path}\n${files.join("\n")}`).toString(36)}${ext}`;
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
  // From the host folder, up to the host's home: the plugins live there, outside any one project.
  const toHome = "../".repeat(hostDir(cwd).split("/").filter(Boolean).length);

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
    else if (flag === "--mcp-config") {
      for (const value of values()) {
        try {
          Object.assign(launch.mcpServers, (readJson(value, cwd) as { mcpServers?: object }).mcpServers);
        } catch (e) {
          console.error(`cc-remote: ignoring the MCP config ${value.slice(0, 80)}: ${(e as Error).message}`);
        }
      }
    } else if (flag === "--plugin-dir" || flag === "--plugin-dir-no-mcp") {
      const [value = ""] = values();
      const local = resolve(cwd, value);
      try {
        const remote = `.cc-remote/plugins/${fingerprint(local)}`;
        launch.uploads.push({ local, remote });
        out.push(`${flag}=${toHome}${remote}`);
      } catch {
        console.error(`cc-remote: leaving out the plugin ${local}, which is not readable here`);
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
  out.push(`--disallowedTools=${[...disallowed, ...REMOVED].join(",")}`);
  if (stream && !out.includes("--session-mirror")) out.push("--session-mirror");
  return launch;
}
