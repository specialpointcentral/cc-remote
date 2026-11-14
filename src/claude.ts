import { hostLaunch } from "./args";
import { runClaude } from "./auth-cache";
import { bridgeAll } from "./bridge";
import { sdkHost } from "./control";
import { grantsSession } from "./grants";
import { sessionHooks } from "./hooks";
import type { HostProcess } from "./host-process";
import { localMcpServers } from "./mcp";
import { environment } from "./prompt";
import { proxy } from "./proxy";
import { argument, asChild, hostDir, hostVersion, launch, runRemote, tellTools } from "./ssh";
import { localTools } from "./tools";
import { workspace } from "./tools/util";

/**
 * What an app asks to find out which claude it has. The host's claude answers, as it would locally;
 * the version from the cache, since Orca asks for it before every chat.
 */
const VERSION = [["--version"], ["-v"]];
const HELP = [["--help"], ["-h"]];
const asked = (probes: string[][], argv: string[]) => probes.some((p) => p.length === argv.length && p.every((a, i) => a === argv[i]));

/**
 * The environment claude gets from the SDK that started it, which ssh would drop: its own
 * variables and Claude Code's settings. Never the login or the provider, which belong to the host,
 * and never CLAUDE_CONFIG_DIR, which names a folder on this machine.
 */
export function forwardedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && /^CLAUDE_(CODE|AGENT_SDK)_/.test(e[0]) && !/_(TOKEN|KEY|SECRET|PASSWORD)(_|$)|^CLAUDE_CODE_USE_/.test(e[0]),
    ),
  );
}

/** Exits with the child's status once everything it wrote has reached our stdout. */
function exitWith(child: HostProcess, stdout: NodeJS.ReadableStream) {
  let ended = false;
  let code: number | null | undefined;
  const done = () => { if (ended && code !== undefined) process.exit(code ?? 1); };
  stdout.on("end", () => { ended = true; done(); });
  child.on("exit", (status, signal) => { code = status ?? (signal ? 1 : 0); done(); });
  child.on("error", (e) => { console.error(`cc-remote: ${e.message}`); process.exit(1); });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
}

/**
 * cc-remote as the `claude` executable itself, for an app that embeds the Claude Agent SDK and lets
 * the user pick the executable, such as Orca. That SDK starts this with claude's own arguments and
 * speaks stream-json to it; cc-remote starts claude on the host instead and sits on the stream, as
 * the proxy does under claude-agent-acp, and also plays the SDK's part for the local tools.
 */
export async function claudeCompat(host: string, argv: string[]): Promise<void> {
  const cwd = process.cwd();
  if (asked(VERSION, argv)) {
    const version = await hostVersion(host);
    if (version) await new Promise((written) => process.stdout.write(`${version}\n`, written));
    process.exit(version ? 0 : 1);
  }
  if (asked(HELP, argv)) process.exit(await runRemote(host, argv, cwd));

  // stdout is claude's: diagnostics go to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const stream = argument(argv, "--input-format") === "stream-json";
  if (!stream && !argv.includes("-p") && !argv.includes("--print")) {
    // claude's own subcommands, such as `auth status`, are about the host's claude: run them there.
    if (argv[0] && !argv[0].startsWith("-")) process.exit(await runClaude(host, argv, cwd));
    console.error(
      "cc-remote: `cc-remote claude` stands in for claude under an app that embeds the Claude Agent SDK, such as Orca's chats. " +
        "An interactive claude would work on the host's folder, not this machine's. Use an ACP client such as acpc here, " +
        "or `cc-remote --cli` to run claude on the host itself.",
    );
    process.exit(1);
  }

  const plan = hostLaunch(argv, cwd, stream);
  const env = forwardedEnv(process.env);
  if (!stream) {
    // A one-off `-p`, such as a title: no SDK on the other end, so no local tools either.
    const child = launch(host, cwd, plan.args, env, plan.uploads);
    process.stdin.pipe(child.stdin!);
    child.stdout!.pipe(process.stdout);
    return exitWith(child, child.stdout!);
  }

  const [prompt, local] = await Promise.all([environment(cwd, plan.addDirs), plan.strictMcpConfig ? {} : localMcpServers(cwd)]);
  const closing = new AbortController();
  process.on("exit", () => closing.abort());
  // Shared by the tools and the stream: the shell's directory, and the host's own files.
  const ws = workspace(cwd);
  // The command line's servers win over the local config's, as the ACP client's do.
  const servers = { ...bridgeAll({ ...local, ...plan.mcpServers }, cwd, closing.signal), cc: localTools(ws) };
  // The hooks of this machine's settings: run here, or by the host claude through its --settings.
  const hooks = sessionHooks(cwd, plan.args, ws);
  const child = launch(host, cwd, plan.args, { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }, plan.uploads, undefined, tellTools(host, ws), hooks.host);
  const session = { cwd, hostDir: hostDir(cwd), mode: plan.mode, dirs: plan.addDirs, ws, sessionId: grantsSession(plan.args), hooks };
  const sdk = proxy(asChild(child), session, (toClaude) => sdkHost(servers, prompt, toClaude));
  process.stdin.pipe(sdk.stdin);
  sdk.stdout.pipe(process.stdout);
  exitWith(child, sdk.stdout);
}
