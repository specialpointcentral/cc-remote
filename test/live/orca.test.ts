/**
 * Live checks of `cc-remote claude` under a real Orca Server, opt in: set CC_REMOTE_LIVE_ORCA to
 * an Orca CLI that can serve (scripts/verify-orca.sh builds one from an orcad bundle with
 * test/live/orca-bundle.ts and runs this file). The default `bun test` skips it.
 *
 *   CC_REMOTE_LIVE_ORCA         the Orca build to verify (a CLI from orca-bundle.ts)
 *   CC_REMOTE_LIVE_ORCA_BEFORE  optional previous build: the chat starts there and the server is
 *                               restarted into the new one, as the desktop's automatic update does
 *   CC_REMOTE_LIVE_MODEL        Claude model for the chats (default haiku, the cheapest)
 *   CC_REMOTE_LIVE_HOST         a real central server instead of test/e2e/fakessh (never in CI)
 *   CC_REMOTE_LIVE_WORK / _STATE  the run's folders (verify-orca.sh makes them; else made here)
 *   CC_REMOTE_LIVE_REPORT       where to write the results as JSON
 *
 * orcad runs on a throwaway HOME and profile under a fresh /tmp folder, binds 127.0.0.1 on a free
 * port, and its Claude Command is a wrapper that records each launch and runs this checkout's
 * cc-remote. The "central server" is test/e2e/fakessh with FAKE_HOST_ISOLATED=1: the host side
 * runs on this machine in a mount namespace of its own, with this machine's Claude login, and
 * can't see the local project folder. Each chat message is a real, small claude turn: four with a
 * previous build, three without, plus Orca's own chat-title call (on the model Orca picks, Sonnet
 * at low effort in 1.4.254). One orcad at a time; free memory is checked before each start and
 * watched throughout; every process of the run is stopped at the end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { forwardedEnv } from "../../src/claude";
import { hostDir } from "../../src/ssh";
import {
  ABORT_MB, MIN_START_MB, OrcaRpc, OrcaServer, availableMb, fingerprint, freePort, launches, marked,
  operationId, stopFakeHost, stopMarked, waitFor, writeClaudeCommand,
} from "./orca-live";

// Empty counts as unset: verify-orca.sh passes every variable, empty when it has no value.
const NEW = Bun.env.CC_REMOTE_LIVE_ORCA || undefined;
const BEFORE = Bun.env.CC_REMOTE_LIVE_ORCA_BEFORE || undefined;
const MODEL = Bun.env.CC_REMOTE_LIVE_MODEL || "haiku";
const HOST = Bun.env.CC_REMOTE_LIVE_HOST || undefined;

/**
 * Every flag Orca 1.4.251 and 1.4.254 were seen to give their Claude Command, with what cc-remote
 * does with it (src/args.ts hostLaunch, src/claude.ts). A flag missing here fails the run: review
 * how cc-remote must handle it (a local path the host can't see, say), then add it.
 */
export const REVIEWED: Record<string, string> = {
  "--output-format": "passed to the host's claude",
  "--input-format": "passed; stream-json means an SDK on the other end: local tools, transcript mirror",
  "--verbose": "passed",
  "--model": "passed",
  "--permission-prompt-tool": "passed; stdio sends prompts back over the stream, to Orca",
  "--setting-sources": "passed",
  "--permission-mode": "passed, and read for the local tools' policy",
  "--dangerously-skip-permissions": "passed, and read as bypassPermissions (Orca's full-access)",
  "--include-partial-messages": "passed",
  "--replay-user-messages": "passed",
  "--thinking-display": "passed",
  "--add-dir": "kept off the host's command line: local folders, named in the prompt, for the local tools",
  "--plugin-dir": "copied to the host under ~/.cc-remote/plugins, path rewritten",
  "--settings": "passed; a file path would be inlined, JSON goes as is",
  "--session-id": "passed; also names the session's grants",
  "--resume": "passed; a transcript the host lacks is uploaded first",
  "--resume-session-at": "passed (forks)",
  "--fork-session": "passed (forks); grants start empty",
  "--strict-mcp-config": "passed; the local Claude config's MCP servers aren't added",
  "--tools": "passed (one-off -p)",
  "--effort": "passed (Orca's chat titles ask for --effort low); claude 2.1.268 and later take it",
  "--allowedTools": "merged into one flag with cc-remote's read-only tools",
  "--disallowedTools": "merged into one flag with the host tools cc-remote replaces",
  "-p": "a one-off: claude runs on the host with no tools of its own, unless stream-json input",
};

