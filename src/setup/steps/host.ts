import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeEntry } from "../actions/ssh";
import type { Ctx } from "../context";
import { readHistory } from "../history";
import { type Candidate, candidates, cleanHost, completer, type Flagged, parseFlagged, sshConfigHosts } from "../suggest";
import { t } from "../ui/i18n";

/**
 * Step 2, the central server: `--host`, else a prompt whose default is CC_REMOTE_HOST, the host
 * file, the last answer, or the only alias in ~/.ssh/config, in that order. The prompt offers up to
 * five numbered suggestions, Tab completion and history. A destination typed with ssh flags is
 * turned into `ssh://` or a managed Host block, since cc-remote takes a destination only.
 */
export function hostFile(ctx: Ctx): string | undefined {
  const file = join(ctx.config, "host");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

export function defaultHost(ctx: Ctx, history: string[]): string | undefined {
  const aliases = sshConfigHosts(ctx.home);
  return ctx.o.host ?? (ctx.env.CC_REMOTE_HOST?.trim() || undefined) ?? hostFile(ctx) ?? history[0] ?? (aliases.length === 1 ? aliases[0] : undefined);
}

/** Why a destination can't be used as one, if it can't. */
export function badDestination(dest: string): string | undefined {
  if (!dest) return t("empty", "为空");
  if (dest.startsWith("-")) return t("starts with -", "以 - 开头");
  if (/[\s"'`$;&|<>\\\0]/.test(dest)) return t("has spaces or shell characters", "含有空格或 shell 字符");
  return undefined;
}

/** The two ways to keep a flagged destination: an ssh:// URL (OpenSSH 7.7+), or a Host block. */
async function fromFlags(ctx: Ctx, input: string, f: Flagged): Promise<string | undefined> {
  if (f.unsupported.length) {
    ctx.progress.say(`  ${ctx.term.mark("warn")} ${t(`cc-remote takes a destination, not ssh options (${f.unsupported.join(" ")}). Put them in a Host block in ~/.ssh/config, then enter its name.`, `cc-remote 只接受目标地址，不接受 ssh 选项（${f.unsupported.join(" ")}）。请把它们写进 ~/.ssh/config 的 Host 块，然后输入它的名字。`)}`);
    return undefined;
  }
  const url = !f.identity && !f.jump ? `ssh://${f.user ? `${f.user}@` : ""}${f.host}${f.port ? `:${f.port}` : ""}` : undefined;
  const alias = `cc-remote-${f.host.replace(/[^A-Za-z0-9.-]/g, "-")}`;
  ctx.progress.say(`  ${ctx.term.mark("warn")} ${t(`"${input}" has ssh options; cc-remote takes a destination only:`, `"${input}" 含有 ssh 选项；cc-remote 只接受目标地址：`)}`);
  if (url) ctx.progress.say(`    1) ${url}   ${t("(OpenSSH 7.7 and later)", "（OpenSSH 7.7 及以上）")}`);
  ctx.progress.say(`    ${url ? 2 : 1}) ${t(`a Host block "${alias}" in ~/.ssh/config (backed up first)`, `在 ~/.ssh/config 中加一个 Host 块 "${alias}"（会先备份）`)}`);
  const answer = (await ctx.prompt.line(t("Choose", "请选择"), { def: "1" })).trim();
  if (url && answer === "1") return url;
  if (answer !== (url ? "2" : "1")) return undefined;
  const backup = writeEntry(ctx, { pattern: alias, hostName: f.host, user: f.user, port: f.port, identity: f.identity, jump: f.jump });
  ctx.record({ id: "ssh.config-block", value: { host: alias, hostName: f.host, user: f.user, port: f.port }, backup: backup ?? null });
  ctx.saved.push(t("~/.ssh/config (managed block)", "~/.ssh/config（受管理的块）"));
  return alias;
}

/** Asks for the central server, or takes it from the flags and files. Undefined: none. */
export async function stepHost(ctx: Ctx, first: boolean): Promise<string | undefined> {
  ctx.progress.begin(t("Central server", "中心服务器"), false);
  const history = readHistory(ctx.home);
  const def = defaultHost(ctx, history);
  let host: string | undefined;
  if (ctx.o.host || !ctx.mode.interactive) {
    host = def && cleanHost(def);
    const flagged = host && parseFlagged(host);
    if (flagged) {
      const url = !flagged.identity && !flagged.jump && !flagged.unsupported.length ? `ssh://${flagged.user ? `${flagged.user}@` : ""}${flagged.host}${flagged.port ? `:${flagged.port}` : ""}` : undefined;
      ctx.progress.end("fail", t(`--host takes a destination, not ssh options${url ? `: use --host ${url}` : "; put the options in a Host block in ~/.ssh/config"}`, `--host 只接受目标地址，不接受 ssh 选项${url ? `：请用 --host ${url}` : "；请把选项写进 ~/.ssh/config 的 Host 块"}`));
      return undefined;
    }
  } else {
    const list: Candidate[] = candidates(ctx.home, history);
    const shown = list.slice(0, 5);
    if (first) {
      ctx.progress.say();
      ctx.term.header(t("Central server", "中心服务器"));
      shown.forEach((c, i) => ctx.term.line(`  ${i + 1}) ${c.value.padEnd(16)} ${ctx.term.paint("dim", c.source)}`));
    }
    const label = first ? t("Central server (ssh host, user@host or ~/.ssh/config alias)", "中心服务器（ssh 主机、user@host 或 ~/.ssh/config 别名）") : t("Central server", "中心服务器");
    while (!host) {
      const raw = cleanHost(await ctx.prompt.line(label, { def, history, completer: completer(list) }));
      if (/^[1-5]$/.test(raw) && shown[Number(raw) - 1]) host = shown[Number(raw) - 1]!.value;
      else if (parseFlagged(raw)) host = await fromFlags(ctx, raw, parseFlagged(raw)!);
      else if (!raw) ctx.term.line(`  ${ctx.term.mark("warn")} ${t("A central server is needed.", "需要填写中心服务器。")}`);
      else if (badDestination(raw)) ctx.term.line(`  ${ctx.term.mark("warn")} ${t(`Not an ssh destination: ${badDestination(raw)}.`, `不是有效的 ssh 目标：${badDestination(raw)}。`)}`);
      else host = raw;
    }
  }
  if (!host || badDestination(host)) {
    ctx.progress.end("fail", host ? t(`not an ssh destination: ${host}`, `不是有效的 ssh 目标：${host}`) : t("no central server: pass --host <destination>", "没有中心服务器：请传入 --host <目标>"));
    return undefined;
  }
  ctx.progress.end("pass", undefined, `${t("Central server", "中心服务器")}: ${host}`);
  return host;
}

/** `--check`: the host without asking, or undefined when none is configured. */
export function configuredHost(ctx: Ctx): string | undefined {
  const h = defaultHost(ctx, readHistory(ctx.home));
  return h ? cleanHost(h) : undefined;
}
