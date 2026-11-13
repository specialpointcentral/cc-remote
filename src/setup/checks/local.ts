import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { binary, installed, layout } from "../../install/layout";
import { loginShell } from "../../tools/login";
import { versionCache } from "../../version";
import type { Check, Ctx } from "../context";
import { validateCommand } from "../orca";
import { hostnameAdvice, installPlan, type Machine, parseOsRelease, type Pkg } from "../os";
import { t } from "../ui/i18n";

/**
 * This machine: the ssh client, the cc-remote install, ripgrep, the login shell, git, the
 * hostname, where the host is configured, connection sharing and the version cache. Each missing
 * package comes back in `missing`, for setup to offer installing it.
 */
export type Local = { checks: Check[]; missing: Pkg[]; machine: Machine; isSsh: boolean };

const GENERIC = /^(localhost(\.localdomain)?|ubuntu|debian|raspberrypi|fedora|centos|rocky|almalinux|archlinux|alpine|kali|vagrant|ubuntu-server|default|server|vm|test|instance-\d+|(ip|vm)-[\d-]+)$/i;

export function machine(ctx: Ctx): Machine {
  let release: { id?: string; like: string[] } = { like: [] };
  try {
    release = parseOsRelease(readFileSync(ctx.osRelease, "utf8"));
  } catch {}
  return { platform: ctx.platform, ...release, root: ctx.root, has: (c) => !!ctx.which(c) };
}

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The ssh command cc-remote runs: CC_REMOTE_SSH's first word, or ssh. */
export function sshCommand(ctx: Ctx): { argv: string[]; isSsh: boolean } {
  const custom = ctx.env.CC_REMOTE_SSH?.split(/\s+/).filter(Boolean);
  if (!custom?.length) return { argv: ["ssh"], isSsh: true };
  return { argv: custom, isSsh: /^ssh(\.exe)?$/i.test(basename(custom[0]!.replaceAll("\\", "/"))) };
}

