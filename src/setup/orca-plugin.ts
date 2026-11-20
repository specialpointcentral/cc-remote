import { realpathSync } from "node:fs";
import { older } from "../version";
import { type Options, pluginDecision } from "./args";
import type { Check, Ctx } from "./context";
import { OrcaError } from "./orca";
import { bundledPluginKey, bundledPluginVersion, materializePlugin, pluginMinOrca } from "./orca-plugin-bundle";
import { t } from "./ui/i18n";

export type PluginRpc = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
type Compatibility = "ready" | "old" | "headless" | "unknown" | "platform";
export type PluginCheck = {
  kind: Exclude<Compatibility, "ready"> | "installed" | "missing" | "outdated" | "disabled" | "consent" | "error" | "unavailable";
  version?: string;
  detail?: string;
};

const semver = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
const pluginCheck = (status: Check["status"], detail: string, remedy?: string[]): Check => ({ id: "O6", label: t("usage plugin", "用量插件"), status, detail, remedy });

/** The popover is a macOS desktop status-bar feature, for the Orca the manifest names. */
export function pluginCompatibility(platform: NodeJS.Platform, version: string | undefined, desktop: string | undefined): Compatibility {
  if (platform !== "darwin") return "platform";
  if (!semver(version)) return "unknown";
  if (older(version, pluginMinOrca)) return "old";
  if (!desktop) return "unknown";
  return desktop === "available" ? "ready" : "headless";
}

/** No Orca to install into: an install that was asked for fails, under the plugin's own name. */
export const pluginUnreachable = (o: Options, why: string): Check[] =>
  o.orcaPlugin === "install" ? [pluginCheck("fail", t(`can't install: ${why}`, `无法安装：${why}`))] : [];

/** Checking a plugin does not install, enable, update, or materialize it. */
export async function inspectUsagePlugin(rpc: PluginRpc, platform: NodeJS.Platform, version: string | undefined, desktop: string | undefined): Promise<PluginCheck> {
  const compatible = pluginCompatibility(platform, version, desktop);
  if (compatible !== "ready") return { kind: compatible };
  let list: any;
  try { list = await rpc("plugins.list"); } catch (e) { return { kind: "unavailable", detail: (e as Error).message }; }
  if (!Array.isArray(list)) return { kind: "unavailable", detail: "Orca returned an invalid plugin list" };
  const plugin = list.find((p) => p?.pluginKey === bundledPluginKey);
  if (!plugin) return { kind: "missing" };
  const installedVersion = typeof plugin.version === "string" ? plugin.version : undefined;
  if (plugin.needsReconsent) return { kind: "consent", version: installedVersion };
  if (plugin.status === "disabled") return { kind: "disabled", version: installedVersion };
  if (plugin.status !== "running" && plugin.status !== "idle") return { kind: "error", version: installedVersion, detail: String(plugin.status ?? "unknown") };
  return { kind: semver(installedVersion) && !older(installedVersion, bundledPluginVersion) ? "installed" : "outdated", version: installedVersion };
}

/** Accept only the exact bundled worker and its known contributions after the user opted in. */
function approvalFingerprint(data: unknown, path: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, any>;
  const grants = d.grants;
  const contributions = grants?.contributions;
  const kinds = Array.isArray(contributions) ? contributions.map((c: any) => c?.kind).sort() : [];
  if (d.pluginKey !== bundledPluginKey || d.version !== bundledPluginVersion || d.source?.kind !== "local-path" || d.source?.path !== path ||
      grants?.execution !== "trusted-worker" || !Array.isArray(grants.capabilities) || grants.capabilities.length !== 0 ||
      kinds.length !== 2 || kinds[0] !== "commands" || kinds[1] !== "statusBarItems" ||
      typeof d.approvalFingerprint !== "string" || !/^ap1-[0-9a-f]{32}$/.test(d.approvalFingerprint)) return undefined;
  return d.approvalFingerprint;
}

/** Call only after explicit user consent. Orca itself binds approval to the candidate content. */
export async function installBundledPlugin(home: string, rpc: PluginRpc): Promise<any> {
  // Orca resolves local paths before returning the source in its approval request.
  const path = realpathSync(materializePlugin(home));
  const source = { kind: "local-path", path };
  try { return await rpc("plugins.install", { source }, 30_000); } catch (e) {
    if (!(e instanceof OrcaError) || e.code !== "approval_required") throw e;
    const fingerprint = approvalFingerprint(e.data, path);
    if (!fingerprint) throw new OrcaError("Orca returned an unexpected plugin approval; no approval was sent", "unexpected_approval");
    return rpc("plugins.install", { source, approvalFingerprint: fingerprint }, 30_000);
  }
}

