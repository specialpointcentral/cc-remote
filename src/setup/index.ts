import { join } from "node:path";
import pkg from "../../package.json";
import { refreshLatest } from "../update/notice";
import { type Options, parseArgs, UsageError } from "./args";
import { autoOffered } from "./checks/remote";
import { Ctx, type Io } from "./context";
import { lock } from "./files";
import { counts, summary } from "./report";
import { newState, readState, writeState } from "./state";
import { stepCentral } from "./steps/central";
import { stepConnect } from "./steps/connect";
import { configuredHost, stepHost } from "./steps/host";
import { stepLocal } from "./steps/local";
import { stepOrca } from "./steps/orca";
import { stepSave } from "./steps/save";
import { stepVerify } from "./steps/verify";
import { detectLang, setLang, t } from "./ui/i18n";
import { Interrupted } from "./ui/prompt";

/**
 * `cc-remote setup`: checks this machine, connects to the central server, checks it, saves the
 * settings, configures Orca Server here and verifies the whole path the way Orca runs it. Safe to
 * run again: each change is detected, skipped when already in place, asked, made, and checked
 * again. `--check` only verifies and changes nothing.
 *
 * Exit status: 0 without failures (warnings allowed), 1 after a failure or an abort, 2 for usage
 * errors, 130 when interrupted.
 */
const USAGE = {
  en: `Usage: cc-remote setup [--host <destination>] [options]   check, connect, configure, verify
       cc-remote setup --check                              verify only; changes nothing

Sets up this machine to use claude on a central server, and Orca Server here to use cc-remote.
Nothing is installed or changed without asking; safe to run again.

  --check                      read-only: no installs, no prompts that change anything, no writes
  --host <destination>         the central server (ssh host, user@host, ~/.ssh/config alias);
                               else $CC_REMOTE_HOST, the host file, the last one used
  -y, --yes                    no prompts: take the defaults (never installs anything)
  --install                    allow installing missing tools here (sudo -n when not root)
  --ssh-key generate|skip      make a key for cc-remote when ssh needs a password or ssh-agent
  --copy-id                    allow ssh-copy-id (asks for the server's password)
  --accept-new-host-key        trust an unknown server key (a changed key is never accepted)
  --orca auto|set|skip         Orca's Claude Command: auto (default) changes it unattended only
                               from Orca's default or another cc-remote; set replaces any; skip
  --orca-profile <dir>         Orca's profile folder ($CC_REMOTE_ORCA_PROFILE)
  --orca-env                   copy CC_REMOTE_SSH and friends into Orca's Claude environment
  --orca-permission auto|keep  offer permission mode auto for Orca's Claude chats (default auto)
  --smoke                      afterwards, send one tiny real prompt (costs tokens)
  --lang en|zh                 language ($CC_REMOTE_LANG, else from the locale)
  --no-progress, --no-color    plain output ($CC_REMOTE_NO_PROGRESS=1, $NO_COLOR)
  -v, --verbose                show passing details too`,
  zh: `用法：cc-remote setup [--host <目标>] [选项]   检查、连接、配置、验证
      cc-remote setup --check                  只验证，不做任何改动

把本机设置为使用中心服务器上的 claude，并让本机的 Orca Server 使用 cc-remote。
未经询问不会安装或修改任何东西；可以随时重新运行。

  --check                      只读：不安装、不提出会改动任何东西的问题、不写任何文件
  --host <目标>                中心服务器（ssh 主机、user@host、~/.ssh/config 别名）；
                               否则用 $CC_REMOTE_HOST、host 文件、上次使用的值
  -y, --yes                    不提问：采用默认选择（绝不安装任何东西）
  --install                    允许在本机安装缺少的工具（非 root 时用 sudo -n）
  --ssh-key generate|skip      ssh 需要密码或 ssh-agent 时，为 cc-remote 生成密钥
  --copy-id                    允许 ssh-copy-id（会询问服务器密码）
  --accept-new-host-key        信任未知的服务器密钥（绝不接受改变了的密钥）
  --orca auto|set|skip         Orca 的 Claude Command：auto（默认）无人值守时只从 Orca 默认值
                               或其他 cc-remote 路径修改；set 总是替换；skip 不动
  --orca-profile <目录>        Orca 的 profile 目录（$CC_REMOTE_ORCA_PROFILE）
  --orca-env                   把 CC_REMOTE_SSH 等变量复制到 Orca 的 Claude 环境变量
  --orca-permission auto|keep  为 Orca 的 Claude 聊天提供 auto 权限模式（默认 auto）
  --smoke                      最后发送一次很小的真实提问（消耗 token）
  --lang en|zh                 语言（$CC_REMOTE_LANG，否则按 locale）
  --no-progress, --no-color    纯文本输出（$CC_REMOTE_NO_PROGRESS=1、$NO_COLOR）
  -v, --verbose                也显示通过项的详情`,
};

