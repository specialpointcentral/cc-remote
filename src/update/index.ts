import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../../package.json";
import { activate, asideFiles, assetName, binary, type Fs, type Install, type Installed, installed, type Layout, layout, readInstall, realFs, VERSION, writeInstall } from "../install/layout";
import { lock, privateDir } from "../setup/files";
import { call, discover, OrcaError } from "../setup/orca";
import { updateInstalledPlugin } from "../setup/orca-plugin";
import { detectLang, lang, setLang, t } from "../setup/ui/i18n";
import { inUse } from "./inuse";
import { sourceId, VERSION_ID } from "./local";
import { saveUpdateStatus, sourceDir, updateStatus } from "./notice";
import { checksumFor, download, latestVersion, sha256 } from "./release";

/**
 * `cc-remote update`: builds the source checkout (src/update/local.ts), or with --release downloads
 * a release, installs it beside the current version and switches the stable path to it, never
 * interrupting what runs (see src/install/layout.ts). Nothing is switched until the new binary ran
 * `--version` (and a release matched SHA256SUMS) and, when a central server is configured, ran
 * `doctor` there, which proves the server's claude is new enough for the new version. Old versions
 * are removed only once nothing runs them; the previous one stays for --rollback. Never automatic:
 * setup and doctor ask at a terminal, the Orca plugin has a button.
 */
const USAGE = {
  en: `Usage: cc-remote update [--check | --rollback] [--source <dir>] [--host <destination>] [--skip-host-check]
       cc-remote update --release [<v>] [--check] [--host <destination>] [--skip-host-check]

Builds cc-remote from its source checkout, installs the build beside the current one and switches
~/.local/bin/cc-remote to it. Running sessions and chats keep the version they started with; new
ones get the new version.

  (no option)         build the checkout this cc-remote was built from and switch to the build;
                      nothing changes when the checkout hasn't
  --check             show the installed build and the checkout's; change nothing
  --rollback          switch back to the previous version
  --source <dir>      build this checkout instead ($CC_REMOTE_SOURCE also names one)
  --release [<v>]     install a GitHub release instead of building: the latest, or version <v>
  --orca-plugin only|skip
                      only bring an installed Orca usage plugin up to this build's, or leave it as
                      it is (by default an update brings an installed one up to the new build's)
  --orca-profile <dir>
                      the Orca the plugin is in, as setup names it ($CC_REMOTE_ORCA_PROFILE)
  --host <destination>
                      the central server whose claude the new build is checked against
                      ($CC_REMOTE_HOST, else the host file)
  --skip-host-check   switch even when the central server can't be reached to check its claude
                      (a server that answers with a claude that is too old still stops the update)
  --lang en|zh        language of the messages

Exit status 3: cc-remote was updated, but the Orca usage plugin wasn't.`,
  zh: `用法：cc-remote update [--check | --rollback] [--source <目录>] [--host <目标>] [--skip-host-check]
      cc-remote update --release [<版本>] [--check] [--host <目标>] [--skip-host-check]

从源码目录编译 cc-remote，安装在当前版本旁边，并把 ~/.local/bin/cc-remote 切换过去。
正在运行的会话和聊天继续使用启动时的版本；之后新开的才会用新版本。

  （无选项）          编译当前 cc-remote 所来自的源码目录并切换过去；源码没变时什么也不做
  --check             显示已安装的版本和源码现在的版本；不做任何改动
  --rollback          切回上一个版本
  --source <目录>     改为编译这个源码目录（也可用 $CC_REMOTE_SOURCE 指定）
  --release [<版本>]  不编译，改为安装 GitHub 发布版本：最新版本，或指定的版本
  --orca-plugin only|skip
                      只把 Orca 中已安装的用量插件更新到本版本内置的，或不动它
                      （默认：更新后把已安装的插件更新到新版本内置的）
  --orca-profile <目录>
                      插件所在的 Orca，与 setup 的同名选项相同（$CC_REMOTE_ORCA_PROFILE）
  --host <目标>
                      用新版本检查哪台中心服务器的 claude（$CC_REMOTE_HOST，否则用 host 文件）
  --skip-host-check   中心服务器连不上、无法检查其 claude 时也照样切换
                      （服务器能连上但 claude 太旧时，仍会停止更新）
  --lang en|zh        提示信息的语言

退出状态 3：cc-remote 已更新，但 Orca 用量插件没有更新。`,
};