export async function localChecks(ctx: Ctx): Promise<Local> {
  const m = machine(ctx);
  const checks: Check[] = [];
  const missing: Pkg[] = [];
  const hint = (pkg: Pkg) => {
    // The command --install would run, unattended; otherwise the one to run yourself.
    const plan = installPlan(pkg, m, !ctx.mode.interactive && !ctx.mode.check);
    return plan.steps.length ? `${t("Install", "安装")}: ${plan.text}` : plan.text;
  };

  // L1: the ssh client.
  const ssh = sshCommand(ctx);
  const sshPath = ctx.which(ssh.argv[0]!);
  if (!ssh.isSsh) {
    checks.push({ id: "L1", status: "info", label: "ssh", detail: t(`CC_REMOTE_SSH is ${ssh.argv[0]}, not ssh: the ssh-specific checks are skipped`, `CC_REMOTE_SSH 是 ${ssh.argv[0]}，不是 ssh：跳过 ssh 相关的检查`) });
  } else if (!sshPath) {
    missing.push("ssh");
    checks.push({ id: "L1", status: "fail", label: "ssh", detail: t("not found", "未找到"), remedy: [hint("ssh")], pkg: "ssh" });
  } else {
    const v = await ctx.run([sshPath, "-V"], { timeoutMs: 10_000 });
    const version = `${v.stderr}${v.stdout}`.match(/OpenSSH[_\w.-]*/)?.[0];
    checks.push({ id: "L1", status: "pass", label: "ssh", detail: version ?? ctx.tilde(sshPath) });
  }

  // L2: cc-remote itself, which Orca's Claude Command must name by its stable path.
  const l = layout(ctx.env, ctx.platform);
  const state = installed(l);
  const stable = ctx.tilde(l.stable);
  const onPath = ctx.onPath(dirname(l.stable));
  const pathHint = t(`not on PATH; add ${dirname(stable)} to PATH in your shell profile (setup doesn't edit it): export PATH="${dirname(l.stable)}:$PATH"`, `不在 PATH 上；请在 shell 配置中把 ${dirname(stable)} 加入 PATH（setup 不会修改它）：export PATH="${dirname(l.stable)}:$PATH"`);
  if (state.kind === "managed") {
    const remedy: string[] = [];
    let status: Check["status"] = "pass";
    const notes = [t("managed", "受管理"), onPath ? t("on PATH", "在 PATH 上") : t("not on PATH", "不在 PATH 上")];
    const problems: string[] = [];
    if (!onPath) { status = "warn"; remedy.push(pathHint); problems.push(t("not on PATH", "不在 PATH 上")); }
    const self = ctx.self.compiled ? realpath(ctx.self.execPath) : undefined;
    if (self !== realpath(binary(l, state.version))) {
      status = "warn";
      notes.push(ctx.self.compiled ? t(`this run is ${ctx.tilde(ctx.self.execPath)}`, `本次运行的是 ${ctx.tilde(ctx.self.execPath)}`) : t("this run is from source", "本次从源码运行"));
      problems.push(notes.at(-1)!);
    }
    const invalid = validateCommand(`${l.stable} claude`);
    if ("error" in invalid) { status = "warn"; remedy.push(t(`Orca can't run ${stable}: ${invalid.error}`, `Orca 无法运行 ${stable}：${invalid.error}`)); }
    checks.push({ id: "L2", status, label: "cc-remote", detail: t(`${state.version} at ${stable} (${notes.join(", ")})`, `${state.version}，位于 ${stable}（${notes.join("，")}）`), remedy, short: problems.length ? `cc-remote ${problems.join(", ")}` : undefined });
  } else {
    const where = ctx.self.compiled ? ctx.tilde(ctx.self.execPath) : t("bun, from source", "bun，从源码运行");
    checks.push({
      id: "L2", status: "warn", label: "cc-remote",
      detail: state.kind === "absent"
        ? t(`not installed at ${stable} (this is ${where}): updates and Orca's command need the managed install`, `${stable} 未安装（当前是 ${where}）：更新和 Orca 的命令需要受管理的安装`)
        : t(`${state.detail}: updates and Orca's command would follow a moving target`, `${state.detail}：更新和 Orca 的命令会指向一个会变的位置`),
      remedy: [t("Install with: curl -fsSL https://raw.githubusercontent.com/specialpointcentral/cc-remote/main/install.sh | sh", "安装：curl -fsSL https://raw.githubusercontent.com/specialpointcentral/cc-remote/main/install.sh | sh")],
    });
  }

  // L3: ripgrep, which Grep and Glob use; Grep falls back to grep.
  const rg = ctx.which("rg");
  if (rg) {
    const v = await ctx.run([rg, "--version"], { timeoutMs: 10_000 });
    checks.push({ id: "L3", status: "pass", label: "rg", detail: v.stdout.split("\n")[0]?.trim() || ctx.tilde(rg) });
  } else {
    missing.push("ripgrep");
    const grep = ctx.platform !== "win32" && ctx.which("grep");
    checks.push({
      id: "L3", status: grep ? "warn" : "fail", label: "rg",
      detail: grep ? t("not found: Grep falls back to grep (no --type, no multiline)", "未找到：Grep 退回到 grep（没有 --type，不支持多行）") : t("not found, and no grep either: Grep can't run", "未找到，也没有 grep：Grep 无法运行"),
      remedy: [hint("ripgrep")],
      short: t("rg not found", "rg 未找到"),
      pkg: "ripgrep",
    });
  }

  // L4: the shell local Bash commands run in.
  if (ctx.platform === "win32") {
    const pwsh = ctx.which("pwsh");
    checks.push(pwsh
      ? { id: "L4", status: "pass", label: "shell", detail: "PowerShell 7 (pwsh)" }
      : { id: "L4", status: "warn", label: "shell", detail: t("only Windows PowerShell 5.1", "只有 Windows PowerShell 5.1"), remedy: ["winget install --id Microsoft.PowerShell -e"] });
  } else {
    const shell = loginShell(ctx.env);
    if (shell.kind) checks.push({ id: "L4", status: "pass", label: "shell", detail: `${shell.path} (${t("login shell", "登录 shell")})` });
    else if (ctx.which("bash")) {
      const own = ctx.env.SHELL || safeShell();
      checks.push({ id: "L4", status: "warn", label: "shell", detail: t(`${own || "your login shell"} isn't bash or zsh: Bash commands run in bash instead`, `${own || "登录 shell"} 不是 bash 或 zsh：Bash 命令改在 bash 中运行`) });
    } else {
      missing.push("bash");
      checks.push({ id: "L4", status: "fail", label: "shell", detail: t("no bash: local Bash commands can't run", "没有 bash：本地 Bash 命令无法运行"), remedy: [hint("bash")], pkg: "bash" });
    }
  }

  // L5: git, for the git status Claude gets and its git commands.
  const git = ctx.which("git");
  if (git) {
    const v = await ctx.run([git, "--version"], { timeoutMs: 10_000 });
    checks.push({ id: "L5", status: "pass", label: "git", detail: v.stdout.match(/\d+\.\d+[\w.]*/)?.[0] ?? ctx.tilde(git) });
  } else {
    missing.push("git");
    checks.push({ id: "L5", status: "warn", label: "git", detail: t("not found: no git status for Claude, and git commands fail", "未找到：Claude 拿不到 git 状态，git 命令会失败"), remedy: [hint("git")], short: t("git not found", "git 未找到"), pkg: "git" });
  }

  // L6: the hostname, which names this machine's folders on the central server.
  const name = hostname();
  checks.push(!name || GENERIC.test(name)
    ? { id: "L6", status: "warn", label: "hostname", detail: t(`"${name}" is generic: another project machine with the same name would share its folders on the central server`, `"${name}" 过于通用：同名的另一台项目机器会在中心服务器上共用目录`), remedy: [hostnameAdvice(ctx.platform)] }
    : { id: "L6", status: "pass", label: "hostname", detail: name });

  // L7: where the host comes from. Orca Server doesn't read shell profiles.
  const file = `${ctx.config}/host`;
  const saved = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  const parts = [saved ? `${t("host file", "host 文件")}: ${saved}` : "", ctx.env.CC_REMOTE_HOST ? `CC_REMOTE_HOST=${ctx.env.CC_REMOTE_HOST}` : "", ctx.env.CC_REMOTE_SSH ? `CC_REMOTE_SSH=${ctx.env.CC_REMOTE_SSH}` : ""].filter(Boolean);
  checks.push(ctx.mode.check && !saved && ctx.env.CC_REMOTE_HOST
    ? { id: "L7", status: "warn", label: "config", detail: t("only CC_REMOTE_HOST is set, which Orca Server doesn't see", "只设置了 CC_REMOTE_HOST，Orca Server 看不到它"), remedy: ["cc-remote setup"] }
    : { id: "L7", status: "info", label: "config", detail: parts.join(", ") || t("no host configured yet", "尚未配置主机") });

  // L8: connection sharing, whose socket lives in /tmp under a length limit.
  if (ctx.platform !== "win32" && ssh.isSsh) {
    const socket = `/tmp/cc-remote-${safeUid()}-${"x".repeat(40)}`;
    let writable = true;
    try {
      accessSync("/tmp", constants.W_OK);
    } catch {
      writable = false;
    }
    checks.push(writable && socket.length < 104
      ? { id: "L8", status: "pass", label: "sharing", detail: t("one shared ssh connection (ControlMaster)", "共享一条 ssh 连接（ControlMaster）") }
      : { id: "L8", status: "warn", label: "sharing", detail: t("/tmp isn't writable: every session opens its own ssh connection", "/tmp 不可写：每个会话都会单独建立 ssh 连接") });
  }

  // L9: the version cache, which spares Orca's per-chat `--version` an ssh round trip.
  let dir = versionCache.dir;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  let cacheOk = true;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    cacheOk = false;
  }
  checks.push(cacheOk
    ? { id: "L9", status: "pass", label: "cache", detail: ctx.tilde(versionCache.dir) }
    : { id: "L9", status: "warn", label: "cache", detail: t(`${ctx.tilde(versionCache.dir)} isn't writable: each Orca chat's version check costs an ssh round trip`, `${ctx.tilde(versionCache.dir)} 不可写：每个 Orca 聊天的版本检查都要走一次 ssh`) });

  return { checks, missing, machine: m, isSsh: ssh.isSsh };
}

function safeShell() {
  try {
    return userInfo().shell ?? "";
  } catch {
    return "";
  }
}

function safeUid() {
  try {
    return userInfo().uid;
  } catch {
    return 0;
  }
}