/** The flags in a command line, without their values. */
export const flagsOf = (args: string[]) => [...new Set(args.filter((a) => /^--?[A-Za-z]/.test(a)).map((a) => a.split("=")[0]!))];

type Result = { check: string; status: "pass" | "fail" | "not possible"; detail: string };
const results: Result[] = [];
const record = (check: string, status: Result["status"], detail: string) => {
  results.push({ check, status, detail });
  console.log(`[live] ${status.toUpperCase()} ${check}: ${detail}`);
};

// Skipped without a build to check, before anything (a temporary folder, say) is made.
if (!NEW) test.skip("cc-remote as Orca's Claude Command, live: set CC_REMOTE_LIVE_ORCA (scripts/verify-orca.sh)", () => {});
else describe("cc-remote as Orca's Claude Command, live", () => {
  const realHome = userInfo().homedir;
  const own = !Bun.env.CC_REMOTE_LIVE_WORK;
  const work = Bun.env.CC_REMOTE_LIVE_WORK || mkdtempSync("/tmp/ccro-live.");
  const token = work.split("/").pop()!;
  const state = Bun.env.CC_REMOTE_LIVE_STATE || (HOST ? join(work, "no-host-state") : mkdtempSync(join(realHome, ".cache", "ccro-host.")));
  const home = join(work, "h");
  const profile = join(home, "p");
  const project = join(work, "proj");
  const log = join(work, "launches.jsonl");
  const pages = join(work, "pages");
  const word = `marigold${Math.floor(1000 + Math.random() * 9000)}`;
  const secret = `local-only-${crypto.randomUUID().slice(0, 8)}`;
  const rpc = new OrcaRpc(profile);
  let server: OrcaServer | undefined;
  let port = 0;
  let worktree = "";
  let chat = "";
  let providerSession = "";
  let firstStatus: any;
  let firstVersion = "";
  let turns = 0;
  let t1: Turn | undefined;
  let watchdog: Timer | undefined;
  let pageNo = 0;

  // orcad's PATH: this one without the folders holding claude or codex, so the project machine has
  // no claude of its own (cc-remote's whole point) and Orca starts no codex app-server.
  const path = (Bun.env.PATH ?? "/usr/bin:/bin").split(":").filter((d) => d && !["claude", "codex"].some((x) => existsSync(join(d, x)))).join(":");
  const env = {
    HOME: home, PATH: path, LANG: "en_US.UTF-8", TMPDIR: home, SHELL: Bun.env.SHELL || "/bin/bash",
    ORCA_USER_DATA_PATH: profile, ORCA_SERVE_RUNTIME: "electron", CC_REMOTE_LIVE_TOKEN: token,
  };
  const hostEnv = { ...process.env, CC_REMOTE_LIVE_TOKEN: token, REAL_HOME: realHome, FAKE_HOST_ISOLATED: "1", FAKE_HOST_STATE: state };

  async function cleanup() {
    if (watchdog) clearInterval(watchdog);
    await server?.stop().catch(() => {});
    const stopped = await stopMarked(token);
    if (!HOST) stopFakeHost(state);
    const left = marked(token);
    return { stopped, left };
  }

  /** Below ABORT_MB available, everything of the run stops at once and the run ends. */
  function watchMemory() {
    watchdog = setInterval(() => {
      const mb = availableMb();
      if (mb >= ABORT_MB) return;
      console.error(`[live] ABORT: only ${mb} MB available (< ${ABORT_MB}); stopping every process of this run`);
      clearInterval(watchdog);
      for (const p of marked(token)) try { process.kill(p.pid, "SIGKILL"); } catch {}
      if (!HOST) stopFakeHost(state);
      record("memory", "fail", `aborted: ${mb} MB available`);
      if (Bun.env.CC_REMOTE_LIVE_REPORT) writeFileSync(Bun.env.CC_REMOTE_LIVE_REPORT, JSON.stringify({ results, turns, aborted: true }, null, 2));
      process.exit(3);
    }, 3_000);
  }

  async function memoryForTurn() {
    await waitFor(`${MIN_START_MB} MB available for a claude turn`, 60, () => availableMb() >= MIN_START_MB, () => `(${availableMb()} MB)`);
  }

  async function serve(cli: string, name: string) {
    server = new OrcaServer({ cli, port, env, log: join(work, `orca-${name}.log`), cwd: home });
    return server.start(rpc);
  }

  async function page(sessionId: string, limit = 80) {
    return (await rpc.call("agentSession.history", { sessionId, direction: "tail", limit }, 20_000)).page;
  }

  async function envelope(sessionId: string, method: string, fields: unknown) {
    const fence = (await page(sessionId, 1)).fence;
    return { sessionId, clientOperationId: operationId(), expectedRuntimeFence: fence, payloadFingerprint: fingerprint(method, sessionId, fields) };
  }

  async function createChat(fields: Record<string, unknown>): Promise<string> {
    const sessionId = `claude_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = await rpc.call("agentSession.create", {
      envelope: { sessionId, clientOperationId: operationId(), expectedRuntimeFence: null, payloadFingerprint: fingerprint("agentSession.create", sessionId, fields) },
      ...fields,
    }, 60_000);
    if (!created?.ok) throw new Error(`agentSession.create refused: ${JSON.stringify(created).slice(0, 500)}`);
    return sessionId;
  }

  type Turn = { reply: string; approvals: any[]; tools: string[]; items: any[]; lastAssistantItem?: string };

  const bodyText = (body: any): string => {
    if (!body || typeof body !== "object") return "";
    if (typeof body.text === "string") return body.text;
    const blocks = Array.isArray(body.blocks) ? body.blocks : Array.isArray(body.content) ? body.content : [];
    return blocks.map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("");
  };
  const isAssistant = (item: any) => item?.body?.kind === "message" && item.body.role === "assistant";
  const pending = (items: any[]) => items.filter((i) => i?.body?.kind === "approval" && i.body.resolution?.state === "pending");

  /**
   * Sends one message and follows the turn to its end, answering each permission prompt with
   * Orca's "Allow". Every history page is kept in the run folder.
   */
  async function turn(sessionId: string, text: string, seconds = 180): Promise<Turn> {
    await memoryForTurn();
    const before = await page(sessionId);
    const seen = new Set((before.items ?? []).map((i: any) => i.itemId));
    const body = { kind: "message", role: "user", blocks: [{ type: "text", text }] };
    // A restarted server may still be restoring the chat: retry the send for a while.
    await waitFor("Orca to take the message", 60, async () => {
      try {
        const sent = await rpc.call("agentSession.send", { envelope: await envelope(sessionId, "agentSession.send", { body }), body }, 30_000);
        return sent?.ok === true;
      } catch (e) {
        console.log(`[live] send not taken yet: ${(e as Error).message}`);
        return false;
      }
    });
    turns++;
    const approvals: any[] = [];
    let last: any;
    await waitFor("the turn to finish", seconds, async () => {
      last = await page(sessionId);
      mkdirSync(pages, { recursive: true });
      writeFileSync(join(pages, `${String(++pageNo).padStart(3, "0")}-${sessionId.slice(-6)}.json`), JSON.stringify(last, null, 1));
      for (const prompt of pending(last.items ?? [])) {
        const option = (prompt.body.options ?? []).find((o: any) => /^allow( once)?$/i.test(o.label ?? "")) ?? (prompt.body.options ?? []).find((o: any) => /^allow/i.test(o.label ?? "") && !/always|session/i.test(o.label));
        if (!option) throw new Error(`no Allow option in ${JSON.stringify(prompt.body).slice(0, 600)}`);
        const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: option.id };
        const answered = await rpc.call("agentSession.respondToApproval", { envelope: await envelope(sessionId, "agentSession.respondTo:approval", fields), ...fields }, 30_000);
        approvals.push({ title: prompt.body.title, toolName: prompt.body.toolName ?? prompt.body.tool?.name, options: (prompt.body.options ?? []).map((o: any) => o.label), chose: option.label, ok: answered?.ok, body: prompt.body });
        console.log(`[live] answered a permission prompt "${prompt.body.title ?? ""}" with ${option.label}: ${JSON.stringify(answered).slice(0, 200)}`);
      }
      const fresh = (last.items ?? []).filter((i: any) => !seen.has(i.itemId));
      return !last.working && pending(last.items ?? []).length === 0 && fresh.some(isAssistant);
    }, () => JSON.stringify(last ?? {}).slice(-3000));
    const items = (last.items ?? []).filter((i: any) => !seen.has(i.itemId));
    const assistant = items.filter(isAssistant);
    const tools = items.map((i: any) => i.body?.toolName ?? i.body?.tool?.name ?? i.body?.name).filter((n: unknown): n is string => typeof n === "string");
    return { reply: assistant.map((i: any) => bodyText(i.body)).join("\n"), approvals, tools, items, lastAssistantItem: assistant.at(-1)?.itemId };
  }

  /** Runs a shell script on the central server, the way cc-remote reaches it. */
  function onHost(script: string): string {
    const command = HOST ? ["ssh", "-o", "BatchMode=yes", HOST, script] : [join(work, "fakessh"), "fakehost", script];
    const run = Bun.spawnSync(command, { env: hostEnv, timeout: 30_000 });
    return run.stdout.toString() + run.stderr.toString();
  }

  /** Where a local path is on the host: nowhere, at the same path, or in cc-remote's folder for the project. */
  function hostSees(path: string): string[] {
    const mapped = `"$HOME"/'${hostDir(project)}'${path.slice(project.length)}`;
    const out = onHost(`test -d "$HOME"/'${hostDir(project)}' && echo WS; test -e '${path}' && echo SAME; test -e ${mapped} && echo MAPPED; true`);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  const chatLaunches = () => launches(log).filter((l) => l.cwd === project && l.args.includes("--input-format"));

  beforeAll(async () => {
    if (realHome === home || !home.startsWith("/tmp/")) throw new Error(`refusing to run Orca on ${home}: not a throwaway home`);
    for (const live of [profile, project]) mkdirSync(live, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, "local-only.txt"), `${secret}\n`);
    writeClaudeCommand({ work, token, log, state, cache: join(work, "cache"), realHome, host: HOST });
    port = await freePort();
    watchMemory();
    process.once("SIGTERM", async () => { await cleanup(); process.exit(143); });
    process.once("SIGINT", async () => { await cleanup(); process.exit(130); });
    firstStatus = await serve(BEFORE ?? NEW!, "first");
    firstVersion = firstStatus.appVersion;
    console.log(`[live] Orca Server ${firstVersion} on 127.0.0.1:${port}, profile ${profile}; ${availableMb()} MB available`);
    const set = await rpc.call("settings.mutateAgentLaunch", { type: "command", agent: "claude", value: join(work, "claude-cmd") });
    expect(set.settings.agentCmdOverrides.claude).toBe(join(work, "claude-cmd"));
    const group = await rpc.call("projectGroup.create", { name: "cc-remote live", parentPath: work });
    const folder = await rpc.call("folderWorkspace.create", { projectGroupId: group.group.id, name: "proj", folderPath: project });
    worktree = `id:folder:${folder.folderWorkspace.id}`;
  }, 180_000);

  afterAll(async () => {
    for (const id of [chat].filter(Boolean)) await rpc.call("agentSession.close", { sessionId: id }, 20_000).catch(() => {});
    const { stopped, left } = await cleanup();
    if (stopped.length) console.log(`[live] stopped at the end:\n  ${stopped.join("\n  ")}`);
    record("cleanup", left.length ? "fail" : "pass", left.length ? `still running: ${left.map((p) => p.cmd).join("; ")}` : `nothing of this run is left (${stopped.length} stopped at the end)`);
    // Each message is a turn, and so is each one-off -p (Orca's chat titles, on the model Orca picks).
    const titles = launches(log).filter((l) => l.args.includes("-p") && !l.args.includes("--input-format")).length;
    const report = { orca: { first: firstVersion, new: NEW, before: BEFORE }, model: MODEL, turns: turns + titles, messages: turns, titles, results, launches: launches(log), work };
    if (Bun.env.CC_REMOTE_LIVE_REPORT) writeFileSync(Bun.env.CC_REMOTE_LIVE_REPORT, JSON.stringify(report, null, 2));
    if (own && !results.some((r) => r.status === "fail")) rmSync(work, { recursive: true, force: true });
    if (own && !HOST) rmSync(state, { recursive: true, force: true });
  }, 60_000);

  test("Orca starts a native Claude chat through cc-remote", async () => {
    chat = await createChat({ agent: "claude", worktree, options: { permissionMode: "ask", model: MODEL } });
    const launch = await waitFor("Orca to launch the Claude Command for the chat", 60, () => chatLaunches()[0], () => readFileSync(log, "utf8").slice(-2000));
    providerSession = launch.args.find((a) => a.startsWith("--session-id="))?.split("=")[1] ?? launch.args[launch.args.indexOf("--session-id") + 1] ?? "";
    expect(providerSession).toMatch(/^[0-9a-f-]{36}$/);
    expect(launch.orcaAppVersion).toBe(firstVersion);
    record("launch", "pass", `Orca ${firstVersion} ran the Claude Command in the chat's folder: ${launch.args.join(" ").slice(0, 400)}`);
  }, 120_000);

  test("a turn runs Bash and Read on this machine, after Orca answers Bash's permission prompt", async () => {
    expect(chat).not.toBe("");
    t1 = await turn(chat, `This is a test of local tools. Remember the code word ${word} for later. Do exactly these two steps:
1. Use the Bash tool to run: printf 'bash-ran\\n' > bash-proof.txt
2. Use the Read tool to read local-only.txt
Then reply with only the text you read from local-only.txt.`);
    console.log(`[live] T1 reply: ${t1.reply.slice(0, 300)}; tools: ${t1.tools.join(", ")}`);
    const proof = join(project, "bash-proof.txt");
    const sees = hostSees(proof);
    const local = existsSync(proof) ? readFileSync(proof, "utf8") : "(missing)";
    const ok = local === "bash-ran\n" && sees.includes("WS") && !sees.includes("SAME") && !sees.includes("MAPPED") && t1.reply.includes(secret);
    record("local tools", ok ? "pass" : "fail", `bash-proof.txt locally: ${JSON.stringify(local)}; on the host: ${sees.filter((s) => s !== "WS").join(",") || "absent"} (host project folder ${sees.includes("WS") ? "exists" : "MISSING"}); reply ${t1.reply.includes(secret) ? "has" : "LACKS"} the local-only file's text; tools seen: ${t1.tools.join(", ") || "?"}`);
    expect(local).toBe("bash-ran\n");
    expect(sees).toContain("WS");
    expect(sees).not.toContain("SAME");
    expect(sees).not.toContain("MAPPED");
    expect(t1.reply).toContain(secret);
  }, 240_000);

  test("the permission prompt reached Orca (mode ask) and its answer let the command run", () => {
    expect(t1).toBeDefined();
    const bash = t1!.approvals.filter((a) => JSON.stringify(a.body).includes("bash-proof"));
    record("permission prompt", bash.length && bash.every((a) => a.ok) ? "pass" : "fail",
      bash.length ? `Orca showed ${JSON.stringify(bash[0].title)} with options ${bash[0].options.join(" / ")}; answered "${bash[0].chose}", and the command ran` : `no prompt for the Bash command reached Orca (${t1!.approvals.length} prompts in all)`);
    expect(bash.length).toBeGreaterThan(0);
    expect(bash.every((a) => a.ok)).toBe(true);
  });

  test("Orca's chat-title one-off (claude -p) runs through cc-remote", async () => {
    const title = await waitFor("Orca's title call", 60, () => launches(log).find((l) => l.args.includes("-p") && !l.args.includes("--input-format") && l.exit !== undefined)).catch(() => undefined);
    if (!title) {
      record("chat title", "not possible", `Orca made no one-off \`claude -p\` call within a minute of the first turn; launches: ${launches(log).map((l) => l.args.slice(0, 3).join(" ")).join(" | ")}`);
      return;
    }
    const exit = title.exit!;
    const out = (title.output ?? "").trim();
    record("chat title", exit === 0 && out ? "pass" : "fail", `\`${title.args.join(" ").slice(0, 200)}\` exited ${exit}, output ${JSON.stringify(out.slice(0, 120))}`);
    expect(exit).toBe(0);
    expect(out).not.toBe("");
  }, 90_000);

  /** The host's claude processes for the chat's session (argv[0] claude, the session id in its arguments). */
  const hostClaudes = () => marked(token).filter((p) => p.argv[0]?.split("/").pop() === "claude" && p.argv.some((a) => a.includes(providerSession)));

  async function restartInto(cli: string, label: string, file: string) {
    expect(chat).not.toBe("");
    const stoppedAt = Date.now();
    const before = hostClaudes().length;
    const stop = await server!.stop();
    const lingering = hostClaudes().length;
    console.log(`[live] orcad stopped in ${stop.seconds}s; still running from it: ${stop.left.join("; ") || "nothing"}; host claudes for the chat: ${before} before, ${lingering} after`);
    const second = await serve(cli, label);
    expect(second.runtimeId).not.toBe(firstStatus.runtimeId);
    firstStatus = second;
    const t = await turn(chat, `What is the code word I asked you to remember? Then use the Bash tool to run: printf '${label}\\n' > ${file}
Reply with only the code word.`);
    console.log(`[live] after ${label}: ${t.reply.slice(0, 200)}`);
    const resumed = chatLaunches().find((l) => l.at > stoppedAt);
    const local = existsSync(join(project, file)) ? readFileSync(join(project, file), "utf8") : "(missing)";
    const after = hostClaudes().length;
    const note = `orcad took ${stop.seconds}s to stop${stop.left.length ? ` and left ${stop.left.length} process(es) running` : ""}; host claudes for the chat: ${before} before the stop, ${lingering} after it, ${after} after the next turn`;
    return { version: second.appVersion as string, reply: t.reply, resumed, local, note, after };
  }

  test.skipIf(!BEFORE)("the chat carries on after the server updates to the new build", async () => {
    const r = await restartInto(NEW!, "update", "after-update.txt");
    const ok = r.reply.includes(word) && r.local === "update\n" && r.after <= 1;
    record("update", ok ? "pass" : "fail", `${firstVersion} -> ${r.version}: reply ${r.reply.includes(word) ? "recalls" : "does NOT recall"} the code word (${JSON.stringify(r.reply.slice(0, 80))}); Bash after the update wrote ${JSON.stringify(r.local)}; ${r.resumed ? `relaunched by ${r.resumed.orcaAppVersion} with ${r.resumed.args.filter((a) => /resume|session-id/.test(a) || a === providerSession).join(" ")}` : "no relaunch: the running claude was kept"}; ${r.note}`);
    expect(r.reply).toContain(word);
    expect(r.local).toBe("update\n");
    expect(r.after).toBeLessThanOrEqual(1);
  }, 300_000);

  test("the chat carries on after the server restarts on the same profile", async () => {
    const r = await restartInto(NEW!, "restart", "after-restart.txt");
    const ok = r.reply.includes(word) && r.local === "restart\n" && r.after <= 1;
    record("restart", ok ? "pass" : "fail", `${r.version} -> ${r.version}: reply ${r.reply.includes(word) ? "recalls" : "does NOT recall"} the code word (${JSON.stringify(r.reply.slice(0, 80))}); Bash after the restart wrote ${JSON.stringify(r.local)}; ${r.resumed ? `relaunched by ${r.resumed.orcaAppVersion} with ${r.resumed.args.filter((a) => /resume|session-id/.test(a) || a === providerSession).join(" ")}` : "no relaunch: the running claude was kept"}; ${r.note}`);
    expect(r.reply).toContain(word);
    expect(r.local).toBe("restart\n");
    expect(r.after).toBeLessThanOrEqual(1);
  }, 300_000);

  test("a fork of the chat (agentSession.create forkFrom) continues the conversation", async () => {
    expect(t1?.lastAssistantItem).toBeDefined();
    const startedAt = Date.now();
    const fork = await createChat({ agent: "claude", worktree, forkFrom: { sessionId: chat, throughItemId: t1!.lastAssistantItem } });
    const t = await turn(fork, "What is the code word I asked you to remember? Reply with only the code word.");
    // However Orca forks (--fork-session, or a transcript it copied and resumes), it's a new launch.
    const launch = chatLaunches().find((l) => l.at > startedAt);
    await rpc.call("agentSession.close", { sessionId: fork }, 20_000).catch(() => {});
    const ok = t.reply.includes(word) && !!launch;
    record("fork", ok ? "pass" : "fail", `fork reply ${t.reply.includes(word) ? "recalls" : "does NOT recall"} the code word (${JSON.stringify(t.reply.slice(0, 80))}); launch ${launch ? launch.args.filter((a) => /resume|fork|session-id/.test(a)).join(" ") : "MISSING"}`);
    expect(t.reply).toContain(word);
    expect(launch).toBeDefined();
  }, 300_000);

  test("every flag Orca passed is one cc-remote has reviewed", () => {
    const all = launches(log);
    const byVersion = new Map<string, Set<string>>();
    for (const l of all) {
      const set = byVersion.get(l.orcaAppVersion ?? "?") ?? new Set();
      for (const f of flagsOf(l.args)) set.add(f);
      byVersion.set(l.orcaAppVersion ?? "?", set);
    }
    const unknown = [...new Set(all.flatMap((l) => flagsOf(l.args)))].filter((f) => !(f in REVIEWED) && f !== "--version");
    const lines = [...byVersion].map(([v, set]) => `${v}: ${[...set].sort().join(" ")}`);
    const forwarded = [...new Set(all.flatMap((l) => Object.keys(forwardedEnv(Object.fromEntries(l.env.map((n) => [n, "x"]))))))].sort();
    record("flags", unknown.length ? "fail" : "pass", `${unknown.length ? `NOT REVIEWED: ${unknown.join(" ")}; ` : ""}${lines.join("; ")}. Environment forwarded to the host: ${forwarded.join(" ") || "none"}`);
    expect(unknown).toEqual([]);
  });
});
