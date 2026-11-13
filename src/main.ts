#!/usr/bin/env bun
import { setQueryOptionsTransform } from "@agentclientprotocol/claude-agent-acp";
import acpPkg from "@agentclientprotocol/claude-agent-acp/package.json";
import { acpProtocolsFromEnv, serveAcp } from "@agentclientprotocol/claude-agent-acp/dist/serve.js";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import pkg from "../package.json";
import { claudeCompat } from "./claude";
import { remote } from "./options";
import { WINDOWS } from "./platform";
import { hostVersion, quote, rsh, runRemote } from "./ssh";
import { killAll } from "./tools";
import { home } from "./tools/util";
import { tooOld } from "./version";

const USAGE = `Usage: cc-remote [--host <host>]
       cc-remote [--host <host>] --cli <claude arguments...>
       cc-remote [--host <host>] claude <claude arguments...>
       cc-remote [--host <host>] doctor

Claude Code as an ACP agent, with the model on a remote host and the tools on this machine.
Point an ACP client (Zed, paseo, ...) at \`cc-remote --host <host>\`.

  --host <host>    ssh host where claude is installed and logged in
                   (else $CC_REMOTE_HOST, else ~/.config/cc-remote/host)
  --cli <args...>  run claude on the host with these arguments, e.g. --cli auth login
  claude <args...> stand in for the claude executable of an app that embeds the Claude
                   Agent SDK, such as Orca: its tools run here, in the current directory.
                   Also what cc-remote does when it is run under the name \`claude\`
  doctor           check the connection and the remote claude version
  -v, --version    print the version
  -h, --help       print this help

  CC_REMOTE_SSH="ssh -p 2222"   ssh command to use, like rsync's RSYNC_RSH`;

/** A binary from `bun build --compile`, as opposed to `bun src/main.ts`. */
const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");

const fail = (message: string): never => {
  console.error(`cc-remote: ${message}`);
  process.exit(1);
};

function parse(argv: string[]) {
  const args = { host: undefined as string | undefined, cli: undefined as string[] | undefined, claude: undefined as string[] | undefined, doctor: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cli") { args.cli = argv.slice(i + 1); break; }
    if (a === "claude") { args.claude = argv.slice(i + 1); break; }
    if (a === "--host") args.host = argv[++i] ?? fail("--host needs a value");
    else if (a.startsWith("--host=")) args.host = a.slice(7);
    else if (a === "doctor") args.doctor = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else fail(`unknown argument ${a}. See cc-remote --help`);
  }
  return args;
}

async function host(flag?: string): Promise<string> {
  const file = Bun.file(`${home}/.config/cc-remote/host`);
  const found = flag ?? Bun.env.CC_REMOTE_HOST ?? ((await file.exists()) ? (await file.text()).trim() : "");
  return found || fail("no host. Pass --host, set CC_REMOTE_HOST, or write the host to ~/.config/cc-remote/host");
}

async function doctor(target: string) {
  console.log(`cc-remote ${pkg.version} (claude-agent-acp ${acpPkg.version})`);
  console.log(`host: ${target} via ${rsh().join(" ")}`);
  // Always asked live; what it finds is what session starts go by for the next while.
  const out = (await hostVersion(target, true)) ?? fail(`could not run claude on ${target}`);
  console.log(`remote claude: ${out}`);
  const problem = tooOld(target, out);
  if (problem) fail(problem);
  console.log("ok");
}

/**
 * claude-agent-acp runs `claude auth status`, `claude auth logout` and the like itself. This points
 * it at a script that runs them on the host, through `cc-remote --cli`.
 */
function claudeShim(target: string) {
  const self = COMPILED ? [process.execPath] : [process.execPath, Bun.main];
  const name = `claude-${Bun.hash(target).toString(36)}`;
  const command = [...self, "--host", target, "--cli"];
  if (WINDOWS) {
    // The temp folder is already per user there.
    const file = join(tmpdir(), "cc-remote", `${name}.cmd`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `@echo off\r\n${command.map((a) => `"${a}"`).join(" ")} %*\r\n`);
    return file;
  }
  const dir = `/tmp/cc-remote-${userInfo().uid}`;
  const file = `${dir}/${name}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `#!/bin/sh\nexec ${command.map(quote).join(" ")} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** As claude-agent-acp's own entry point: ACP on stdio, everything else on stderr. */
function serve(target: string) {
  process.env.CLAUDE_CODE_EXECUTABLE = claudeShim(target);
  setQueryOptionsTransform(remote(target));
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  process.on("unhandledRejection", (reason) => console.error("cc-remote: unhandled rejection:", reason));
  const acp = serveAcp(undefined, { protocols: acpProtocolsFromEnv(Bun.env.CLAUDE_AGENT_ACP_PROTOCOL) });
  const shutdown = async () => {
    await acp.dispose().catch((e: unknown) => console.error("cc-remote: cleanup failed:", e));
    process.exit(0);
  };
  acp.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.resume();
}

// We approve our read-only tools with bare allowedTools entries on purpose, which the SDK warns about.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: [{ code?: string }?]) => {
  if (rest[0]?.code !== "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") emitWarning(warning, ...(rest as []));
}) as typeof process.emitWarning;

/**
 * A compiled cc-remote run as `claude` (a link or copy by that name) takes every argument as
 * claude's. Under bun the script's name is already resolved through links, so there it's only
 * `cc-remote claude`.
 */
const asClaude = COMPILED && basename(process.argv0).replace(/\.exe$/i, "") === "claude";

const args = asClaude ? { ...parse([]), claude: process.argv.slice(2) } : parse(process.argv.slice(2));
if (args.claude) {
  const target = await host(args.host);
  process.on("exit", killAll);
  await claudeCompat(target, args.claude);
} else if (args.help) {
  console.log(USAGE);
} else if (args.version) {
  console.log(`${pkg.version} (cc-remote, claude-agent-acp ${acpPkg.version})`);
} else {
  const target = await host(args.host);
  process.on("exit", killAll);
  if (args.cli) process.exit(await runRemote(target, args.cli, process.cwd()));
  else if (args.doctor) await doctor(target);
  else serve(target);
}
