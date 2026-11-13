import pkg from "../../package.json";
import { updateNotice } from "../update/notice";
import { sshdAdvice } from "./checks/remote";
import type { Check, Ctx } from "./context";
import { lang, t } from "./ui/i18n";
import { type Status, worst } from "./ui/term";

/**
 * How findings are shown: under their step, one line each (`✓ ssh  OpenSSH_9.2p1`) with what fixes
 * them below; on a re-run passing details collapse into the step's line unless `-v`. Then the
 * summary: counts, the warnings left with their fixes, what was saved, and what to do next.
 */

/** Columns a string takes on a terminal: CJK characters take two. */
export function width(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - width(s)));

/** A finding's lines under its step. */
export function checkLines(ctx: Ctx, c: Check, remedies = true): string[] {
  const lines = [`        ${ctx.term.mark(c.status)} ${pad(c.label, 13)}${c.detail}`];
  const indent = " ".repeat(8 + (ctx.term.unicode ? 1 : 4) + 1 + 13);
  if (remedies) for (const r of c.remedy ?? []) lines.push(...r.split("\n").map((l) => indent + l));
  return lines;
}

export function show(ctx: Ctx, c: Check, remedies = true) {
  for (const line of checkLines(ctx, c, remedies)) ctx.progress.say(line);
}

/**
 * Ends a step with its findings. With details, every finding gets its line after the step's;
 * collapsed, the step's line says what passed (or what didn't) and only failures get lines.
 */
export function endStep(ctx: Ctx, key: string, checks: Check[], label: string, summary?: string, collapse = false): Status {
  ctx.results.set(key, checks);
  const status = worst(checks.map((c) => c.status));
  if (ctx.details && !collapse) {
    ctx.progress.end(status, summary, label);
    for (const c of checks) if (c.detail !== summary && (c.status !== "info" || ctx.o.verbose || !ctx.mode.check)) show(ctx, c);
    return status;
  }
  const bad = checks.filter((c) => c.status === "warn" || c.status === "fail");
  const shown = bad.map((c) => `${c.status === "warn" ? `${ctx.term.mark("warn")} ` : ""}${c.short ?? `${c.label} ${c.detail}`}${c.status === "warn" && ctx.mode.check && c.pkg && c.remedy?.[0] ? ` (${t("hint", "提示")}: ${c.remedy[0].replace(/^(Install|安装): /, "")}; ${t("--check installs nothing", "--check 不安装任何东西")})` : ""}`);
  // A step's own summary of what passed leads its warnings; a failure is the news on its own.
  const text = bad.length
    ? [...(summary && status !== "fail" ? [summary] : []), ...shown].join("; ")
    : summary ?? checks.filter((c) => c.status === "pass").map((c) => c.label).join(", ");
  ctx.progress.end(status, text, label);
  for (const c of bad) if (c.status === "fail") for (const r of c.remedy ?? []) ctx.progress.say(`        ${r}`);
  return status;
}

/** Updates one finding of a step after a fix, keeping the others. */
export function replaceCheck(ctx: Ctx, key: string, id: string, next: Check) {
  const list = ctx.results.get(key) ?? [];
  const i = list.findIndex((c) => c.id === id);
  if (i >= 0) list[i] = next;
  else list.push(next);
  ctx.results.set(key, list);
}

export type Counts = { passed: number; warnings: number; failed: number };

export function counts(ctx: Ctx): Counts {
  const all = [...ctx.results.values()].flat();
  return { passed: all.filter((c) => c.status === "pass").length, warnings: all.filter((c) => c.status === "warn").length, failed: all.filter((c) => c.status === "fail").length };
}

/** The summary at the end of a run. */
export function summary(ctx: Ctx, host: string | undefined, facts: { distro?: string; os?: string }) {
  const c = counts(ctx);
  const all = [...ctx.results.entries()].flatMap(([step, list]) => list.map((check) => ({ step, check })));
  const left = all.filter(({ check }) => check.status === "warn" || check.status === "fail");
  const where = (step: string) => (step === "central" || step === "connect") && host ? `${host} ` : step === "orca" ? "Orca " : "";
  ctx.progress.say();
  if (ctx.details || (c.failed && !ctx.mode.check)) {
    ctx.term.line(`${ctx.term.paint("bold", t("── Summary", "── 汇总"))}   ${ctx.term.mark("pass")} ${t(`${c.passed} passed`, `${c.passed} 项通过`)}   ${ctx.term.mark("warn")} ${t(`${c.warnings} warning${c.warnings === 1 ? "" : "s"}`, `${c.warnings} 项警告`)}   ${ctx.term.mark("fail")} ${t(`${c.failed} failed`, `${c.failed} 项失败`)}`);
    const sshd = left.filter(({ check }) => check.id === "R13");
    for (const { step, check } of left) {
      if (check.id === "R13") continue;
      ctx.term.line(`  ${ctx.term.mark(check.status)} ${where(step)}${check.label}: ${check.detail}`);
      for (const r of check.remedy ?? []) for (const line of r.split("\n")) ctx.term.line(`      ${line}`);
    }
    if (sshd.length && host) {
      ctx.term.line(`  ${ctx.term.mark("warn")} ${t(`${host} sshd: send this to ${host}'s admin (cc-remote did not change it):`, `${host} 的 sshd：请把以下内容发给 ${host} 的管理员（cc-remote 没有修改它）：`)}`);
      for (const line of sshdAdvice(facts.distro ?? "", facts.os ?? "")) ctx.term.line(`      ${line}`);
    }
    if (ctx.saved.length) ctx.term.line(`${t("Saved", "已保存")}: ${[...new Set(ctx.saved)].join(", ")}`);
    if (!c.failed && !ctx.mode.check) ctx.term.line(t("Next: open a new Claude chat in Orca, or `acpc -a cc-remote`.", "下一步：在 Orca 中新开一个 Claude 聊天，或运行 `acpc -a cc-remote`。"));
  } else if (c.failed) {
    const shorts = [...new Set(left.filter(({ check }) => check.status === "fail").map(({ check }) => check.short ?? check.label))];
    ctx.term.line(t(`${ctx.term.mark("fail")} ${c.failed} failed (${shorts.join("; ")})${c.warnings ? `, ${ctx.term.mark("warn")} ${c.warnings} warning${c.warnings === 1 ? "" : "s"}` : ""}; see \`cc-remote setup --check -v\`.`, `${ctx.term.mark("fail")} ${c.failed} 项失败（${shorts.join("；")}）${c.warnings ? `，${ctx.term.mark("warn")} ${c.warnings} 项警告` : ""}；详见 \`cc-remote setup --check -v\`。`));
  } else if (c.warnings) {
    const shorts = [...new Set(left.map(({ check }) => (check.short ?? check.label).split(";")[0]!))];
    ctx.term.line(t(`All good. ${ctx.term.mark("warn")} ${c.warnings} warning${c.warnings === 1 ? "" : "s"} (${shorts.join("; ")}; see \`cc-remote setup -v\`).`, `一切正常。${ctx.term.mark("warn")} ${c.warnings} 项警告（${shorts.join("；")}；详见 \`cc-remote setup -v\`）。`));
  } else ctx.term.line(t("All good.", "一切正常。"));
  const notice = updateNotice(pkg.version, lang() === "zh");
  if (notice) ctx.term.line(notice);
}
