import type { Ctx } from "../context";
import type { Plan } from "../os";

/**
 * Runs an install plan, one command after another, on the terminal: sudo may ask for a password
 * there (`sudo -n`, unattended, fails instead). Returns whether every command succeeded.
 */
export async function runPlan(ctx: Ctx, plan: Plan): Promise<boolean> {
  for (const step of plan.steps) {
    ctx.progress.say(`  $ ${step.join(" ")}`);
    const code = ctx.mode.interactive ? await ctx.interactive(step) : await relay(ctx, step);
    if (code !== 0) return false;
  }
  return true;
}

/** Unattended: the command's output, indented, after it ends. */
async function relay(ctx: Ctx, step: string[]): Promise<number> {
  const r = await ctx.run(step, { timeoutMs: 15 * 60_000 });
  for (const line of `${r.stdout}${r.stderr}`.trim().split("\n").filter(Boolean).slice(-20)) ctx.term.line(`    ${line}`);
  return r.code;
}