/** `orcaPlugin`: an installed Orca usage plugin follows an update (auto), is all that's updated (only), or is left (skip). */
type Options = { check: boolean; version?: string; rollback: boolean; release: boolean; source?: string; host?: string; orcaPlugin: "auto" | "only" | "skip"; orcaProfile?: string; skipHostCheck: boolean; help: boolean; lang?: string };

class Usage extends Error {}

function parse(argv: string[]): Options {
  const o: Options = { check: false, rollback: false, release: false, orcaPlugin: "auto", skipHostCheck: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Usage(`${flag} needs a value`);
      return v;
    };
    if (flag === "--check") o.check = true;
    else if (flag === "--rollback") o.rollback = true;
    else if (flag === "--skip-host-check") o.skipHostCheck = true;
    else if (flag === "--release") {
      // A version may follow, as in `--release 0.3.1` or `--release=0.3.1`: none is the latest.
      o.release = true;
      const v = inline ?? (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-") ? argv[++i] : undefined);
      if (v !== undefined) o.version = v.replace(/^v/, "");
    }
    else if (flag === "--host") o.host = value();
    else if (flag === "--source") o.source = value();
    else if (flag === "--orca-profile") o.orcaProfile = value();
    else if (flag === "--orca-plugin") {
      const v = value();
      if (v !== "auto" && v !== "only" && v !== "skip") throw new Usage(`--orca-plugin takes auto, only or skip, not ${v}`);
      o.orcaPlugin = v;
    }
    else if (flag === "--lang") o.lang = value();
    else if (flag === "-h" || flag === "--help") o.help = true;
    else throw new Usage(`unknown argument ${a}`);
  }
  if (o.version !== undefined && !VERSION.test(o.version)) throw new Usage(`--release takes a version such as 0.3.1, not ${o.version}`);
  if ([o.check, o.rollback, o.version !== undefined].filter(Boolean).length > 1) throw new Usage("use only one of --check, --release <v> and --rollback");
  if (o.source !== undefined && (o.release || o.rollback)) throw new Usage("--source names what to build: it doesn't go with --release or --rollback");
  if (o.orcaPlugin === "only" && (o.check || o.rollback || o.release || o.source !== undefined)) throw new Usage("--orca-plugin only goes on its own");
  if (o.lang !== undefined && o.lang !== "en" && o.lang !== "zh") throw new Usage("--lang takes en or zh");
  return o;
}

export type UpdateIo = {
  env?: Record<string, string | undefined>;
  out?: { write(text: string): unknown };
  platform?: NodeJS.Platform;
  arch?: string;
  /** The running cc-remote: a compiled binary and its path, or a source checkout. */
  self?: { compiled: boolean; execPath: string };
  fs?: Fs;
  now?: () => number;
  /** Builds a checkout and returns the binary it made; tests stand in for bun. */
  build?: Builder;
};

export type Builder = (source: string, env: Record<string, string | undefined>, say: (s: string) => void, out: string) => Promise<string>;

const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");

/** Runs a binary and returns its exit code and output, both streams together. */
async function run(argv: string[], env: Record<string, string | undefined>, timeoutMs: number, cwd?: string): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  } catch (e) {
    return { code: 127, out: (e as Error).message };
  }
}

