import { MIN_CLAUDE, tooOld, versionNumber } from "../../version";
import type { Check } from "../context";
import { type Marker, parseAuth, parseMarker, parseSshd, type Probe } from "../remote-probe";
import { t } from "../ui/i18n";

/**
 * The central server, judged from the probe and the production-path version probe. claude being
 * missing, too old, logged out or off the non-interactive PATH stops setup (`abort`): setup never
 * installs, updates or logs in claude. Everything else on a shared server is advice.
 */
export type Facts = {
  host: string;
  probe: Probe;
  /** What `claude --version` printed over cc-remote's own ssh path, if it ran. */
  version?: string;
  versionError?: string;
  /** sshd refused a session on the shared connection while probing. */
  refused?: boolean;
  /** One round trip over the shared connection, in milliseconds. */
  rttMs?: number;
  machineId?: string;
};

export type Abort = { reason: "missing" | "login-only" | "no-version" | "too-old" | "logged-out"; message: string };

const GB = 1024 * 1024;

/** The lines to send central's admin when sshd's settings would limit cc-remote. */
export function sshdAdvice(distro: string, os: string): string[] {
  const reload = os === "Darwin" ? "sudo launchctl kickstart -k system/com.openssh.sshd"
    : /debian|ubuntu/.test(distro) ? "sudo systemctl reload ssh" : "sudo systemctl reload sshd";
  return ["/etc/ssh/sshd_config.d/20-cc-remote.conf", "  MaxSessions 64", "  ClientAliveInterval 60", "  ClientAliveCountMax 5", "  MaxStartups 100:30:300", `sudo sshd -t && ${reload}`];
}

