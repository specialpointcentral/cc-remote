// A stand-in for an app that embeds the Claude Agent SDK, such as Orca: it runs `cc-remote claude`
// as its claude executable, on test/e2e/fakessh, and breaks the link in the middle of a turn to
// show that the turn carries on. Needs a logged-in claude on this machine; each scenario costs one
// small turn.
//
//   FAKE_HOST_ISOLATED=1 bun test/e2e/sdk.ts <cwd> <scenario>
//
//   bash    the link is killed while a local Bash tool call (sleep 12) runs
//   prompt  the link is killed while a permission prompt is open; it's answered after the reconnect
//   freeze  the link is frozen (SIGSTOP) during a Bash call; the heartbeat finds it (CC_REMOTE_LINK_TIMEOUT=5)
//
// It prints the turn's tool calls and result, what cc-remote said on stderr, and compares the
// session's local transcript (the mirror) with the host's, entry by entry. End the fake host with
// `test/e2e/fakessh --stop`. Point XDG_CACHE_HOME at a scratch folder to keep caches out of ~/.cache.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectKey, projectsDir } from "../../src/sessions";

const [cwd, scenario] = process.argv.slice(2);
if (!cwd || !["bash", "prompt", "freeze"].includes(scenario ?? "")) {
  console.error("usage: bun test/e2e/sdk.ts <cwd> bash|prompt|freeze");
  process.exit(2);
}
const root = `${import.meta.dir}/../..`;
const exe = join(mkdtempSync(join(tmpdir(), "cc-remote-sdk-")), "claude");
writeFileSync(exe, `#!/bin/sh\nexec bun ${root}/src/main.ts --host fakehost claude "$@"\n`);
chmodSync(exe, 0o755);
Object.assign(process.env, { CC_REMOTE_SSH: `${import.meta.dir}/fakessh`, REAL_HOME: process.env.REAL_HOME ?? process.env.HOME });
if (scenario === "freeze") process.env.CC_REMOTE_LINK_TIMEOUT = "5";

/** The ssh processes carrying a relay for a cc-remote of ours: the bridges, whose parent is cc-remote. */
function links(): number[] {
  const found: number[] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!cmd.some((a) => /\/relay-[0-9a-f]+\.py$/.test(a)) || !(cmd.includes("run") || cmd.includes("attach"))) continue;
      const ppid = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1];
      if (readFileSync(`/proc/${ppid}/cmdline`, "utf8").includes("main.ts")) found.push(Number(pid));
    } catch {}
  }
  return found;
}

const stderr: string[] = [];
let reconnected = () => {};
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
function breakLink(how: "SIGKILL" | "SIGSTOP") {
  const pids = links();
  console.log(`${at()} BREAK ${how} ${pids.join(",") || "(no link found)"}`);
  for (const pid of pids) process.kill(pid, how);
}

const prompts = {
  bash: "Run this exact command with the Bash tool: `sleep 12; echo slept-well`. Then reply with only the word DONE.",
  freeze: "Run this exact command with the Bash tool: `sleep 12; echo slept-well`. Then reply with only the word DONE.",
  prompt: "Run this exact command with the Bash tool: `touch reconnect-proof.txt && echo touched`. Then reply with only the word DONE.",
};

let sessionId = "";
const q = query({
  prompt: prompts[scenario as keyof typeof prompts],
  options: {
    cwd,
    pathToClaudeCodeExecutable: exe,
    permissionMode: "default",
    strictMcpConfig: true,
    settingSources: ["project", "local"],
    canUseTool: async (name, input) => {
      console.log(`${at()} PERMISSION ${name} ${JSON.stringify(input).slice(0, 100)}`);
      if (scenario === "prompt") {
        breakLink("SIGKILL");
        await new Promise<void>((done) => (reconnected = done));
        console.log(`${at()} ANSWERING after the reconnect`);
      }
      return { behavior: "allow", updatedInput: input };
    },
    stderr: (data) => {
      for (const line of data.split("\n").filter(Boolean)) {
        stderr.push(line);
        if (line.includes("reconnected")) reconnected();
      }
    },
  },
});

for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "tool_use") {
        console.log(`${at()} TOOL ${b.name} ${JSON.stringify(b.input).slice(0, 100)}`);
        if (scenario === "bash") setTimeout(() => breakLink("SIGKILL"), 4_000);
        if (scenario === "freeze") setTimeout(() => breakLink("SIGSTOP"), 3_000);
      }
      if (b.type === "text") console.log(`${at()} TEXT ${b.text}`);
    }
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const b of m.message.content) if (b.type === "tool_result") console.log(`${at()} RESULT ${JSON.stringify(b.content).slice(0, 120)}`);
  }
  if (m.type === "result") console.log(`${at()} DONE ${m.subtype} turns=${m.num_turns}`);
}
console.log(`STDERR\n  ${stderr.join("\n  ")}`);

// The mirror against the host's own transcript.
const local = join(projectsDir(), projectKey(cwd), `${sessionId}.jsonl`);
const hostFolder = `.cc-remote/ws/${(await import("node:os")).hostname()}${cwd}`;
const remote = Bun.spawnSync([`${import.meta.dir}/fakessh`, "fakehost", `cd "$HOME"/'${hostFolder}' && cat "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')/${sessionId}.jsonl"`], { env: process.env });
const ids = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.uuid).map((e) => e.uuid as string);
const mine = existsSync(local) ? ids(readFileSync(local, "utf8")) : [];
const theirs = ids(remote.stdout.toString());
const same = mine.length === theirs.length && mine.every((u, i) => u === theirs[i]);
console.log(`TRANSCRIPT local=${mine.length} host=${theirs.length} unique-local=${new Set(mine).size} ${same ? "IDENTICAL" : "DIFFERENT"}`);
console.log(`SESSION ${sessionId} ${local}`);
await Bun.sleep(1_500);
console.log(`LEFT ${links().length} bridges`);
rmSync(dirname(exe), { recursive: true, force: true });
process.exit(0);
