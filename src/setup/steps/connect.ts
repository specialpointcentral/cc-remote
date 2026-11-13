import { copyIdAllowed, hostKeyDecision, sshKeyDecision } from "../args";
import { chooseKey, copyId, hostPart, keygen, writeEntry } from "../actions/ssh";
import { sshCommand } from "../checks/local";
import type { Check, Ctx, Env, Result } from "../context";
import { readHistory } from "../history";
import { classifySsh, sshError } from "../remote-probe";
import { endStep, show } from "../report";
import { candidates, closest } from "../suggest";
import { t } from "../ui/i18n";

/**
 * Step 3, the connection, probed the way remote-harness's bootstrap does: BatchMode, a 10 s
 * connect timeout, no forwarding, a strict host key, no shared connection, so nothing cached
 * hides a problem. Then the same without ssh-agent, since Orca Server is a daemon that has none.
 * Each failure gets its fix offered: OpenSSH's own host-key prompt, a key for cc-remote copied
 * with ssh-copy-id, a managed Host block. A changed host key is never accepted.
 */
export type Connection = { ok: boolean; base: string[]; agentless: boolean };

/** The probe's ssh command, up to the destination. CC_REMOTE_SSH's own options come after ours. */
export function probeBase(ctx: Ctx, hostKey = "yes"): string[] {
  const ssh = sshCommand(ctx);
  if (!ssh.isSsh) return ssh.argv;
  const options = ["BatchMode=yes", "ConnectTimeout=10", "ClearAllForwardings=yes", `StrictHostKeyChecking=${hostKey}`, "UpdateHostKeys=no", "ControlMaster=no", "ControlPath=none"];
  return [ssh.argv[0]!, ...options.flatMap((o) => ["-o", o]), ...ssh.argv.slice(1), "-T"];
}

/** The environment without ssh-agent, as a daemon has it. */
export const withoutAgent = (env: Env): Env => ({ ...env, SSH_AUTH_SOCK: undefined, SSH_AGENT_PID: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined });

const attempt = (ctx: Ctx, host: string, hostKey: string, env?: Env): Promise<Result> =>
  ctx.run([...probeBase(ctx, hostKey), host, "true"], { env, timeoutMs: 45_000 });

/**
 * Makes ssh work without a password or an agent: a passphrase-less key (id_ed25519 when the user
 * has none, else cc-remote_ed25519 named in a managed Host block), copied with ssh-copy-id.
 */
async function fixAuth(ctx: Ctx, host: string): Promise<boolean> {
  const key = chooseKey(ctx.home);
  const pub = `${key.path}.pub`;
  const advice = ctx.platform === "win32"
    ? `type ${pub} | ssh ${host} "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"`
    : `ssh-copy-id -i ${ctx.tilde(pub)} ${host}`;
  const decision = sshKeyDecision(ctx.o, ctx.mode);
  if (decision === "skip") {
    ctx.progress.say(`        ${t("Fix", "修复")}: ${key.exists ? "" : `ssh-keygen -t ed25519 -N '' -f ${ctx.tilde(key.path)} && `}${advice}`);
    return false;
  }
  const block = !key.standard;
  if (block) ctx.progress.say(`        ${t(`${ctx.tilde(key.path)} goes into a managed Host block for ${hostPart(host)} in ~/.ssh/config (backed up first).`, `${ctx.tilde(key.path)} 会写入 ~/.ssh/config 中 ${hostPart(host)} 的受管理 Host 块（会先备份）。`)}`);
  if (decision === "ask-yes") {
    const question = key.exists
      ? t(`Copy ${ctx.tilde(key.path)} to ${host}?`, `把 ${ctx.tilde(key.path)} 复制到 ${host}？`)
      : t(`Create ${ctx.tilde(key.path)} (no passphrase) for cc-remote and copy it to ${host}?`, `为 cc-remote 创建 ${ctx.tilde(key.path)}（无密码）并复制到 ${host}？`);
    if (!(await ctx.prompt.yesNo(question, true))) return false;
  }
  if (!key.exists) {
    if (!(await keygen(ctx, key.path))) return false;
    ctx.record({ id: "ssh.keygen", value: key.path });
  }
  if (block) {
    const backup = writeEntry(ctx, { pattern: hostPart(host), identity: ctx.tilde(key.path) });
    ctx.record({ id: "ssh.config-block", value: { host: hostPart(host), identityFile: ctx.tilde(key.path) }, backup: backup ?? null });
    ctx.saved.push(t("~/.ssh/config (managed block)", "~/.ssh/config（受管理的块）"));
  }
  if (!copyIdAllowed(ctx.o, ctx.mode) || ctx.platform === "win32") {
    ctx.progress.say(`        ${t("Copy the key to the server yourself (it needs the password):", "请自行把密钥复制到服务器（需要密码）：")} ${advice}`);
    return true;
  }
  ctx.progress.say(t(`  ssh-copy-id may ask for ${host}'s password (typed into ssh, never into cc-remote)`, `  ssh-copy-id 可能会要求输入 ${host} 的密码（输入给 ssh，而不是 cc-remote）`));
  const ok = await copyId(ctx, pub, host);
  ctx.record({ id: "ssh.copy-id", value: host, key: pub, ok });
  if (!ok) ctx.progress.say(`        ${ctx.term.mark("fail")} ${t(`ssh-copy-id failed; to try again yourself: ${advice}`, `ssh-copy-id 失败；可以自己重试：${advice}`)}`);
  return ok;
}