/** The central server: --host, else CC_REMOTE_HOST, else the host file. */
export function configuredHost(env: Record<string, string | undefined>, home: string, flag?: string): string | undefined {
  if (flag?.trim()) return flag.trim();
  if (env.CC_REMOTE_HOST?.trim()) return env.CC_REMOTE_HOST.trim();
  try {
    return readFileSync(join(home, ".config", "cc-remote", "host"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What a binary is: the version `--version` leads with, when it runs and says it is cc-remote. */
async function versionOf(bin: string, env: Record<string, string | undefined>): Promise<{ id?: string; out: string }> {
  const { code, out } = await run([bin, "--version"], env, 30_000);
  const id = out.trimStart().match(/^(\S+) \(cc-remote/)?.[1];
  return { id: code === 0 && id && VERSION.test(id) ? id : undefined, out: out.trim().slice(0, 300) };
}

/** Whether a binary runs and says it is this version of cc-remote. */
async function sane(bin: string, version: string, env: Record<string, string | undefined>) {
  const { id, out } = await versionOf(bin, env);
  return { ok: id === version, out };
}

/**
 * Removes versions that are neither current nor previous and that nothing runs any more. The
 * switch is done by then: a version that can't be removed is only said, not an error.
 */
function cleanup(l: Layout, keep: string[], say: (s: string) => void, platform: NodeJS.Platform, fs: Fs) {
  let names: string[] = [];
  try {
    names = readdirSync(l.versions);
  } catch {}
  for (const name of names) {
    if (keep.includes(name)) continue;
    const dir = join(l.versions, name);
    const used = inUse(dir, platform);
    if (used === false) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        say(t(`  kept ${name}: could not remove it (${(e as Error).message})`, `  保留 ${name}：无法删除（${(e as Error).message}）`));
      }
    } else if (VERSION.test(name)) say(used ? t(`  kept ${name}: still running`, `  保留 ${name}：仍在运行`) : t(`  kept ${name}: can't tell whether it still runs`, `  保留 ${name}：无法判断是否仍在运行`));
  }
  if (l.windows) {
    for (const file of asideFiles(l, safeList(dirname(l.stable)))) {
      try {
        fs.remove(file);
      } catch {}
    }
  }
}

const safeList = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export async function main(argv: string[], io: UpdateIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? process.stdout;
  const platform = io.platform ?? process.platform;
  const fs = io.fs ?? realFs;
  const now = io.now ?? Date.now;
  const self = io.self ?? { compiled: COMPILED, execPath: process.execPath };
  const say = (s = "") => out.write(`${s}\n`);
  let o: Options;
  try {
    o = parse(argv);
  } catch (e) {
    setLang(detectLang(env));
    if (!(e instanceof Usage)) throw e;
    out.write(`cc-remote update: ${e.message}. ${t("See cc-remote update --help", "参见 cc-remote update --help")}\n`);
    return 2;
  }
  setLang(detectLang(env, o.lang));
  if (o.help) {
    say(t(USAGE.en, USAGE.zh));
    return 0;
  }
  // Before the update lock: an update in progress runs this with the new build.
  if (o.orcaPlugin === "only") return updateOrcaPlugin(env, platform, say, o.orcaProfile);
  const l = layout(env, platform);
  const state = installed(l);
  const info = readInstall(l);
  const current = state.kind === "managed" ? state.version : undefined;

  const source = o.source ?? sourceDir(env);
  if (o.check && !o.release) return check(state.kind === "unmanaged" ? undefined : (current ?? VERSION_ID), l.stable, source, env, say, now);
  if (o.check) {
    say(t(`installed: ${current ?? pkg.version}${current ? ` (${l.stable})` : " (not installed with install.sh)"}`, `已安装：${current ?? pkg.version}${current ? `（${l.stable}）` : "（不是用 install.sh 安装的）"}`));
    try {
      const latest = await latestVersion(env);
      say(t(`latest:    ${latest}`, `最新版本：${latest}`));
      const mine = current ?? pkg.version;
      say(latest === mine ? t("Up to date.", "已是最新。") : t(`Update available: cc-remote update`, `有新版本：cc-remote update`));
      return 0;
    } catch (e) {
      say(t(`Could not look up the latest release: ${(e as Error).message}`, `无法查询最新版本：${(e as Error).message}`));
      return 1;
    }
  }

  // A build from source may replace a copied or linked binary (it keeps that as the previous version).
  if (state.kind === "unmanaged" && (o.release || l.windows)) {
    say(t(
      `cc-remote update: this cc-remote isn't managed by install.sh (${state.detail}). If it was installed from source: \`git pull && bun run compile\`; or reinstall with install.sh.`,
      `cc-remote update：当前 cc-remote 不是由 install.sh 管理的（${state.detail}）。若是从源码安装：\`git pull && bun run compile\`；或用 install.sh 重新安装。`,
    ));
    return 1;
  }
  if (o.release && state.kind === "absent" && (!self.compiled || /[\\/]dist[\\/]cc-remote/.test(realpath(self.execPath)))) {
    say(t(
      "cc-remote update: this cc-remote runs from source. Update it with `git pull && bun run compile`, or install a release with install.sh.",
      "cc-remote update：当前 cc-remote 从源码运行。请用 `git pull && bun run compile` 更新，或用 install.sh 安装发布版本。",
    ));
    return 1;
  }

  privateDir(l.root);
  const release = lock(l.lock);
  if (!release) {
    say(t("cc-remote update: another update is running.", "cc-remote update：另一个更新正在进行。"));
    return 1;
  }
  try {
    if (o.rollback) return await rollback(l, current, info.previous, env, say, fs, now);
    if (o.release) return await update(l, o, current, env, say, platform, io.arch ?? process.arch, fs, now);
    return await updateFromSource(l, o, state, source, env, say, platform, fs, now, io.build ?? buildSource);
  } catch (e) {
    if (e instanceof Switched) say(`cc-remote update: ${e.message}${t(".", "。")}`);
    else say(t(`cc-remote update: ${(e as Error).message}. Nothing was switched.`, `cc-remote update：${(e as Error).message}。没有切换任何版本。`));
    return 1;
  } finally {
    release();
  }
}

/** The stable path was switched, but install.json couldn't say so, nor could the switch be undone. */
class Switched extends Error {}

/**
 * Switches the stable path from `from` (none: nothing was there) to `to`, and records it in
 * install.json. When the record can't be written the switch is undone, so that what runs and
 * what install.json says agree, and the error is the record's; when even that fails, a Switched
 * error says what happened.
 */
function switchTo(l: Layout, fs: Fs, now: number, from: string | undefined, to: string, record: Install) {
  activate(l, to, fs, now);
  try {
    writeInstall(l, record);
  } catch (e) {
    const why = (e as Error).message;
    try {
      // A later stamp: on Windows the file moved aside by the switch keeps its name.
      if (from) activate(l, from, fs, now + 1);
      else fs.remove(l.stable);
    } catch (undo) {
      throw new Switched(t(
        `switched to ${to}, but could not record it in ${l.installJson} (${why}), nor switch back (${(undo as Error).message})`,
        `已切换到 ${to}，但无法写入 ${l.installJson}（${why}），也无法切回（${(undo as Error).message}）`,
      ));
    }
    throw new Error(t(`could not write ${l.installJson}: ${why}`, `无法写入 ${l.installJson}：${why}`));
  }
}

function realpath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function rollback(l: Layout, current: string | undefined, previous: string | undefined, env: Record<string, string | undefined>, say: (s: string) => void, fs: Fs, now: () => number) {
  if (!current || !previous || !existsSync(binary(l, previous))) {
    say(t("cc-remote update: there is no previous version to go back to.", "cc-remote update：没有可以切回的上一个版本。"));
    return 1;
  }
  // A copied binary kept under a taken name (keepUnmanaged) still says its own version.
  const check = await sane(binary(l, previous), previous.replace(/-kept\.\d+$/, ""), env);
  if (!check.ok) {
    say(t(`cc-remote update: ${previous} doesn't run (${check.out || "no output"}). Nothing was switched.`, `cc-remote update：${previous} 无法运行（${check.out || "无输出"}）。没有切换任何版本。`));
    return 1;
  }
  const at = now();
  switchTo(l, fs, at, current, previous, { current: previous, previous: current, installedAt: new Date(at).toISOString() });
  switched(previous, env);
  say(t(`Rolled back ${current} → ${previous}. Running sessions keep ${current} until they end.`, `已回退 ${current} → ${previous}。正在运行的会话结束前继续使用 ${current}。`));
  return 0;
}

async function update(l: Layout, o: Options, current: string | undefined, env: Record<string, string | undefined>, say: (s: string) => void, platform: NodeJS.Platform, arch: string, fs: Fs, now: () => number) {
  const asset = assetName(platform, arch);
  if (!asset) throw new Error(t(`there is no release build for ${platform}-${arch}`, `没有适用于 ${platform}-${arch} 的发布版本`));
  const target = o.version ?? (await latestVersion(env));
  if (target === current) {
    say(t(`cc-remote ${target} is installed and current.`, `cc-remote ${target} 已安装且为当前版本。`));
    return 0;
  }
  say(t(`Downloading cc-remote ${target} (${asset})…`, `正在下载 cc-remote ${target}（${asset}）…`));
  privateDir(l.versions);
  const dir = join(l.versions, target);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  privateDir(partial);
  const bin = basename(binary(l, target));
  try {
    await download(target, asset, join(partial, asset), env);
    await download(target, "SHA256SUMS", join(partial, "SHA256SUMS"), env);
    const expected = checksumFor(readFileSync(join(partial, "SHA256SUMS"), "utf8"), asset);
    if (!expected) throw new Error(t(`SHA256SUMS has no entry for ${asset}`, `SHA256SUMS 里没有 ${asset}`));
    const actual = await sha256(join(partial, asset));
    if (actual !== expected) throw new Error(t(`${asset} doesn't match SHA256SUMS (expected ${expected}, got ${actual}); deleted it`, `${asset} 与 SHA256SUMS 不符（应为 ${expected}，实际 ${actual}）；已删除`));
    renameSync(join(partial, asset), join(partial, bin));
    chmodSync(join(partial, bin), 0o755);
    if (existsSync(dir)) {
      // A version kept from before, or one that failed its checks last time: use it only if it
      // is exactly this download, else move it aside for cleanup.
      if (existsSync(binary(l, target)) && (await sha256(binary(l, target))) === actual) rmSync(partial, { recursive: true, force: true });
      else {
        renameSync(dir, `${dir}.old-${now()}`);
        renameSync(partial, dir);
      }
    } else renameSync(partial, dir);
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    throw e;
  }

  const check = await sane(binary(l, target), target, env);
  if (!check.ok) {
    say(t(`cc-remote update: the new binary didn't report ${target} (${check.out || "no output"}). It stays in ${dir}, not switched to.`, `cc-remote update：新版本没有报告 ${target}（${check.out || "无输出"}）。它保留在 ${dir}，没有切换。`));
    return 1;
  }
  if (!(await promote(l, o, current, target, undefined, env, say, platform, fs, now))) return 1;
  switched(target, env);
  return 0;
}

/**
 * The end of every update: once the central server's claude suits the version in versions/<id>,
 * switches to it (install.json saying where it came from, `source`), keeps it and the one before,
 * and says so. False when it wasn't switched to.
 */
async function promote(l: Layout, o: Options, current: string | undefined, id: string, source: string | undefined, env: Record<string, string | undefined>, say: (s: string) => void, platform: NodeJS.Platform, fs: Fs, now: () => number): Promise<boolean> {
  if (!(await hostGate(binary(l, id), o, env, say))) return false;
  mkdirSync(dirname(l.stable), { recursive: true });
  const previous = current ?? readInstall(l).current;
  const at = now();
  switchTo(l, fs, at, current, id, { current: id, previous, installedAt: new Date(at).toISOString(), ...(source ? { source } : {}) });
  cleanup(l, [id, ...(previous ? [previous] : [])], say, platform, fs);
  say(current
    ? t(`Updated ${current} → ${id}. Running sessions keep ${current} until they end. Undo: cc-remote update --rollback`, `已更新 ${current} → ${id}。正在运行的会话结束前继续使用 ${current}。撤销：cc-remote update --rollback`)
    : t(`Installed cc-remote ${id} at ${l.stable}.`, `已在 ${l.stable} 安装 cc-remote ${id}。`));
  return true;
}

/**
 * Runs the new binary's doctor against the central server, which proves the server's claude is new
 * enough for it; false when the switch must not happen.
 */
async function hostGate(bin: string, o: Options, env: Record<string, string | undefined>, say: (s: string) => void): Promise<boolean> {
  const host = configuredHost(env, env.HOME || env.USERPROFILE || "", o.host);
  if (!host) {
    say(t("No central server is configured, so its claude wasn't checked against the new version.", "没有配置中心服务器，因此没有检查其 claude 是否满足新版本的要求。"));
    return true;
  }
  say(t(`Checking ${host} with the new version…`, `正在用新版本检查 ${host}…`));
  // The host as CC_REMOTE_HOST, which every build's doctor takes.
  const doctor = await run([bin, "doctor"], { ...env, CC_REMOTE_HOST: host, CC_REMOTE_NO_VERSION_CACHE: "1", CC_REMOTE_NO_UPDATE_CHECK: "1" }, 120_000);
  if (doctor.code === 0) return true;
  const reached = /^remote claude: /m.test(doctor.out);
  for (const line of doctor.out.trim().split("\n")) say(`  ${line}`);
  if (reached || !o.skipHostCheck) {
    say(reached
      ? t(`Not switched: update claude on ${host}, then run \`cc-remote update\` again.`, `没有切换：请先更新 ${host} 上的 claude，再运行 \`cc-remote update\`。`)
      : t(`Not switched: ${host} couldn't be checked. Fix the connection, or pass --skip-host-check to switch anyway.`, `没有切换：无法检查 ${host}。请修复连接，或加 --skip-host-check 强制切换。`));
    return false;
  }
  say(t(`${host} couldn't be checked; switching anyway (--skip-host-check).`, `无法检查 ${host}；按 --skip-host-check 照样切换。`));
  return true;
}

/** The saved update status, now about the version just switched to. */
function switched(id: string, env: Record<string, string | undefined>) {
  const status = updateStatus(env);
  if (status) saveUpdateStatus({ ...status, current: id }, env);
}

/** `installedId` undefined: the stable path holds a copied or linked binary, which an update replaces. */
async function check(installedId: string | undefined, stable: string, source: string | undefined, env: Record<string, string | undefined>, say: (s: string) => void, now: () => number) {
  say(installedId
    ? t(`installed: ${installedId}`, `已安装：${installedId}`)
    : t(`installed: ${stable} is a copied or linked binary; an update makes it a managed install`, `已安装：${stable} 是拷贝或链接的二进制；更新后会转为受管理的安装`));
  const latest = source ? await sourceId(source) : undefined;
  if (!source || !latest) {
    say(t(
      `No source checkout to build${source ? ` (${source} isn't one)` : ""}: pass --source <dir>.`,
      `没有可编译的源码目录${source ? `（${source} 不是）` : ""}：请用 --source <目录> 指定。`,
    ));
    return 1;
  }
  say(t(`source:    ${latest} (${source})`, `源码：  ${latest}（${source}）`));
  if (installedId) saveUpdateStatus({ current: installedId, latest, source, checkedAt: now() }, env);
  say(latest === installedId ? t("Up to date.", "已是最新。") : t("Update available: cc-remote update", "有新版本：cc-remote update"));
  return 0;
}

/** `bun install` (so a changed lockfile builds), then `bun run compile --out <out>`, in the checkout. */
async function buildSource(source: string, env: Record<string, string | undefined>, say: (s: string) => void, out: string): Promise<string> {
  const home = env.HOME || env.USERPROFILE || "";
  // Apps such as Orca start with a short PATH: look where bun's installers put it too.
  const bun = Bun.which("bun", { PATH: env.PATH ?? "" }) ?? [join(home, ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((p) => existsSync(p));
  if (!bun) throw new Error(t("building cc-remote needs bun (https://bun.sh), which isn't on PATH", "编译 cc-remote 需要 bun（https://bun.sh），但 PATH 中找不到"));
  const withBun = { ...env, PATH: `${dirname(bun)}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}` };
  for (const args of [["install", "--frozen-lockfile"], ["run", "compile", "--out", out]]) {
    const r = await run([bun, ...args], withBun, 15 * 60_000, source);
    if (r.code !== 0) {
      for (const line of r.out.trim().split("\n").slice(-15)) say(`  ${line}`);
      throw new Error(t(`\`bun ${args.join(" ")}\` failed in ${source}`, `在 ${source} 中运行 \`bun ${args.join(" ")}\` 失败`));
    }
  }
  return process.platform === "win32" ? `${out}.exe` : out;
}

/**
 * Keeps what a copied or linked binary at the stable path runs as a version of its own, so that the
 * switch to a managed install loses nothing and --rollback can go back to it. Under a name a version
 * already has, it gets a `-kept.<time>` suffix.
 */
async function keepUnmanaged(l: Layout, env: Record<string, string | undefined>, now: () => number): Promise<string> {
  const file = realpath(l.stable);
  const base = (await versionOf(file, env)).id ?? pkg.version;
  const id = existsSync(join(l.versions, base)) ? `${base}-kept.${now()}` : base;
  privateDir(join(l.versions, id));
  copyFileSync(file, binary(l, id));
  chmodSync(binary(l, id), 0o755);
  return id;
}

/**
 * Moves a build into versions/<id>, through a partial folder; a folder there already is moved aside.
 * A move, not a copy: the build is beside the versions, and the file it checked is the one installed.
 */
function installBuild(l: Layout, id: string, bin: string, now: () => number) {
  privateDir(l.versions);
  const dir = join(l.versions, id);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  privateDir(partial);
  try {
    renameSync(bin, join(partial, basename(binary(l, id))));
    chmodSync(join(partial, basename(binary(l, id))), 0o755);
    if (existsSync(dir)) renameSync(dir, `${dir}.old-${now()}`);
    renameSync(partial, dir);
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    throw e;
  }
}

/** The exit status of an update that switched while the Orca usage plugin didn't follow. */
const PLUGIN_NOT_UPDATED = 3;

async function updateFromSource(l: Layout, o: Options, state: Installed, source: string | undefined, env: Record<string, string | undefined>, say: (s: string) => void, platform: NodeJS.Platform, fs: Fs, now: () => number, build: Builder) {
  if (!source) throw new Error(t("no source checkout is known to build: pass --source <dir>", "不知道该编译哪个源码目录：请用 --source <目录> 指定"));
  let current = state.kind === "managed" ? state.version : undefined;
  if (state.kind === "unmanaged") {
    // A copied or linked binary first becomes a version of its own, and the stable path that copy:
    // the same program runs, and nothing a build writes (an older checkout's compile writes
    // dist/cc-remote whatever it's told) can replace it, or what --rollback goes back to.
    current = await keepUnmanaged(l, env, now);
    // Should install.json fail, the stable path stays on the copy: still the program that ran.
    switchTo(l, fs, now(), current, current, { current, previous: readInstall(l).current, installedAt: new Date(now()).toISOString(), source: "kept" });
    say(t(`Kept the cc-remote that was at ${l.stable} as ${current}, a managed install now (--rollback comes back to it).`, `原来位于 ${l.stable} 的 cc-remote 已保留为 ${current}，现在是受管理的安装（--rollback 可切回）。`));
  }
  const plugin = async (bin: string) => {
    if (platform !== "darwin") return 0;
    if (o.orcaPlugin === "skip") {
      say(t("  usage plugin: left as it is (--orca-plugin skip)", "  用量插件：保持不变（--orca-plugin skip）"));
      return 0;
    }
    return (await followPlugin(bin, env, say, o.orcaProfile)) ? 0 : PLUGIN_NOT_UPDATED;
  };
  // Built from the checkout just now: the installed version is its latest.
  const latest = (id: string) => saveUpdateStatus({ current: id, latest: id, source, checkedAt: now() }, env);
  const unchanged = async (id: string) => {
    latest(id);
    say(t(`cc-remote ${id} is installed and current.`, `cc-remote ${id} 已安装且为当前版本。`));
    return plugin(binary(l, id));
  };
  // The id the build would get, without building: a checkout that hasn't changed needs none.
  if (current && (await sourceId(source)) === current) return unchanged(current);

  say(t(`Building cc-remote from ${source}…`, `正在从 ${source} 编译 cc-remote…`));
  // Built beside the versions, not into the checkout's dist/.
  privateDir(l.versions);
  const scratch = join(l.versions, `.build-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  privateDir(scratch);
  let id: string;
  try {
    const out = join(scratch, "cc-remote");
    const bin = await build(source, env, say, out);
    if (!existsSync(bin)) throw new Error(t(`the checkout's compile didn't build to ${out}: it predates building with --out, so build it with \`bun run compile\` and run that build's \`update\``, `源码目录的编译没有输出到 ${out}：它早于 --out 的支持，请用 \`bun run compile\` 编译后运行该版本的 \`update\``));
    // Checked whole before anything goes by its version: a build that fails can't pass for current.
    // This is the check of the installed file too, which is this one moved.
    const built = await versionOf(bin, env);
    if (!built.id) throw new Error(t(`the build at ${bin} didn't run as cc-remote (${built.out || "no output"})`, `${bin} 处的编译结果没能作为 cc-remote 运行（${built.out || "无输出"}）`));
    id = built.id;
    if (id === current) return await unchanged(id);
    installBuild(l, id, bin, now);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!(await promote(l, o, current, id, `local:${source}`, env, say, platform, fs, now))) return 1;
  latest(id);
  return plugin(binary(l, id));
}

/**
 * The Orca usage plugin is in the binary: the installed build brings an installed plugin up to its
 * own (`update --orca-plugin only`), which installs none that isn't and touches nothing else Orca
 * or setup has, unlike a setup run. False when that didn't work: the switch stands, and is told
 * apart. An update calls a build newer than itself this way, so later builds keep taking it.
 */
async function followPlugin(bin: string, env: Record<string, string | undefined>, say: (s: string) => void, profile?: string): Promise<boolean> {
  const r = await run([bin, "update", "--orca-plugin", "only", ...(profile ? ["--orca-profile", profile] : []), "--lang", lang()], env, 5 * 60_000);
  for (const line of r.out.trim().split("\n").filter(Boolean)) say(`  ${line}`);
  if (r.code === 0) return true;
  say(t("cc-remote is updated, but the usage plugin isn't: retry with `cc-remote update`.", "cc-remote 已更新，但用量插件未更新：可运行 `cc-remote update` 重试。"));
  return false;
}

/** `--orca-plugin only`: the usage plugin in the Orca Server running here, up to this build's. */
async function updateOrcaPlugin(env: Record<string, string | undefined>, platform: NodeJS.Platform, say: (s: string) => void, profile?: string) {
  const label = t("usage plugin", "用量插件");
  if (platform !== "darwin") {
    say(t(`${label}: Orca's usage popover is for macOS; nothing to update`, `${label}：Orca 用量弹窗仅支持 macOS，无需更新`));
    return 0;
  }
  const home = env.HOME || env.USERPROFILE || "";
  // --orca-profile, else CC_REMOTE_ORCA_PROFILE, names the one Orca meant (profileCandidates); else any that runs here.
  const named = profile || env.CC_REMOTE_ORCA_PROFILE;
  const found = await discover(env, home, platform, profile);
  if (!found.live.length) {
    say(named
      ? t(`${label}: the Orca Server of ${named} isn't running; \`cc-remote setup\` updates it once it is`, `${label}：${named} 的 Orca Server 没有运行；运行后可用 \`cc-remote setup\` 更新`)
      : t(`${label}: Orca isn't running; \`cc-remote setup\` updates it once it is`, `${label}：Orca 没有运行；Orca 运行后可用 \`cc-remote setup\` 更新`));
    return 0;
  }
  if (found.live.length > 1) {
    say(t(`${label}: ${found.live.length} Orca Servers are running; name one with CC_REMOTE_ORCA_PROFILE=<dir>, or update it with \`cc-remote setup --orca-profile <dir>\``, `${label}：有 ${found.live.length} 个 Orca Server 在运行；请用 CC_REMOTE_ORCA_PROFILE=<目录> 指定，或用 \`cc-remote setup --orca-profile <目录>\` 更新`));
    return 1;
  }
  const rt = found.live[0]!;
  try {
    const r = await updateInstalledPlugin((method, params, timeoutMs) => call(rt, method, params, timeoutMs), home, platform, rt.appVersion, rt.desktopWindowStatus);
    say(`${label}: ${r.detail}`);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof OrcaError)) throw e;
    say(`${label}: ${e.message}`);
    return 1;
  }
}
