// A minimal ACP v1 client for end-to-end runs. It starts cc-remote with test/e2e/fakessh as its
// ssh, runs the given ACP requests in order, approves every permission request (always-allow when
// ALWAYS is set), and prints tool calls, permission prompts and the agent's text.
//
//   bun test/e2e/client.ts <cwd> '[{"method":"session/new","params":{"cwd":"$CWD","mcpServers":[]}},
//     {"method":"session/prompt","params":{"sessionId":"$SESSION","prompt":[{"type":"text","text":"Read a.txt"}]}}]'
//
// AGENT runs a built binary instead of src/main.ts. Needs a logged-in claude on this machine.
// FAKE_HOST_ISOLATED=1 runs the host as a second machine whose own files (its plans, transcripts,
// spilled tool results, temp folder) this side can't see; see test/e2e/fakessh, and end it with
// `test/e2e/fakessh --stop`. A plan mode run, which shows the plan the approval carries:
//
//   FAKE_HOST_ISOLATED=1 bun test/e2e/client.ts <cwd> '[{"method":"session/new","params":{"cwd":"$CWD","mcpServers":[]}},
//     {"method":"session/set_mode","params":{"sessionId":"$SESSION","modeId":"plan"}},
//     {"method":"session/prompt","params":{"sessionId":"$SESSION","prompt":[{"type":"text","text":"Plan ..., then call ExitPlanMode"}]}}]'
//
// Point XDG_CACHE_HOME at a scratch folder to keep the run's caches (version, auth status, session
// approvals) out of ~/.cache/cc-remote.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [cwd, ...rest] = process.argv.slice(2);
const steps: { method: string; params: any }[] = JSON.parse(rest.join(" "));
const root = `${import.meta.dir}/../..`;
const agent = process.env.AGENT ? [process.env.AGENT] : ["bun", `${root}/src/main.ts`];
const child = spawn(agent[0]!, [...agent.slice(1), "--host", "fakehost"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CC_REMOTE_SSH: `${import.meta.dir}/fakessh`, REAL_HOME: process.env.REAL_HOME ?? process.env.HOME },
});
let id = 0;
const pending = new Map<number, (r: any) => void>();
const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const call = (method: string, params: any) => new Promise<any>((done) => { const i = ++id; pending.set(i, done); send({ id: i, method, params }); });
createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) return pending.get(m.id)?.(m);
  if (m.method === "session/request_permission") {
    const opt = m.params.options.find((o: any) => o.kind === (process.env.ALWAYS ? "allow_always" : "allow_once")) ?? m.params.options[0];
    console.log(`PERMISSION ${m.params.toolCall?.title} -> ${opt.optionId} of ${JSON.stringify(m.params.options.map((o: any) => o.kind + ":" + o.optionId))}`);
    // What the user would read before answering, such as the plan of an ExitPlanMode.
    const shown = (m.params.toolCall?.content ?? []).map((c: any) => c.content?.text ?? "").join("").trim();
    if (shown) console.log(`  SHOWN ${JSON.stringify(shown.slice(0, 300))}`);
    if (m.params.toolCall?.rawInput?.planFilePath !== undefined) console.log(`  PLAN_INPUT ${JSON.stringify(m.params.toolCall.rawInput.planFilePath)} ${JSON.stringify(m.params.toolCall.rawInput.plan ?? null).slice(0, 200)}`);
    return send({ id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
  }
  if (m.method === "session/update") {
    const u = m.params.update;
    if (u.sessionUpdate === "tool_call") console.log(`TOOL_CALL ${u.title} kind=${u.kind}${u.content?.some((c: any) => c.type === "diff") ? " +diff" : ""}`);
    else if (u.sessionUpdate === "tool_call_update" && u.content?.some((c: any) => c.type === "diff")) console.log(`TOOL_DIFF ${u.toolCallId.slice(-6)} ${JSON.stringify(u.content.find((c: any) => c.type === "diff")).slice(0, 160)}`);
    else if (u.sessionUpdate === "tool_call_update" && u.status) console.log(`TOOL_UPDATE ${u.toolCallId.slice(-6)} ${u.status}${u.content?.some((c: any) => c.type === "diff") ? " +diff" : ""}`);
    else if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content.text ?? "");
    return;
  }
  if (m.id !== undefined && m.method) return send({ id: m.id, error: { code: -32601, message: "unsupported" } });
});

const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("INIT", init.result?.agentInfo?.name, init.error ?? "");
let sessionId = "";
for (const step of steps) {
  const params = JSON.parse(JSON.stringify(step.params).replaceAll("$SESSION", sessionId).replaceAll("$CWD", cwd!));
  const r = await call(step.method, params);
  if (r.result?.sessionId) sessionId = r.result.sessionId;
  console.log(`\n== ${step.method}`, JSON.stringify(r.error ?? r.result).slice(0, 400));
}
child.stdin.end();
child.kill("SIGTERM");
process.exit(0);
