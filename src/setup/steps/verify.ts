import { MIN_CLAUDE, older, versionNumber } from "../../version";
import type { Check, Ctx, Env } from "../context";
import { processEnv, validateCommand } from "../orca";
import { endStep } from "../report";
import { t } from "../ui/i18n";
import { withoutAgent } from "./connect";
import { ENV_NAMES, type OrcaResult, proposedCommand } from "./orca";

/**
 * Step 7, end to end, as Orca runs it: exactly its Claude Command with `--version`, in the home
 * folder, in Orca Server's own environment (its process environment on Linux; elsewhere this
 * one without ssh-agent), with the version cache off so the answer comes live from the central
 * server. No chat is created. `--smoke` then sends one tiny real prompt, which costs tokens.
 */
export async function stepVerify(ctx: Ctx, orca: OrcaResult, skip?: string): Promise<boolean> {
  const label = ctx.mode.check ? t("End to end", "端到端") : t("Verifying as Orca runs it", "按 Orca 的方式验证");
  ctx.progress.begin(label);
  if (skip) {
    const detail = t(`skipped: ${skip}`, `已跳过：${skip}`);
    endStep(ctx, "verify", [{ id: "O6", status: "fail", label: "e2e", detail, short: detail }], label, detail);
    return false;
  }
  const proposal = proposedCommand(ctx);
  const ours = orca.command && proposal.value && orca.command.trim().split(/\s+/).join(" ") === proposal.value;
  // Orca's own command when it is this install's; otherwise this install's, noted below.
  const command = ours ? orca.command : proposal.value;
  const parsed = command ? validateCommand(command) : undefined;
  if (!command || !parsed || "error" in parsed) {
    const detail = proposal.note ?? t(`Orca's Claude Command isn't runnable: ${command ?? ""}`, `Orca 的 Claude Command 无法运行：${command ?? ""}`);
    endStep(ctx, "verify", [{ id: "O6", status: "warn", label: "e2e", detail }], label, detail);
    return true;
  }
  let env: Env = (orca.runtime && processEnv(orca.runtime.pid)) || ctx.env;
  // Orca's Claude environment holds what was copied from here; it never gives the values back.
  for (const name of ENV_NAMES) if (orca.envNames.includes(name) && ctx.env[name]) env = { ...env, [name]: ctx.env[name] };
  env = { ...withoutAgent(env), CC_REMOTE_NO_VERSION_CACHE: "1" };
  const cwd = env.HOME || ctx.home;
  const r = await ctx.run([parsed.program, ...parsed.prefixArgs, "--version"], { env, cwd, timeoutMs: 90_000 });
  const line = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  const version = versionNumber(line);
  const checks: Check[] = [];
  const notOrcas = orca.runtime && !ours ? t(" (Orca's Claude Command is not this one)", "（Orca 的 Claude Command 不是它）") : "";
  if (r.code === 0 && version && !older(version, MIN_CLAUDE)) {
    checks.push({ id: "O6", status: notOrcas ? "warn" : "pass", label: "e2e", detail: t(`${line}, live, without ssh-agent${notOrcas}`, `${line}，实时查询，不依赖 ssh-agent${notOrcas}`) });
  } else {
    const why = r.stderr.trim().split("\n").filter(Boolean).pop() ?? (line || t(`exit ${r.code}`, `退出码 ${r.code}`));
    checks.push({ id: "O6", status: "fail", label: "e2e", detail: t(`\`${command} --version\` failed: ${why}`, `\`${command} --version\` 失败：${why}`) });
  }
  if (ctx.o.smoke && checks[0]!.status !== "fail") {
    ctx.progress.freeze();
    const s = await ctx.run([parsed.program, ...parsed.prefixArgs, "-p", "Reply with exactly: OK"], { env, cwd, timeoutMs: 180_000 });
    const answer = s.stdout.trim();
    checks.push(s.code === 0 && /^OK\.?$/.test(answer)
      ? { id: "O7", status: "pass", label: "smoke", detail: t("one real prompt answered OK", "一次真实提问回答了 OK") }
      : { id: "O7", status: "fail", label: "smoke", detail: t(`the test prompt got: ${(answer || s.stderr.trim()).slice(0, 200)}`, `测试提问得到：${(answer || s.stderr.trim()).slice(0, 200)}`) });
  }
  const end = checks.map((c) => c.detail).join("; ");
  endStep(ctx, "verify", checks, label, end, !checks.some((c) => c.status === "fail"));
  return !checks.some((c) => c.status === "fail");
}
