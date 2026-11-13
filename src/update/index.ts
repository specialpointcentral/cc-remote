import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../../package.json";
import { activate, asideFiles, assetName, binary, type Fs, installed, type Layout, layout, readInstall, realFs, VERSION, writeInstall } from "../install/layout";
import { lock, privateDir } from "../setup/files";
import { detectLang, setLang, t } from "../setup/ui/i18n";
import { inUse } from "./inuse";
import { checksumFor, download, latestVersion, sha256 } from "./release";

/**
 * `cc-remote update`: installs a release beside the current version and switches the stable path
 * to it, never interrupting what runs (see src/install/layout.ts). Nothing is switched until the
 * new binary matched SHA256SUMS, ran `--version`, and, when a central server is configured, ran
 * `doctor` there, which proves the server's claude is new enough for the new version. Old
 * versions are removed only once nothing runs them; the previous one stays for --rollback.
 * Never automatic: setup and doctor only print a notice.
 */
const USAGE = {
  en: `Usage: cc-remote update [--check | --version <v> | --rollback] [--skip-host-check]

Installs a cc-remote release beside the current one and switches ~/.local/bin/cc-remote to it.
Running sessions and chats keep the version they started with; new ones get the new version.

  (no option)         install the latest release and switch to it
  --check             show the installed and the latest version; change nothing
  --version <v>       install and switch to that release (older ones too)
  --rollback          switch back to the previous version
  --skip-host-check   switch even when the central server can't be reached to check its claude
                      (a server that answers with a claude that is too old still stops the update)
  --lang en|zh        language of the messages`,
  zh: `用法：cc-remote update [--check | --version <版本> | --rollback] [--skip-host-check]

在当前版本旁边安装一个 cc-remote 发布版本，并把 ~/.local/bin/cc-remote 切换过去。
正在运行的会话和聊天继续使用启动时的版本；之后新开的才会用新版本。

  （无选项）          安装最新版本并切换过去
  --check             显示已安装版本和最新版本；不做任何改动
  --version <版本>    安装并切换到该版本（也可以是更旧的版本）
  --rollback          切回上一个版本
  --skip-host-check   中心服务器连不上、无法检查其 claude 时也照样切换
                      （服务器能连上但 claude 太旧时，仍会停止更新）
  --lang en|zh        提示信息的语言`,
};

type Options = { check: boolean; version?: string; rollback: boolean; skipHostCheck: boolean; help: boolean; lang?: string };

class Usage extends Error {}

function parse(argv: string[]): Options {
  const o: Options = { check: false, rollback: false, skipHostCheck: false, help: false };
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
    else if (flag === "--version") o.version = value().replace(/^v/, "");
    else if (flag === "--lang") o.lang = value();
    else if (flag === "-h" || flag === "--help") o.help = true;
    else throw new Usage(`unknown argument ${a}`);
  }
  if (o.version !== undefined && !VERSION.test(o.version)) throw new Usage(`--version needs a version such as 0.3.1, not ${o.version}`);
  if ([o.check, o.rollback, o.version !== undefined].filter(Boolean).length > 1) throw new Usage("use only one of --check, --version and --rollback");
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
};

const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");

/** Runs a binary and returns its exit code and output, both streams together. */
async function run(argv: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: `${out}${err}` };
  } catch (e) {
    return { code: 127, out: (e as Error).message };
  }
}

