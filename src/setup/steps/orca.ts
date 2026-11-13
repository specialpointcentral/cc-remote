import { accessSync, constants, realpathSync } from "node:fs";
import { basename } from "node:path";
import { installed, layout } from "../../install/layout";
import { type CommandKind, commandDecision, type Decision, envDecision, permissionDecision } from "../args";
import type { Check, Ctx } from "../context";
import {
  call, discover, normalizeCommand, OrcaError, type Permission, permissionOf, type Runtime, setCommand, setEnv, setPermissionAuto,
  validateCommand, versionSupport,
} from "../orca";
import { endStep, width } from "../report";
import { t } from "../ui/i18n";

/**
 * Step 6, Orca Server on this machine: its Claude Command, the permission mode of its Claude
 * chats, and optionally the environment cc-remote needs. Each change shows the current and the
 * proposed value, asks (or follows the `--orca` rules unattended), is checked in Orca's answer and
 * read back, and its previous value is recorded.
 */
export type OrcaResult = { runtime?: Runtime; command?: string; envNames: string[] };

/** The variables cc-remote reads that Orca Server, which doesn't read shell profiles, may lack. */
export const ENV_NAMES = ["CC_REMOTE_SSH", "CC_REMOTE_CONTROL_PERSIST", "CC_REMOTE_KEEPALIVE_TIMEOUT"];

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Claude Command to propose: the stable path (never the versioned binary, which an update
 * replaces) followed by `claude`, without `--host`, which the host file holds. Without a managed
 * install, a compiled binary's own path, with a warning; from source, none.
 */
export function proposedCommand(ctx: Ctx): { value?: string; note?: string } {
  const l = layout(ctx.env, ctx.platform);
  const state = installed(l);
  if (state.kind === "managed" || (state.kind === "unmanaged" && executable(l.stable))) return { value: `${l.stable} claude` };
  if (ctx.self.compiled) return { value: `${ctx.self.execPath} claude`, note: t(`${ctx.tilde(ctx.self.execPath)} isn't the managed install: an update won't reach Orca`, `${ctx.tilde(ctx.self.execPath)} 不是受管理的安装：更新不会作用到 Orca`) };
  return { note: t("cc-remote runs from source here: install it (install.sh) before pointing Orca at it", "这里的 cc-remote 是从源码运行的：请先用 install.sh 安装，再让 Orca 指向它") };
}

/** How the current command relates to the proposed one. */
export function commandKind(current: string | undefined, proposed: string): CommandKind {
  const now = normalizeCommand(current ?? "");
  if (!now || now === "claude") return "default";
  if (now === normalizeCommand(proposed)) return "ours";
  const program = now.split(" ")[0]!;
  let real = program;
  try {
    real = realpathSync(program);
  } catch {}
  return [program, real].some((p) => /^cc-remote(\.exe)?$|^cc-remote-(linux|darwin|windows)-/.test(basename(p))) ? "cc-remote" : "custom";
}

const PERMISSION_TEXT: Record<string, [string, string]> = {
  "full-access": ["Bash runs here without asking", "Bash 在本机运行，不会询问"],
  auto: ["Claude reviews risky actions itself", "由 Claude 自行审查有风险的操作"],
  ask: ["every action asks", "每个操作都会询问"],
  "accept-edits": ["edits go ahead, other actions ask", "编辑直接进行，其他操作会询问"],
  own: ["each agent's own default", "使用各 agent 自己的默认值"],
};

/** Asks, or not, as the decision says; true when the change goes ahead. */
async function consent(ctx: Ctx, decision: Decision, question: string): Promise<boolean> {
  if (decision === "do") return true;
  if (decision === "skip") return false;
  return ctx.prompt.yesNo(question, decision === "ask-yes");
}