export async function stepConnect(ctx: Ctx, host: string, isSsh: boolean): Promise<Connection> {
  const label = ctx.mode.check ? `ssh ${host}` : t(`Connecting to ${host}`, `连接 ${host}`);
  ctx.progress.begin(label);
  if (!isSsh) {
    const r = await ctx.run([...probeBase(ctx), host, "true"], { timeoutMs: 45_000 });
    const check: Check = r.code === 0
      ? { id: "R1", status: "pass", label: "ssh", detail: t(`through CC_REMOTE_SSH, ${r.ms} ms`, `通过 CC_REMOTE_SSH，${r.ms} ms`) }
      : { id: "R1", status: "fail", label: "ssh", detail: sshError(r.stderr) || t(`exit ${r.code}`, `退出码 ${r.code}`) };
    endStep(ctx, "connect", [check], label, check.detail);
    return { ok: r.code === 0, base: probeBase(ctx), agentless: true };
  }

  const keyDecision = hostKeyDecision(ctx.o, ctx.mode);
  const hostKey = keyDecision === "accept-new" ? "accept-new" : "yes";
  let r = await attempt(ctx, host, hostKey);
  const tried = new Set<string>();
  // Set once the step's line says it failed, before a fix is offered; a fix takes it up again.
  let ended = false;
  const end = (detail: string) => {
    ctx.progress.end("fail", detail, label);
    ended = true;
  };
  const again = () => {
    ctx.progress.again();
    ended = false;
  };
  while (r.code !== 0) {
    const kind = classifySsh(r.stderr);
    const fail = (detail: string, remedy: string[]) => {
      const check: Check = { id: "R1", status: "fail", label: "ssh", detail, remedy };
      if (!ended) endStep(ctx, "connect", [check], label, detail);
      else {
        ctx.results.set("connect", [check]);
        for (const line of remedy) ctx.progress.say(`        ${line}`);
      }
      return { ok: false, base: probeBase(ctx, hostKey), agentless: false };
    };
    if (tried.has(kind)) return fail(sshError(r.stderr), []);
    tried.add(kind);
    if (kind === "changed") {
      return fail(t(`${host}'s host key has CHANGED`, `${host} 的主机密钥已经改变`), [
        t("This can mean someone is intercepting the connection. cc-remote never accepts a changed key.", "这可能意味着有人在拦截连接。cc-remote 绝不接受改变了的密钥。"),
        t(`If you know why it changed (the server was reinstalled), remove the old key: ssh-keygen -R ${hostPart(host)}`, `如果你知道它为什么变了（例如服务器重装），删除旧密钥：ssh-keygen -R ${hostPart(host)}`),
      ]);
    }
    if (kind === "hostkey") {
      if (keyDecision !== "ask-yes") {
        return fail(t("the server's host key isn't trusted yet", "尚未信任服务器的主机密钥"), [ctx.mode.check
          ? t(`run \`ssh ${host}\` once to check and trust its key, or \`cc-remote setup\``, `运行一次 \`ssh ${host}\` 以核对并信任其密钥，或运行 \`cc-remote setup\``)
          : t(`pass --accept-new-host-key, or run \`ssh ${host}\` once to check and trust its key`, `加 --accept-new-host-key，或运行一次 \`ssh ${host}\` 以核对并信任其密钥`)]);
      }
      end(t("the server's host key isn't trusted yet", "尚未信任服务器的主机密钥"));
      if (!(await ctx.prompt.yesNo(t("Let OpenSSH show the fingerprint and ask you to trust it?", "让 OpenSSH 显示指纹并询问你是否信任？"), true))) {
        return fail(t("the server's host key isn't trusted", "未信任服务器的主机密钥"), []);
      }
      const ssh = sshCommand(ctx).argv;
      await ctx.interactive([ssh[0]!, "-o", "StrictHostKeyChecking=ask", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", ...ssh.slice(1), "-T", host, "true"]);
      again();
      r = await attempt(ctx, host, hostKey);
      continue;
    }
    if (kind === "denied" || kind === "toomany") {
      if (!ctx.mode.check) end(t("ssh refuses the login (no usable key)", "ssh 拒绝登录（没有可用的密钥）"));
      if (ctx.mode.check || !(await fixAuth(ctx, host))) {
        return fail(t("ssh refuses the login (no usable key)", "ssh 拒绝登录（没有可用的密钥）"), ctx.mode.check ? [t("Fix: cc-remote setup", "修复：cc-remote setup")] : []);
      }
      again();
      r = await attempt(ctx, host, hostKey);
      continue;
    }
    if (kind === "dns") {
      const near = closest(host, candidates(ctx.home, readHistory(ctx.home)));
      return fail(t(`${hostPart(host)} doesn't resolve`, `无法解析 ${hostPart(host)}`), near.length ? [t(`Did you mean: ${near.join(", ")}?`, `你是不是想输入：${near.join("、")}？`)] : []);
    }
    const why: Record<string, string> = {
      timeout: t("the connection timed out", "连接超时"),
      refused: t("the connection was refused (no ssh server on that port?)", "连接被拒绝（该端口没有 ssh 服务？）"),
      noroute: t("no route to the server", "无法路由到服务器"),
      kex: t("the server closed the connection during the handshake", "握手期间服务器关闭了连接"),
    };
    return fail(why[kind] ?? (sshError(r.stderr) || t(`ssh exited with ${r.code}`, `ssh 退出码 ${r.code}`)), why[kind] ? [sshError(r.stderr)].filter(Boolean) : []);
  }

  const ms = r.ms;
  // R2: without ssh-agent. Only meaningful when an agent is there to hide the difference.
  let agentless = true;
  if (ctx.env.SSH_AUTH_SOCK) agentless = (await attempt(ctx, host, hostKey, withoutAgent(ctx.env))).code === 0;
  const checks: Check[] = [
    { id: "R1", status: "pass", label: "ssh", detail: t(`key auth, ${ms} ms`, `密钥认证，${ms} ms`) },
    agentless
      ? { id: "R2", status: "pass", label: "no agent", detail: t("works without ssh-agent", "不依赖 ssh-agent 也能连接") }
      : { id: "R2", status: "warn", label: "no agent", detail: t("works through ssh-agent only; Orca Server has no ssh-agent", "只能通过 ssh-agent 连接；Orca Server 没有 ssh-agent"), short: t("ssh works through ssh-agent only", "ssh 只能通过 ssh-agent 连接") },
  ];
  endStep(ctx, "connect", checks, label, t(`key auth, ${ms} ms, works without ssh-agent`, `密钥认证，${ms} ms，不依赖 ssh-agent`), true);
  if (!agentless) show(ctx, checks[1]!);
  if (!agentless && !ctx.mode.check && (await fixAuth(ctx, host))) {
    agentless = (await attempt(ctx, host, hostKey, withoutAgent(ctx.env))).code === 0;
    const fixed: Check = agentless
      ? { id: "R2", status: "pass", label: "no agent", detail: t("works without ssh-agent now", "现在不依赖 ssh-agent 也能连接") }
      : { id: "R2", status: "warn", label: "no agent", detail: t("still works through ssh-agent only", "仍然只能通过 ssh-agent 连接"), remedy: [t("or copy CC_REMOTE_SSH with -i <key> into Orca's Claude environment (--orca-env)", "或把带 -i <密钥> 的 CC_REMOTE_SSH 复制到 Orca 的 Claude 环境变量（--orca-env）")] };
    show(ctx, fixed);
    ctx.results.set("connect", [checks[0]!, fixed]);
  }
  return { ok: true, base: probeBase(ctx, hostKey), agentless };
}