/** The host doctor would use: CC_REMOTE_HOST, else the host file. */
function configuredHost(env: Record<string, string | undefined>, home: string): string | undefined {
  if (env.CC_REMOTE_HOST?.trim()) return env.CC_REMOTE_HOST.trim();
  try {
    return readFileSync(join(home, ".config", "cc-remote", "host"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a binary runs and says it is this version of cc-remote. */
async function sane(bin: string, version: string, env: Record<string, string | undefined>) {
  const { code, out } = await run([bin, "--version"], env, 30_000);
  return { ok: code === 0 && out.trimStart().startsWith(`${version} (cc-remote`), out: out.trim().slice(0, 300) };
}

/** Removes versions that are neither current nor previous and that nothing runs any more. */
function cleanup(l: Layout, keep: string[], say: (s: string) => void, platform: NodeJS.Platform, fs: Fs) {
  let names: string[] = [];
  try {
    names = readdirSync(l.versions);
  } catch {}
  for (const name of names) {
    if (keep.includes(name)) continue;
    const dir = join(l.versions, name);
    const used = inUse(dir, platform);
    if (used === false) rmSync(dir, { recursive: true, force: true });
    else if (VERSION.test(name)) say(used ? t(`  kept ${name}: still running`, `  保留 ${name}：仍在运行`) : t(`  kept ${name}: can't tell whether it still runs`, `  保留 ${name}：无法判断是否仍在运行`));
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
  const l = layout(env, platform);
  const state = installed(l);
  const info = readInstall(l);
  const current = state.kind === "managed" ? state.version : undefined;

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

  if (state.kind === "unmanaged") {
    say(t(
      `cc-remote update: this cc-remote isn't managed by install.sh (${state.detail}). If it was installed from source: \`git pull && bun run compile\`; or reinstall with install.sh.`,
      `cc-remote update：当前 cc-remote 不是由 install.sh 管理的（${state.detail}）。若是从源码安装：\`git pull && bun run compile\`；或用 install.sh 重新安装。`,
    ));
    return 1;
  }
  if (state.kind === "absent" && (!self.compiled || /[\\/]dist[\\/]cc-remote/.test(realpath(self.execPath)))) {
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
    return await update(l, o, current, env, say, platform, io.arch ?? process.arch, fs, now);
  } catch (e) {
    say(t(`cc-remote update: ${(e as Error).message}. Nothing was switched.`, `cc-remote update：${(e as Error).message}。没有切换任何版本。`));
    return 1;
  } finally {
    release();
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
  const check = await sane(binary(l, previous), previous, env);
  if (!check.ok) {
    say(t(`cc-remote update: ${previous} doesn't run (${check.out || "no output"}). Nothing was switched.`, `cc-remote update：${previous} 无法运行（${check.out || "无输出"}）。没有切换任何版本。`));
    return 1;
  }
  activate(l, previous, fs, now());
  writeInstall(l, { current: previous, previous: current, installedAt: new Date(now()).toISOString() });
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

  const host = configuredHost(env, env.HOME || env.USERPROFILE || "");
  if (!host) say(t("No central server is configured, so its claude wasn't checked against the new version.", "没有配置中心服务器，因此没有检查其 claude 是否满足新版本的要求。"));
  else {
    say(t(`Checking ${host} with the new version…`, `正在用新版本检查 ${host}…`));
    const doctor = await run([binary(l, target), "doctor"], { ...env, CC_REMOTE_NO_VERSION_CACHE: "1" }, 120_000);
    if (doctor.code !== 0) {
      const reached = /^remote claude: /m.test(doctor.out);
      for (const line of doctor.out.trim().split("\n")) say(`  ${line}`);
      if (reached || !o.skipHostCheck) {
        say(reached
          ? t(`Not switched: update claude on ${host}, then run \`cc-remote update\` again.`, `没有切换：请先更新 ${host} 上的 claude，再运行 \`cc-remote update\`。`)
          : t(`Not switched: ${host} couldn't be checked. Fix the connection, or pass --skip-host-check to switch anyway.`, `没有切换：无法检查 ${host}。请修复连接，或加 --skip-host-check 强制切换。`));
        return 1;
      }
      say(t(`${host} couldn't be checked; switching anyway (--skip-host-check).`, `无法检查 ${host}；按 --skip-host-check 照样切换。`));
    }
  }

  mkdirSync(dirname(l.stable), { recursive: true });
  activate(l, target, fs, now());
  const previous = current ?? readInstall(l).current;
  writeInstall(l, { current: target, previous, installedAt: new Date(now()).toISOString() });
  cleanup(l, [target, ...(previous ? [previous] : [])], say, platform, fs);
  if (current) say(t(`Updated ${current} → ${target}. Running sessions keep ${current} until they end. Undo: cc-remote update --rollback`, `已更新 ${current} → ${target}。正在运行的会话结束前继续使用 ${current}。撤销：cc-remote update --rollback`));
  else say(t(`Installed cc-remote ${target} at ${l.stable}.`, `已在 ${l.stable} 安装 cc-remote ${target}。`));
  return 0;
}