export async function stepOrca(ctx: Ctx, autoOffered: boolean | undefined): Promise<OrcaResult> {
  const label = ctx.mode.check ? "Orca" : t("Orca Server on this machine", "本机的 Orca Server");
  ctx.progress.begin(label);
  const out: OrcaResult = { envNames: [] };
  const say = (line: string) => ctx.progress.say(`        ${line}`);
  // "now" and "proposed" lines, their values in one column whatever the language.
  const pair = (now: string, nowValue: string, next: string, nextValue: string) => {
    const col = Math.max(width(now), width(next)) + 2;
    say(`${now}${" ".repeat(col - width(now))}${nowValue}`);
    say(`${next}${" ".repeat(col - width(next))}${nextValue}`);
  };
  if (ctx.platform === "win32") {
    endStep(ctx, "orca", [{ id: "O1", status: "info", label: "Orca", detail: t("setup doesn't configure Orca on Windows yet", "setup 暂不支持在 Windows 上配置 Orca") }], "Orca Server", t("not supported on Windows yet", "暂不支持 Windows"));
    return out;
  }
  const found = await discover(ctx.env, ctx.home, ctx.platform, ctx.o.orcaProfile);
  const problems: Check[] = found.problems.map((p) => ({ id: "O1", status: "warn", label: "Orca", detail: `${ctx.tilde(p.profile)}: ${p.problem}` }));
  if (!found.live.length) {
    const detail = found.installed ? t(`Orca Server ${found.installed} is installed but not running`, `Orca Server ${found.installed} 已安装但没有运行`) : t("not running here", "本机没有运行");
    endStep(ctx, "orca", [...problems, { id: "O1", status: "info", label: "Orca", detail }], ctx.mode.check ? "Orca" : "Orca Server", detail);
    return out;
  }
  let rt = found.live[0]!;
  if (found.live.length > 1) {
    if (!ctx.mode.interactive) {
      const detail = t(`${found.live.length} Orca Servers are running (${found.live.map((r) => ctx.tilde(r.profile)).join(", ")}); pass --orca-profile`, `有 ${found.live.length} 个 Orca Server 在运行（${found.live.map((r) => ctx.tilde(r.profile)).join("、")}）；请传入 --orca-profile`);
      endStep(ctx, "orca", [{ id: "O1", status: "warn", label: "Orca", detail }], ctx.mode.check ? "Orca" : "Orca Server", detail);
      return out;
    }
    found.live.forEach((r, i) => ctx.progress.say(`  ${i + 1}) ${ctx.tilde(r.profile)}  ${r.appVersion ?? ""}`));
    const pick = Number(await ctx.prompt.line(t("Which Orca Server?", "配置哪个 Orca Server？"), { def: "1" }));
    rt = found.live[pick - 1] ?? rt;
  }
  out.runtime = rt;
  const checks: Check[] = [...problems];
  const support = versionSupport(rt.appVersion);
  checks.push({
    id: "O2", label: "Orca", status: support === "verified" ? "pass" : "warn",
    detail: `Orca Server ${rt.appVersion ?? "?"} ${t("running", "正在运行")} (profile ${ctx.tilde(rt.profile)}, ready)` + (support === "verified" ? "" : t(` — not verified with cc-remote (verified: 1.4.254)`, ` —— 未经 cc-remote 验证（已验证：1.4.254）`)),
  });
  const done: string[] = [];
  try {
    let launch = (await call(rt, "settings.getAgentLaunch"))?.settings ?? {};
    const settings = (await call(rt, "settings.get"))?.settings ?? {};

    // O3: the Claude Command.
    const current: string | undefined = launch.agentCmdOverrides?.claude;
    const proposal = proposedCommand(ctx);
    const invalid = proposal.value ? validateCommand(proposal.value) : undefined;
    out.command = current?.trim() || undefined;
    if (!proposal.value || (invalid && "error" in invalid)) {
      checks.push({ id: "O3", label: t("command", "命令"), status: "warn", detail: proposal.note ?? t(`Orca would refuse ${proposal.value}: ${(invalid as { error: string }).error}`, `Orca 会拒绝 ${proposal.value}：${(invalid as { error: string }).error}`) });
    } else {
      const kind = commandKind(current, proposal.value);
      const decision = commandDecision(ctx.o, ctx.mode, kind);
      const shown = current?.trim() ? current : t("(Orca's default: claude)", "（Orca 的默认值：claude）");
      if (kind !== "ours" && (ctx.details || decision.startsWith("ask"))) {
        pair(t("Claude Command now:", "Claude Command 当前："), shown, t("Proposed:", "建议："), proposal.value);
        if (kind === "custom") say(`${ctx.term.mark("warn")} ${t("the current command isn't cc-remote; replacing it changes what Orca's Claude chats run", "当前命令不是 cc-remote；替换后 Orca 的 Claude 聊天运行的程序会改变")}`);
      }
      if (kind === "ours") checks.push({ id: "O3", label: t("command", "命令"), status: "pass", detail: proposal.value, short: t("Claude Command", "Claude Command") });
      else if (await consent(ctx, decision, t(`Set Orca's Claude Command? New Claude chats on this Orca Server will run on the central server.`, `设置 Orca 的 Claude Command？此 Orca Server 上新开的 Claude 聊天将在中心服务器上运行。`))) {
        const stored = await setCommand(rt, proposal.value);
        launch = (await call(rt, "settings.getAgentLaunch"))?.settings ?? {};
        const ok = stored === proposal.value && normalizeCommand(launch.agentCmdOverrides?.claude ?? "") === normalizeCommand(proposal.value);
        ctx.record({ id: "orca.claude-command", previous: current ?? null, value: proposal.value, profile: rt.profile, ok });
        if (ok) {
          out.command = proposal.value;
          done.push(t("Claude Command set", "已设置 Claude Command"));
          ctx.saved.push(t("Orca settings", "Orca 设置"));
          checks.push({ id: "O3", label: t("command", "命令"), status: "pass", detail: t(`set to ${proposal.value}${kind === "default" ? " (was Orca's default)" : ""}`, `已设为 ${proposal.value}${kind === "default" ? "（原为 Orca 默认值）" : ""}`) });
        } else checks.push({ id: "O3", label: t("command", "命令"), status: "fail", detail: t("Orca didn't keep the new Claude Command", "Orca 没有保存新的 Claude Command") });
      } else {
        const why = kind === "custom" ? t("custom", "自定义") : kind === "cc-remote" ? t("another cc-remote", "另一个 cc-remote") : t("Orca's default: claude", "Orca 的默认值：claude");
        checks.push({ id: "O3", label: t("command", "命令"), status: "warn", detail: t(`Claude Command is ${current?.trim() || "claude"} (${why}), not this install`, `Claude Command 是 ${current?.trim() || "claude"}（${why}），不是本次安装`), remedy: [t("Fix: cc-remote setup", "修复：cc-remote setup") + (kind === "custom" ? " --orca set" : "")], short: t(`Claude Command is ${current?.trim() || "claude"}`, `Claude Command 是 ${current?.trim() || "claude"}`) });
      }
    }

    // O4: the permission mode of new Claude chats.
    const p: Permission = permissionOf(launch, settings);
    const decision = permissionDecision(ctx.o, ctx.mode, p, autoOffered === true);
    const text = (mode: string) => t(`${mode} (${PERMISSION_TEXT[mode]?.[0] ?? mode})`, `${mode}（${PERMISSION_TEXT[mode]?.[1] ?? mode}）`);
    if (p.current === "auto") checks.push({ id: "O4", label: t("permission", "权限"), status: "pass", detail: t("Claude chats use permission mode auto", "Claude 聊天使用 auto 权限模式"), short: t("permission mode", "权限模式") });
    else if (autoOffered === false || ctx.o.orcaPermission === "keep") {
      checks.push({ id: "O4", label: t("permission", "权限"), status: "info", detail: t(`Claude chats use ${p.current}; left alone (${autoOffered === false ? "the central claude doesn't offer auto" : "--orca-permission keep"})`, `Claude 聊天使用 ${p.current}；未改动（${autoOffered === false ? "中心服务器的 claude 不支持 auto" : "--orca-permission keep"}）`) });
    } else {
      if (ctx.details || decision.startsWith("ask")) {
        pair(t("Claude chat permission mode now:", "Claude 聊天权限模式当前："), `${text(p.current)}${p.isDefault ? t(" — Orca's default", " —— Orca 的默认值") : ""}`, t("Proposed:", "建议："), text("auto"));
      }
      if (await consent(ctx, decision, t("Set Claude chats in Orca to permission mode auto?", "把 Orca 中 Claude 聊天的权限模式设为 auto？"))) {
        const stored = await setPermissionAuto(rt, p);
        const after = permissionOf((await call(rt, "settings.getAgentLaunch"))?.settings, (await call(rt, "settings.get"))?.settings);
        const ok = stored === "auto" && after.current === "auto";
        ctx.record(p.model === "agent-permission"
          ? { id: "orca.permission", model: p.model, previousOverride: p.override ?? null, previousDefault: p.def, value: "auto", profile: rt.profile, ok }
          : { id: "orca.permission", model: p.model, previous: p.current, value: "auto", profile: rt.profile, ok });
        if (ok) {
          done.push(t("permission mode auto", "权限模式 auto"));
          ctx.saved.push(t("Orca settings", "Orca 设置"));
          checks.push({ id: "O4", label: t("permission", "权限"), status: "pass", detail: t(`new Claude chats use permission mode auto (was ${p.current}${p.isDefault ? ", Orca's default" : ""})`, `新的 Claude 聊天使用 auto 权限模式（原为 ${p.current}${p.isDefault ? "，Orca 默认值" : ""}）`) });
        } else checks.push({ id: "O4", label: t("permission", "权限"), status: "fail", detail: t("Orca didn't keep permission mode auto", "Orca 没有保存 auto 权限模式") });
      } else {
        checks.push(p.isDefault
          ? { id: "O4", label: t("permission", "权限"), status: "warn", detail: t(`Claude chats use ${text(p.current)}, Orca's default`, `Claude 聊天使用 ${text(p.current)}，Orca 的默认值`), remedy: [t("Fix: cc-remote setup", "修复：cc-remote setup")], short: t(`Orca permission mode ${p.current}`, `Orca 权限模式 ${p.current}`) }
          : { id: "O4", label: t("permission", "权限"), status: "info", detail: t(`Claude chats use ${p.current} (custom); left alone`, `Claude 聊天使用 ${p.current}（自定义）；未改动`) });
      }
    }

    // O5: the environment, for names only: Orca never returns the values.
    const names: string[] = (await call(rt, "settings.getAgentLaunch"))?.settings?.environmentNames?.claude ?? [];
    const missing = ENV_NAMES.filter((n) => ctx.env[n] && !names.includes(n));
    out.envNames = names;
    if (missing.length) {
      const decision = envDecision(ctx.o, ctx.mode);
      if (await consent(ctx, decision, t(`Copy ${missing.join(", ")} from this shell into Orca's Claude environment?`, `把本 shell 中的 ${missing.join("、")} 复制到 Orca 的 Claude 环境变量？`))) {
        let after = names;
        for (const name of missing) after = await setEnv(rt, name, ctx.env[name]!);
        const ok = missing.every((n) => after.includes(n));
        ctx.record({ id: "orca.env", names: missing, previous: null, profile: rt.profile, ok });
        out.envNames = after;
        if (ok) done.push(t("environment", "环境变量"));
        checks.push({ id: "O5", label: t("environment", "环境"), status: ok ? "pass" : "fail", detail: ok ? t(`copied ${missing.join(", ")}`, `已复制 ${missing.join("、")}`) : t("Orca didn't keep the environment", "Orca 没有保存环境变量") });
      } else {
        checks.push({ id: "O5", label: t("environment", "环境"), status: "warn", detail: t(`${missing.join(", ")} is set here but not in Orca's Claude environment`, `${missing.join("、")} 在这里设置了，但 Orca 的 Claude 环境变量中没有`), remedy: [t("Fix: cc-remote setup --orca-env", "修复：cc-remote setup --orca-env")] });
      }
    }
  } catch (e) {
    if (!(e instanceof OrcaError)) throw e;
    checks.push({ id: "O1", label: "Orca", status: "fail", detail: e.message });
  }
  const status = checks.some((c) => c.status === "fail") ? "fail" : undefined;
  const end = done.length
    ? `Orca Server: ${done.join(t(", ", "、"))}`
    : checks.some((c) => c.id === "O3" && c.status === "pass") && checks.some((c) => c.id === "O4" && c.status === "pass")
      ? t("Orca Server: Claude Command and permission mode already set", "Orca Server：Claude Command 和权限模式均已设置")
      : "Orca Server";
  const both = checks.some((c) => c.id === "O3" && c.status === "pass") && checks.some((c) => c.id === "O4" && c.status === "pass");
  const summary = ctx.mode.check && both ? t("Claude Command and permission mode set", "Claude Command 和权限模式均已设置") : "";
  endStep(ctx, "orca", checks, ctx.mode.check ? "Orca" : end, status ? undefined : summary);
  return out;
}