export async function main(argv: string[], io: Io = {}): Promise<number> {
  const env = io.env ?? process.env;
  let o: Options;
  try {
    o = parseArgs(argv, env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    setLang(detectLang(env));
    process.stderr.write(`cc-remote setup: ${e.message}. ${t("See cc-remote setup --help", "参见 cc-remote setup --help")}\n`);
    return 2;
  }
  setLang(detectLang(env, o.lang));
  const ctx = new Ctx(o, io, o.check ? 5 : 7);
  if (o.help) {
    ctx.term.line(t(USAGE.en, USAGE.zh));
    return 0;
  }
  let release: (() => void) | undefined;
  if (!o.check) {
    release = lock(join(ctx.config, "setup.lock"));
    if (!release) {
      ctx.term.line(t("cc-remote setup: another setup is running.", "cc-remote setup：另一个 setup 正在运行。"));
      return 1;
    }
  }
  // Ctrl-C outside a prompt, on the real terminal: stop the spinner before exiting.
  const onSignal = () => {
    ctx.progress.close();
    release?.();
    process.exit(130);
  };
  const real = !io.stdin || io.stdin === process.stdin;
  if (real) process.on("SIGINT", onSignal);
  try {
    return await run(ctx, o.check ? Promise.resolve() : refreshLatest(env));
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    ctx.progress.close();
    ctx.term.line(t("Interrupted.", "已中断。"));
    return 130;
  } finally {
    if (real) process.off("SIGINT", onSignal);
    release?.();
  }
}

async function run(ctx: Ctx, notice: Promise<void>): Promise<number> {
  const o = ctx.o;
  const previous = readState(ctx.home);
  const state = previous ?? newState();
  const first = !previous;
  // The first run shows every finding; re-runs and --check collapse what passed, unless -v.
  ctx.details = o.verbose || (first && !o.check);
  const last = previous?.lastRun ? ` (${t("last run", "上次运行")} ${previous.lastRun.slice(0, 16).replace("T", " ")}${previous.host ? `, ${previous.host}` : ""})` : "";
  if (!o.check) {
    ctx.term.header(`cc-remote setup ${pkg.version}${last}`);
    if (first) {
      ctx.term.line(t("This runs on this machine. Nothing is installed or changed without asking.", "本向导在本机运行。未经询问不会安装或修改任何东西。"));
      ctx.term.line(t("Re-run any time; `cc-remote setup --check` only verifies.", "可以随时重新运行；`cc-remote setup --check` 只做验证。"));
      ctx.term.line();
    }
  }

  const finish = async (code: number, facts: { distro?: string; os?: string } = {}, host?: string) => {
    await notice;
    summary(ctx, host, facts);
    if (!o.check && (code === 0 || ctx.actions.length)) {
      const c = counts(ctx);
      writeState(ctx.home, {
        ...state, lastRun: new Date(ctx.now()).toISOString(), ccRemote: pkg.version, host: host ?? state.host,
        actions: [...state.actions, ...ctx.actions], lastCheck: { at: new Date(ctx.now()).toISOString(), ...c },
      });
    }
    return counts(ctx).failed ? 1 : code;
  };

  // 1. This machine.
  const local = await stepLocal(ctx);

  // 2. The central server.
  const host = o.check ? configuredHost(ctx) : await stepHost(ctx, first);
  if (!host) {
    if (o.check) {
      ctx.progress.begin(t("ssh", "ssh"));
      ctx.progress.end("fail", t("no central server is configured: run cc-remote setup", "尚未配置中心服务器：请运行 cc-remote setup"));
      ctx.results.set("connect", [{ id: "R1", status: "fail", label: "ssh", detail: t("no central server configured", "尚未配置中心服务器") }]);
    }
    return finish(1);
  }

  // 3. Connecting.
  const conn = await stepConnect(ctx, host, local.isSsh);

  // 4. Checking the central server.
  const central = conn.ok ? await stepCentral(ctx, host, conn.base, previous?.machineId ?? (o.check ? undefined : state.machineId)) : undefined;
  const facts = { distro: `${central?.probe?.kv.DISTRO_ID ?? ""} ${central?.probe?.kv.DISTRO_LIKE ?? ""}`, os: central?.probe?.kv.OS };
  if (!conn.ok && o.check) {
    const detail = t("skipped: no connection", "已跳过：无法连接");
    ctx.progress.begin(host);
    ctx.progress.end("fail", detail);
    ctx.results.set("central", [{ id: "R0", status: "fail", label: host, detail, short: detail }]);
  }
  if (central?.abort && !o.check) {
    ctx.progress.say();
    const stopped = t("Setup stopped", "setup 已停止");
    ctx.term.line(central.abort.message.startsWith(stopped) ? central.abort.message : `${stopped}${t(": ", "：")}${central.abort.message}`);
    ctx.term.line(ctx.actions.length
      ? t("Nothing else was changed on this machine or in Orca.", "本机和 Orca 中没有做其他改动。")
      : t("Nothing was changed on this machine or in Orca.", "本机和 Orca 中没有做任何改动。"));
    await notice;
    // Changes made before the stop (an install, a key) are still recorded, for a later undo.
    if (ctx.actions.length) writeState(ctx.home, { ...state, lastRun: new Date(ctx.now()).toISOString(), ccRemote: pkg.version, actions: [...state.actions, ...ctx.actions] });
    return 1;
  }
  if (!o.check && (!conn.ok || !central?.ok)) return finish(1, facts, host);

  // 5. Saving.
  if (!o.check) await stepSave(ctx, host, conn.base, central!.probe!, state.machineId);

  // 6. Orca Server here.
  const orca = await stepOrca(ctx, central?.probe ? autoOffered(central.probe) : undefined);

  // 7. End to end.
  const ready = conn.ok && central?.ok;
  await stepVerify(ctx, orca, ready ? undefined : t(`${host} isn't ready`, `${host} 尚未就绪`));
  return finish(0, facts, host);
}