export function remoteChecks(f: Facts): { checks: Check[]; abort?: Abort } {
  const kv = f.probe.kv;
  const h = f.host;
  const checks: Check[] = [];
  let abort: Abort | undefined;

  // R4, R5: the login shell and the system.
  const shell = kv.LOGIN_SHELL || "?";
  const system = [kv.OS, kv.ARCH].filter(Boolean).join(" ") + (kv.DISTRO_ID ? ` (${[kv.DISTRO_ID, kv.DISTRO_VERSION].filter(Boolean).join(" ")})` : "");
  const posix = !/\/(fish|csh|tcsh|nu|xonsh|elvish)$/.test(shell);
  const supported = kv.OS === "Linux" || kv.OS === "Darwin";
  checks.push({
    id: "R4", label: t("login shell", "登录 shell"), detail: `${shell}, ${system}`,
    status: !supported ? "fail" : posix ? "pass" : "warn",
    short: `${shell.split("/").pop()}, ${kv.OS ?? "?"}`,
    remedy: !supported ? [t(`cc-remote needs a Linux or macOS central server, not ${kv.OS || "this system"}`, `cc-remote 需要 Linux 或 macOS 的中心服务器，而不是 ${kv.OS || "这个系统"}`)]
      : posix ? undefined : [t(`cc-remote needs a POSIX login shell on ${h}: chsh -s /bin/bash (on ${h}, by you)`, `cc-remote 需要 ${h} 上的 POSIX 登录 shell：chsh -s /bin/bash（由你在 ${h} 上执行）`)],
  });

  // R6: the tools uploads, resumes and .claude/ copies use there.
  const missingTools = (kv.TOOLS_MISSING ?? "").trim().split(/\s+/).filter(Boolean);
  const hard = missingTools.filter((x) => x === "tar" || x === "sed");
  checks.push(missingTools.length
    ? { id: "R6", label: t("tools", "工具"), status: hard.length ? "fail" : "warn", detail: t(`missing on ${h}: ${missingTools.join(", ")}`, `${h} 上缺少：${missingTools.join(", ")}`), remedy: [t(`ask ${h}'s admin to install ${missingTools.join(" ")} (setup doesn't install anything there)`, `请 ${h} 的管理员安装 ${missingTools.join(" ")}（setup 不会在那里安装任何东西）`)] }
    : { id: "R6", label: t("tools", "工具"), status: "pass", detail: "tar, sed, mkdir, rm, env" });

  // R7: claude on the PATH ssh commands get.
  if (!kv.CLAUDE_NI) {
    if (kv.CLAUDE_LOGIN) {
      abort = { reason: "login-only", message: t(
        `claude is at ${kv.CLAUDE_LOGIN} on ${h} but not on the PATH ssh commands get. On ${h}: \`ln -s ${kv.CLAUDE_LOGIN} ~/.local/bin/claude\`, then run \`cc-remote setup\` again.`,
        `claude 位于 ${h} 的 ${kv.CLAUDE_LOGIN}，但不在 ssh 命令使用的 PATH 上。请在 ${h} 上执行：\`ln -s ${kv.CLAUDE_LOGIN} ~/.local/bin/claude\`，然后重新运行 \`cc-remote setup\`。`) };
    } else {
      abort = { reason: "missing", message: t(
        `claude was not found on ${h} (looked in ~/.local/bin and the non-interactive PATH). Install Claude Code there, then run setup again.`,
        `在 ${h} 上没有找到 claude（查找了 ~/.local/bin 和非交互 PATH）。请先在那里安装 Claude Code，然后重新运行 setup。`) };
    }
    checks.push({ id: "R7", label: "claude", status: "fail", detail: kv.CLAUDE_LOGIN ? t(`only in the login shell's PATH (${kv.CLAUDE_LOGIN})`, `只在登录 shell 的 PATH 中（${kv.CLAUDE_LOGIN}）`) : t(`not found on ${h}`, `${h} 上未找到`) });
    return { checks: [...checks, ...serverChecks(f)], abort };
  }

  // R8: claude's version, asked through cc-remote's own ssh path.
  const version = f.version && versionNumber(f.version);
  const tilde = (p: string) => p.replace(/^\/(home|Users)\/[^/]+\//, "~/");
  if (!version) {
    abort = { reason: "no-version", message: t(
      `claude is at ${kv.CLAUDE_NI} on ${h}, but \`claude --version\` failed${f.versionError ? `: ${f.versionError}` : ""}. Fix claude there, then run setup again.`,
      `claude 位于 ${h} 的 ${kv.CLAUDE_NI}，但 \`claude --version\` 失败${f.versionError ? `：${f.versionError}` : ""}。请先在那里修好 claude，然后重新运行 setup。`) };
    checks.push({ id: "R8", label: "claude", status: "fail", detail: t("`claude --version` failed", "`claude --version` 失败") });
  } else if (tooOld(h, f.version!)) {
    const min = MIN_CLAUDE;
    abort = { reason: "too-old", message: t(
      `claude on ${h} is ${version}, older than the ${min} cc-remote needs. Run \`claude update\` on ${h}, then run setup again.`,
      `${h} 上的 claude 是 ${version}，低于 cc-remote 需要的 ${min}。请在 ${h} 上运行 \`claude update\`，然后重新运行 setup。`) };
    checks.push({ id: "R8", label: "claude", status: "fail", detail: t(`${f.version} at ${tilde(kv.CLAUDE_NI)} (needs >= ${min})`, `${f.version}，位于 ${tilde(kv.CLAUDE_NI)}（需要 >= ${min}）`) });
  } else {
    const min = MIN_CLAUDE;
    checks.push({ id: "R8", label: "claude", status: "pass", detail: t(`${f.version} at ${tilde(kv.CLAUDE_NI)} (needs >= ${min})`, `${f.version}，位于 ${tilde(kv.CLAUDE_NI)}（需要 >= ${min}）`), short: `claude ${version}` });
  }

  // R9: logged in. All project machines share this one login.
  const auth = parseAuth(f.probe.sections.auth);
  if (!auth) {
    checks.push({ id: "R9", label: t("login", "登录"), status: "warn", detail: t("couldn't read `claude auth status --json`", "无法读取 `claude auth status --json`") });
  } else if (!auth.loggedIn) {
    abort ??= { reason: "logged-out", message: t(
      `Setup stopped: cc-remote needs a logged-in claude on ${h}, and setup doesn't install or log in claude. Log in on ${h} (all project machines share that login), for example:\n    cc-remote --host ${h} --cli auth login\nthen run \`cc-remote setup\` again.`,
      `setup 已停止：cc-remote 需要 ${h} 上已登录的 claude，而 setup 不会安装或登录 claude。请在 ${h} 上登录（所有项目机器共用这个登录），例如：\n    cc-remote --host ${h} --cli auth login\n然后重新运行 \`cc-remote setup\`。`) };
    checks.push({ id: "R9", label: t("login", "登录"), status: "fail", detail: t(`claude on ${h} is not logged in`, `${h} 上的 claude 未登录`), remedy: [t(`Fix (on ${h}, by you): cc-remote --cli auth login`, `修复（由你在 ${h} 上进行）：cc-remote --cli auth login`)], short: t("claude not logged in", "claude 未登录") });
  } else {
    const how = auth.subscription ? `subscription: ${auth.subscription}` : auth.provider && auth.provider !== "firstParty" ? `provider: ${auth.provider}` : auth.method ?? "";
    checks.push({ id: "R9", label: t("login", "登录"), status: "pass", detail: t(`logged in${how ? ` (${how})` : ""} — shared by all project machines`, `已登录${how ? `（${how}）` : ""}——所有项目机器共用`), short: t("logged in", "已登录") });
  }

  // R10: permission mode auto, which the Orca step offers.
  checks.push(kv.HELP_AUTO === "1"
    ? { id: "R10", label: t("auto mode", "auto 模式"), status: "pass", detail: t(`${h}'s claude offers permission mode auto`, `${h} 的 claude 支持 auto 权限模式`) }
    : { id: "R10", label: t("auto mode", "auto 模式"), status: "warn", detail: t(`${h}'s claude doesn't offer permission mode auto: Orca's permission mode is left alone`, `${h} 的 claude 不支持 auto 权限模式：不会修改 Orca 的权限模式`) });

  return { checks: [...checks, ...serverChecks(f)], abort };
}

/** Whether R10 passed: central's claude offers permission mode auto. */
export const autoOffered = (probe: Probe) => probe.kv.HELP_AUTO === "1";

/** ~/.cc-remote, the marker, sshd, resources and the shared connection: advice only. */
function serverChecks(f: Facts): Check[] {
  const kv = f.probe.kv;
  const h = f.host;
  const checks: Check[] = [];

  // R11: cc-remote's folder there.
  const free = Number(kv.CC_FREE_KB);
  const freeText = Number.isFinite(free) && kv.CC_FREE_KB ? `${(free / GB).toFixed(free < 10 * GB ? 1 : 0)} GB ${t("free", "可用")}` : "";
  if (kv.CC_DIR === "other" || kv.CC_DIR === "dangling") {
    checks.push({ id: "R11", label: "~/.cc-remote", status: "fail", detail: t("exists but isn't a folder", "存在但不是目录"), remedy: [t(`move ~/.cc-remote aside on ${h}`, `请在 ${h} 上把 ~/.cc-remote 移走`)] });
  } else if (kv.CC_WRITABLE !== "1" || (Number.isFinite(free) && kv.CC_FREE_KB && free < 100 * 1024)) {
    checks.push({ id: "R11", label: "~/.cc-remote", status: "fail", detail: kv.CC_WRITABLE !== "1" ? t("not writable", "不可写") : t(`only ${freeText}`, `只有 ${freeText}`) });
  } else {
    const low = Number.isFinite(free) && kv.CC_FREE_KB && free < GB;
    const owned = kv.CC_OWNED === "1";
    const state = kv.CC_DIR === "dir" ? t("writable", "可写") : t("will be created", "将被创建");
    checks.push({ id: "R11", label: "~/.cc-remote", status: low || !owned ? "warn" : "pass", detail: [state, owned ? "" : t("not owned by you", "不归你所有"), freeText].filter(Boolean).join(", ") });
  }

  // R12: another project machine with this hostname.
  const marker: Marker | undefined = parseMarker(f.probe.sections.marker);
  if (marker && marker.machineId !== f.machineId) {
    checks.push({
      id: "R12", label: t("machine", "机器"), status: "warn",
      detail: t("another project machine uses this hostname on the central server: host folders and sessions would mix (all machines share one account)", "中心服务器上另一台项目机器使用了相同的主机名：主机目录和会话会混在一起（所有机器共用一个账号）"),
      remedy: [t("Rename this machine, or, if it is that machine (reinstalled), remove the marker on the central server: rm ~/.cc-remote/machines/<hostname>.json", "给这台机器改名；或者如果它就是那台机器（重装过），删除中心服务器上的标记：rm ~/.cc-remote/machines/<hostname>.json")],
    });
  }

  // R13: sshd's limits, read from its config as text.
  const sshd = parseSshd(f.probe.sections.sshd);
  if (!sshd.readable) {
    checks.push({ id: "R13", label: "sshd", status: "info", detail: t("its config isn't readable here (as on RHEL); not checked", "这里读不到它的配置（RHEL 上如此）；未检查") });
  } else {
    const max = sshd.maxSessions ?? 10;
    if (max < 32) {
      checks.push({ id: "R13", label: "sshd", status: "warn", detail: t(`MaxSessions ${max}${sshd.maxSessions === undefined ? " (default)" : ""}: sessions past ${max} at once are refused on the shared connection and retry on their own`, `MaxSessions ${max}${sshd.maxSessions === undefined ? "（默认）" : ""}：同时超过 ${max} 个会话时，共享连接会拒绝新会话，由它们自行重试`), short: `sshd MaxSessions ${max}` });
    }
    if ((sshd.clientAliveInterval ?? 0) === 0) {
      checks.push({ id: "R13", label: "sshd", status: "warn", detail: t("ClientAliveInterval 0: claude keeps running on the central server after a project machine drops off, until TCP gives up", "ClientAliveInterval 0：项目机器掉线后，claude 会在中心服务器上继续运行，直到 TCP 放弃"), short: "sshd ClientAliveInterval 0" });
    }
    if (max >= 32 && (sshd.clientAliveInterval ?? 0) > 0) checks.push({ id: "R13", label: "sshd", status: "pass", detail: `MaxSessions ${max}, ClientAliveInterval ${sshd.clientAliveInterval} (${t("approximate", "近似")})` });
    if (!sshd.maxStartups || sshd.maxStartups === "10:30:100") checks.push({ id: "R13", label: "sshd", status: "info", detail: t("MaxStartups is the default 10:30:100: many machines connecting at once may be turned away briefly", "MaxStartups 为默认的 10:30:100：大量机器同时连接时可能被短暂拒绝") });
  }

  // R14: what all project machines share on that one account.
  const nofile = Number(kv.NOFILE);
  const nproc = Number(kv.NPROC);
  const mem = Number(kv.MEM_KB);
  const procs = Number(kv.CLAUDE_PROCS) || 0;
  const problems: string[] = [];
  if (Number.isFinite(nofile) && kv.NOFILE && nofile < 4096) problems.push(`nofile ${nofile} < 4096`);
  if (Number.isFinite(nproc) && kv.NPROC && nproc < Math.max(1024, (procs + 10) * 30)) problems.push(t(`nproc ${nproc} is low for ${procs} claude processes`, `nproc ${nproc} 对 ${procs} 个 claude 进程来说偏低`));
  if (Number.isFinite(mem) && kv.MEM_KB && mem < GB) problems.push(t(`only ${(mem / GB).toFixed(1)} GB available`, `只有 ${(mem / GB).toFixed(1)} GB 可用内存`));
  if (f.rttMs !== undefined && f.rttMs > 300) problems.push(t(`round trip ${f.rttMs} ms`, `往返 ${f.rttMs} ms`));
  const facts = [kv.NOFILE && `nofile ${kv.NOFILE}`, kv.NPROC && `nproc ${kv.NPROC}`, Number.isFinite(mem) && kv.MEM_KB ? `${(mem / GB).toFixed(1)} GB ${t("available", "可用")}` : "", t(`${procs} claude processes`, `${procs} 个 claude 进程`), f.rttMs !== undefined ? t(`round trip ${f.rttMs} ms`, `往返 ${f.rttMs} ms`) : ""].filter(Boolean).join(", ");
  checks.push(problems.length
    ? { id: "R14", label: t("resources", "资源"), status: "warn", detail: `${problems.join("; ")} (${facts})`, remedy: [t("all project machines' claude processes run as this one user and share the subscription's rate limits", "所有项目机器的 claude 进程都以这一个用户运行，并共享订阅的速率限制")] }
    : { id: "R14", label: t("resources", "资源"), status: "pass", detail: facts });

  // R15: python3, which the relay that keeps sessions across dropped connections runs on.
  const python = kv.PYTHON_VERSION?.match(/^(\d+)\.(\d+)/);
  const fit = python && (Number(python[1]) > 3 || (Number(python[1]) === 3 && Number(python[2]) >= 6));
  checks.push(fit
    ? { id: "R15", label: "python3", status: "pass", detail: t(`${kv.PYTHON_VERSION}: sessions survive a dropped connection`, `${kv.PYTHON_VERSION}：连接断开后会话可以继续`) }
    : {
        id: "R15", label: "python3", status: "warn",
        detail: kv.PYTHON_VERSION
          ? t(`${kv.PYTHON_VERSION} is older than 3.6: a dropped connection ends the session's claude`, `${kv.PYTHON_VERSION} 低于 3.6：连接断开会结束会话中的 claude`)
          : t(`not found on ${h}: a dropped connection ends the session's claude`, `${h} 上未找到：连接断开会结束会话中的 claude`),
        remedy: [t(`needed for reconnection: ask ${h}'s admin to install python3 (3.6 or later; setup doesn't install anything there)`, `重连需要它：请 ${h} 的管理员安装 python3（3.6 或更高版本；setup 不会在那里安装任何东西）`)],
        short: t("no python3: no reconnection", "无 python3：不能重连"),
      });

  // R3: refusals on the shared connection now.
  if (f.refused) checks.push({ id: "R3", label: t("sharing", "共享连接"), status: "warn", detail: t("sshd refused a session on the shared connection just now (MaxSessions)", "sshd 刚刚在共享连接上拒绝了一个会话（MaxSessions）") });

  return checks;
}
