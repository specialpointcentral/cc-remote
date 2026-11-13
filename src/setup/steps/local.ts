import { installDecision } from "../args";
import { runPlan } from "../actions/local";
import { localChecks } from "../checks/local";
import type { Ctx } from "../context";
import { installPlan, mergePlans } from "../os";
import { endStep, replaceCheck, show } from "../report";
import { t } from "../ui/i18n";

/**
 * Step 1, this machine. A missing tool gets its exact install command; at a terminal setup asks
 * `[y/N]` before running it, unattended it runs only with `--install` (`sudo -n`), and `--check`
 * only shows it.
 */
export async function stepLocal(ctx: Ctx): Promise<{ isSsh: boolean }> {
  const label = ctx.mode.check ? t("This machine", "本机") : t("Checking this machine", "检查本机");
  ctx.progress.begin(label);
  const local = await localChecks(ctx);
  const plans = mergePlans(local.missing.map((p) => installPlan(p, local.machine, !ctx.mode.interactive))).filter((p) => p.steps.length);
  const decision = installDecision(ctx.o, ctx.mode);
  if (decision === "skip" && !ctx.mode.check && plans.length) {
    // Unattended without --install: say so, with the command it would run.
    for (const c of local.checks) {
      const plan = plans.find((p) => c.pkg && p.pkgs.includes(c.pkg as never));
      if (!plan) continue;
      c.short = t(`${c.label} not found; not installing (add --install to run: ${plan.text})`, `${c.label} 未找到；不安装（加 --install 以运行：${plan.text}）`);
      c.remedy = [t(`not installing (add --install to run: ${plan.text})`, `不安装（加 --install 以运行：${plan.text}）`)];
    }
  }
  endStep(ctx, "local", local.checks, label);
  if (decision === "skip" || !plans.length) return { isSsh: local.isSsh };

  let installed = false;
  for (const plan of plans) {
    if (decision === "ask-no") {
      const sudo = plan.steps.some((s) => s[0] === "sudo");
      const ok = await ctx.prompt.yesNo(t(`Run \`${plan.text}\` now?${sudo ? " sudo may ask for your password." : ""}`, `现在运行 \`${plan.text}\` 吗？${sudo ? "sudo 可能会要求输入密码。" : ""}`), false);
      if (!ok) continue;
    }
    const ok = await runPlan(ctx, plan);
    ctx.record({ id: "local.install", value: plan.text, packages: plan.pkgs, ok });
    if (ok) installed = true;
    else ctx.progress.say(`        ${ctx.term.mark("fail")} ${t(`\`${plan.text}\` failed; nothing else was tried`, `\`${plan.text}\` 失败；没有再尝试别的`)}${ctx.mode.interactive ? "" : t(" (sudo -n can't ask for a password)", "（sudo -n 无法询问密码）")}`);
  }
  if (!installed) return { isSsh: local.isSsh };
  // Check again, and show what changed.
  const again = await localChecks(ctx);
  for (const c of again.checks) {
    const before = local.checks.find((b) => b.id === c.id);
    if (before && before.status !== "pass" && c.status === "pass") {
      if (c.id === "L3") c.detail += t(" (running cc-remote sessions pick it up when restarted)", "（正在运行的 cc-remote 会话重启后才会用上）");
      show(ctx, c);
      replaceCheck(ctx, "local", c.id, c);
    }
  }
  return { isSsh: again.isSsh };
}