/** Report the preflight result and offer only the explicitly consented plugin installation. */
export async function checkAndInstallUsagePlugin(ctx: Ctx, rpc: PluginRpc, version: string | undefined, desktop: string | undefined, profile?: string): Promise<Check> {
  // Skipped: --check still reports what is there, anything else leaves it alone unseen.
  const skipped = ctx.o.orca === "skip" || ctx.o.orcaPlugin === "skip";
  const unchanged = pluginCheck("info", t("left unchanged", "按要求未修改"));
  if (skipped && !ctx.mode.check) return unchanged;
  const result = await inspectUsagePlugin(rpc, ctx.platform, version, desktop);
  const requested = ctx.o.orcaPlugin === "install";
  const blocked = requested ? "fail" : "warn";
  if (result.kind === "platform") return pluginCheck(requested ? "fail" : "info", t("the usage popover currently supports macOS only", "用量弹窗目前仅支持 macOS"));
  if (result.kind === "old") return pluginCheck(blocked, t(`Orca ${version} is too old; the plugin needs ${pluginMinOrca} or newer`, `Orca ${version} 版本过旧，插件需要 ${pluginMinOrca} 或更高版本`));
  if (result.kind === "headless") return pluginCheck(blocked, t("Orca has no available desktop window; cannot install the plugin", "Orca 没有可用的桌面窗口，无法安装插件"));
  if (result.kind === "unknown") return pluginCheck(blocked, t("could not verify Orca's version or desktop window; cannot install the plugin", "无法确认 Orca 版本或桌面窗口，无法安装插件"));
  if (result.kind === "unavailable") return pluginCheck(blocked, t(`could not inspect Orca plugins: ${result.detail}`, `无法检查 Orca 插件：${result.detail}`));

  // Even an explicit reinstall must not replace a version newer than the bundled one.
  if (semver(result.version) && older(bundledPluginVersion, result.version)) {
    const status = result.kind === "installed" ? "pass" : blocked;
    return pluginCheck(status, t(`newer version ${result.version} is ${result.kind}; left unchanged`, `已安装的较新版本 ${result.version} 状态为 ${result.kind}，未修改`));
  }

  // Current and running: nothing to do, even for --orca-plugin install, as for a Claude Command that is already ours.
  if (result.kind === "installed") return pluginCheck("pass", t(`installed and enabled (${result.version})`, `已安装并启用（${result.version}）`));
  // Disabled or awaiting Orca's approval: the user's doing, left alone unless asked.
  const decision = pluginDecision(ctx.o, ctx.mode, result.kind === "disabled" || result.kind === "consent");
  if (decision === "skip") {
    if (skipped) return unchanged;
    const detail = result.kind === "disabled" ? t("installed but disabled; left unchanged", "已安装但被禁用，未修改")
      : result.kind === "consent" ? t("installed but needs Orca approval", "已安装但需要 Orca 授权")
      : result.kind === "outdated" ? t(`installed version ${result.version ?? "?"} is older than ${bundledPluginVersion}`, `已安装版本 ${result.version ?? "?"} 早于 ${bundledPluginVersion}`)
      : result.kind === "error" ? t(`plugin is not running (${result.detail})`, `插件未运行（${result.detail}）`)
      : t("not installed (optional)", "尚未安装（可选）");
    return pluginCheck("warn", detail, [t("Install: cc-remote setup --orca-plugin install", "安装：cc-remote setup --orca-plugin install")]);
  }

  ctx.progress.say(`        ${t("The usage plugin runs local code with this user's permissions, reads cc-remote's usage cache, and can run cc-remote usage to refresh it.", "用量插件以本机当前用户权限运行，读取 cc-remote 用量缓存，并可运行 cc-remote usage 刷新额度。")}`);
  if (decision === "ask-no" && !(await ctx.prompt.yesNo(t("Install the bundled Orca usage plugin?", "安装随 cc-remote 提供的 Orca 用量插件？"), false))) {
    return pluginCheck("info", t("plugin installation declined", "已跳过插件安装"));
  }
  try {
    await installBundledPlugin(ctx.home, rpc);
    const after = await inspectUsagePlugin(rpc, ctx.platform, version, desktop);
    const ok = after.kind === "installed";
    ctx.record({ id: "orca.usage-plugin", previous: result.version ?? null, value: bundledPluginVersion, profile, ok });
    if (!ok) return pluginCheck("fail", t(`Orca did not enable the plugin (${after.kind})`, `Orca 未启用插件（${after.kind}）`));
    ctx.saved.push(t("Orca usage plugin", "Orca 用量插件"));
    return pluginCheck("pass", t(`installed and enabled (${after.version})`, `已安装并启用（${after.version}）`));
  } catch (e) {
    return pluginCheck("fail", t(`plugin installation failed: ${(e as Error).message}`, `插件安装失败：${(e as Error).message}`));
  }
}
