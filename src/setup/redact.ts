import { hostname } from "node:os";
import { type Config, ensureKey, loadRedactor, machineValues, nameProblem, readConfig, resetRedaction, type Value, writeConfig } from "../redact";
import { redactDecision } from "./args";
import type { Check, Ctx } from "./context";
import { replaceCheck, show } from "./report";
import { t } from "./ui/i18n";

/**
 * Redaction in setup (see src/redact.ts): a finding of step 1, the question that turns it on, and
 * the name this machine goes by on the central server.
 */

const LABEL = () => t("redaction", "脱敏");

/** What would be replaced on this machine, in a few words. */
function describe(values: Value[]): string {
  const of = (kind: Value["kind"]) => values.filter((v) => v.kind === kind);
  const ips = of("ip").length + of("ip6").length;
  const parts = [
    // The longest names them all: the fully qualified name holds the others.
    ...of("host").sort((a, b) => b.text.length - a.text.length).slice(0, 1).map((v) => t(`host name ${v.text}`, `主机名 ${v.text}`)),
    ...(ips ? [t(`${ips} address${ips === 1 ? "" : "es"}`, `${ips} 个 IP`)] : []),
    ...of("user").map((v) => t(`user name ${v.text}`, `用户名 ${v.text}`)),
    ...(of("mid").length ? [t("machine id", "机器 ID")] : []),
  ];
  return parts.join(t(", ", "、"));
}

/** L10: whether redaction is on, and what it replaces. */
export function redactCheck(ctx: Ctx): Check {
  let config: Config | undefined;
  try {
    config = readConfig(ctx.config);
  } catch (e) {
    return {
      id: "L10", status: "fail", label: LABEL(), detail: (e as Error).message,
      remedy: [t("fix the file, or run: cc-remote setup --redact off", "修好这个文件，或运行：cc-remote setup --redact off")],
    };
  }
  if (!config?.enabled) {
    const detail = config ? t("off", "已关闭") : t("off (not set up)", "已关闭（未设置）");
    return { id: "L10", status: "info", label: LABEL(), detail, remedy: [t("to turn it on: cc-remote setup --redact on", "开启：cc-remote setup --redact on")] };
  }
  const { values, skipped } = machineValues();
  const more = config.names.length ? t(`, and ${config.names.length} more name${config.names.length === 1 ? "" : "s"}`, `，以及另外 ${config.names.length} 个名字`) : "";
  const short = skipped.length ? t(`; too short to replace: ${skipped.map((v) => v.text).join(", ")}`, `；太短无法替换：${skipped.map((v) => v.text).join("、")}`) : "";
  return {
    id: "L10", status: skipped.length ? "warn" : "pass", label: LABEL(),
    detail: t(`on: replaces ${describe(values)}${more}${short}`, `已开启：替换${describe(values)}${more}${short}`),
    short: t("redaction on", "脱敏已开启"),
  };
}

/** Names from a comma-separated answer, and the ones that can't be used with why. */
function parseNames(list: string[]): { names: string[]; bad: string[] } {
  const names: string[] = [];
  const bad: string[] = [];
  for (const n of list.map((x) => x.trim()).filter(Boolean)) {
    const problem = nameProblem(n);
    if (problem) bad.push(`${n}: ${problem}`);
    else if (!names.includes(n)) names.push(n);
  }
  return { names, bad };
}

/**
 * Turns redaction on or off: asked at a terminal while it was never set up (default no), or as
 * the flags say. The answer is saved either way, so the question comes once.
 */
export async function setupRedaction(ctx: Ctx, check: Check): Promise<void> {
  let current: Config | undefined;
  try {
    current = readConfig(ctx.config);
  } catch {
    // An unusable file is only replaced on a flag's say-so.
    if (!ctx.o.redact) return;
  }
  const configured = current !== undefined || check.status === "fail";
  const decision = redactDecision(ctx.o, ctx.mode, configured);
  if (decision === "skip") return;

  let next: Config;
  if (decision === "do") {
    const { names, bad } = parseNames(ctx.o.redactNames ?? current?.names ?? []);
    for (const b of bad) ctx.progress.say(`        ${ctx.term.mark("warn")} ${t(`left out ${b}`, `已忽略 ${b}`)}`);
    next = { enabled: ctx.o.redact ? ctx.o.redact === "on" : current?.enabled ?? false, names };
  } else {
    const { values } = machineValues();
    ctx.progress.say(`        ${t(`This machine's identifiers: ${describe(values)}.`, `本机标识：${describe(values)}。`)}`);
    const on = await ctx.prompt.yesNo(t(
      "Replace them with placeholders in everything sent to the central server (claude's stream, commands, uploads; not the terminal of `cc-remote --cli`), and restore them here?",
      "在发往中心服务器的所有内容（claude 的消息、命令、上传；不含 `cc-remote --cli` 的终端）里把它们换成占位符，回到本机时再还原？",
    ), false);
    let names: string[] = [];
    if (on) {
      const answer = await ctx.prompt.line(t(
        "Other names to replace, comma-separated: internal domains, hosts, code names (Enter for none)",
        "另外要替换的名字，用逗号分隔：内部域名、主机名、项目代号（直接回车表示没有）",
      ));
      const parsed = parseNames(answer.split(","));
      for (const b of parsed.bad) ctx.progress.say(`        ${ctx.term.mark("warn")} ${t(`left out ${b}`, `已忽略 ${b}`)}`);
      names = parsed.names;
    }
    next = { enabled: on, names };
  }
  if (current && current.enabled === next.enabled && JSON.stringify(current.names) === JSON.stringify(next.names)) return;
  writeConfig(next, ctx.config);
  if (next.enabled) ensureKey(ctx.config);
  resetRedaction();
  ctx.record({ id: "local.redact", previous: current ?? null, value: next });
  ctx.saved.push("~/.config/cc-remote/redact.json");
  const after = redactCheck(ctx);
  show(ctx, after);
  replaceCheck(ctx, "local", "L10", after);
}

/**
 * The name this machine goes by on the central server, for its marker and its ssh key's comment:
 * the host name, or under redaction its placeholder. Undefined when that can't be told (unusable
 * settings, or no key yet under --check): the caller then uses no name at all.
 */
export function machineLabel(ctx: Ctx): string | undefined {
  try {
    const config = readConfig(ctx.config);
    if (!config?.enabled) return hostname();
    const r = loadRedactor(ctx.config, !ctx.mode.check);
    return r.on ? r.text(hostname()) : undefined;
  } catch {
    return undefined;
  }
}
