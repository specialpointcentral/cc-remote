import { hostname } from "node:os";
import { REFUSED } from "../../host-process";
import { REMOTE_PATH, rsh } from "../../ssh";
import { rememberVersion, versionNumber } from "../../version";
import { type Abort, type Facts, remoteChecks } from "../checks/remote";
import type { Ctx } from "../context";
import { markerName, parseProbe, type Probe, probeScript, sshError } from "../remote-probe";
import { endStep } from "../report";
import { t } from "../ui/i18n";

/**
 * Step 4, the central server: one probe round trip for the facts, then `claude --version` over
 * cc-remote's own ssh path (rsh(), the shared connection), the way sessions ask. The version is
 * remembered for sessions like doctor's answer, except under `--check`, which writes nothing.
 */
export type Central = { ok: boolean; probe?: Probe; abort?: Abort; facts?: Facts };

/**
 * The host's `claude --version` over the production path, as hostVersion() in src/ssh.ts asks it,
 * but with ssh's error output captured, to tell a refused shared session (sshd's MaxSessions) from
 * other failures. A refused session is asked again on a connection of its own, as sessions do.
 */
async function liveVersion(ctx: Ctx, host: string): Promise<{ version?: string; error?: string; refused: boolean }> {
  const ask = (shared: boolean) => ctx.run([...rsh(shared), "-T", host, `${REMOTE_PATH} claude --version`], { timeoutMs: 60_000 });
  let r = await ask(true);
  const refused = r.code === 255 && REFUSED.test(r.stderr);
  if (refused) r = await ask(false);
  // A chatty login shell may print before it: the version is the last line that looks like one.
  const version = r.stdout.trim().split(/\r?\n/).reverse().find((l) => versionNumber(l))?.trim();
  if (r.code !== 0 || !version) return { error: sshError(r.stderr) || r.stdout.trim().slice(0, 200) || t(`exit ${r.code}`, `退出码 ${r.code}`), refused };
  return { version, refused };
}

export async function stepCentral(ctx: Ctx, host: string, base: string[], machineId?: string): Promise<Central> {
  const label = ctx.mode.check ? host : t(`Checking ${host}`, `检查 ${host}`);
  ctx.progress.begin(label);
  const token = `cc-remote-setup-${crypto.randomUUID()}`;
  const machine = markerName(hostname()) ?? "unnamed";
  const r = await ctx.run([...base, host, "/bin/sh -s"], { input: probeScript(token, machine), timeoutMs: 120_000 });
  const probe = parseProbe(r.stdout, token);
  if (!probe) {
    const detail = t(`the probe didn't run: ${sshError(r.stderr) || `exit ${r.code}`}`, `探测脚本没有运行：${sshError(r.stderr) || `退出码 ${r.code}`}`);
    endStep(ctx, "central", [{ id: "R0", status: "fail", label: "probe", detail }], label, detail);
    return { ok: false };
  }
  const live = probe.kv.CLAUDE_NI ? await liveVersion(ctx, host) : { refused: false };
  if (live.version && !ctx.mode.check) rememberVersion(host, live.version);
  // One round trip on the shared connection the version probe opened.
  let rttMs: number | undefined;
  if (live.version && process.platform !== "win32") {
    const rtt = await ctx.run([...rsh(true), "-T", host, "true"], { timeoutMs: 30_000 });
    if (rtt.code === 0) rttMs = rtt.ms;
  }
  const facts: Facts = { host, probe, version: live.version, versionError: live.error, refused: live.refused, rttMs, machineId };
  const { checks, abort } = remoteChecks(facts);
  const shorts = checks.filter((c) => (c.id === "R8" || c.id === "R9") && c.status === "pass").map((c) => c.short ?? c.detail);
  // An abort shows every finding, whatever the details setting: the user has something to fix.
  const before = ctx.details;
  if (abort && !ctx.mode.check) ctx.details = true;
  endStep(ctx, "central", checks, label, shorts.join(", "));
  ctx.details = before;
  return { ok: !abort, probe, abort, facts };
}
