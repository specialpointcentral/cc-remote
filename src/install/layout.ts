import { copyFileSync, existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readPrivateJson, writePrivateJson } from "../setup/files";

/**
 * Where install.sh and `cc-remote update` put cc-remote. Every version has a folder of its own,
 * and a stable path names the current one:
 *
 *   ~/.local/share/cc-remote/versions/<v>/cc-remote   the binaries (folder 0700, file 0755)
 *   ~/.local/bin/cc-remote                            a symbolic link to the current one
 *   ~/.local/share/cc-remote/install.json             current and previous version (0600)
 *
 * Switching versions replaces the link with rename(), which is atomic: a process already running
 * keeps executing its own file, and the next one started (Orca's next chat, the next ACP session)
 * gets the new version. Orca's Claude Command names the stable path, so it never goes stale.
 *
 * On Windows a running .exe can be renamed but not overwritten or deleted, so the stable path is a
 * real file, %LOCALAPPDATA%\cc-remote\bin\cc-remote.exe, swapped by renaming the old one aside.
 */
export const REPO = "specialpointcentral/cc-remote";

export type Layout = {
  windows: boolean;
  /** The stable path: what's on PATH and in Orca's Claude Command. */
  stable: string;
  root: string;
  versions: string;
  installJson: string;
  lock: string;
};

type Env = Record<string, string | undefined>;

export function layout(env: Env = process.env, platform: NodeJS.Platform = process.platform): Layout {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32") {
    const root = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "cc-remote");
    return { windows: true, stable: join(root, "bin", "cc-remote.exe"), root, versions: join(root, "versions"), installJson: join(root, "install.json"), lock: join(root, "update.lock") };
  }
  const root = join(home, ".local", "share", "cc-remote");
  return { windows: false, stable: join(home, ".local", "bin", "cc-remote"), root, versions: join(root, "versions"), installJson: join(root, "install.json"), lock: join(root, "update.lock") };
}

/** The binary of one version. */
export const binary = (l: Layout, version: string) => join(l.versions, version, l.windows ? "cc-remote.exe" : "cc-remote");

/** A version name we accept: what a release tag holds after its `v`. */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The release asset for a platform, as package.json's build scripts name them. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === "win32" ? "windows" : platform;
  const name = `cc-remote-${os}-${arch}`;
  return ["cc-remote-linux-x64", "cc-remote-linux-arm64", "cc-remote-darwin-arm64", "cc-remote-windows-x64", "cc-remote-windows-arm64"].includes(name)
    ? `${name}${platform === "win32" ? ".exe" : ""}`
    : undefined;
}

export type Install = { current?: string; previous?: string; installedAt?: string; source?: string };

export function readInstall(l: Layout): Install {
  const data = readPrivateJson(l.installJson) ?? {};
  const version = (v: unknown) => (typeof v === "string" && VERSION.test(v) ? v : undefined);
  return { current: version(data.current), previous: version(data.previous), installedAt: typeof data.installedAt === "string" ? data.installedAt : undefined, source: typeof data.source === "string" ? data.source : undefined };
}

export function writeInstall(l: Layout, data: Install) {
  writePrivateJson(l.installJson, { ...data, source: data.source ?? `github:${REPO}` });
}

/**
 * What the stable path holds: a managed install (a link into versions/, or on Windows a file
 * install.json accounts for), nothing, or something else, such as `bun link` or a copied binary.
 */
export type Installed = { kind: "managed"; version: string } | { kind: "absent" } | { kind: "unmanaged"; detail: string };

export function installed(l: Layout): Installed {
  let info;
  try {
    info = lstatSync(l.stable);
  } catch {
    return { kind: "absent" };
  }
  if (l.windows) {
    const current = readInstall(l).current;
    return current && info.isFile() ? { kind: "managed", version: current } : { kind: "unmanaged", detail: l.stable };
  }
  if (!info.isSymbolicLink()) return { kind: "unmanaged", detail: `${l.stable} is not a link into ${l.versions}` };
  const target = resolve(dirname(l.stable), readlinkSync(l.stable));
  const rel = relative(l.versions, target).split(sep);
  if (rel.length === 2 && rel[1] === "cc-remote" && VERSION.test(rel[0]!) && existsSync(target)) return { kind: "managed", version: rel[0]! };
  return { kind: "unmanaged", detail: `${l.stable} points at ${target}` };
}

/** The file operations a switch needs, so the Windows swap can be tested anywhere. */
export type Fs = {
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  symlink(target: string, path: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
};

export const realFs: Fs = {
  rename: renameSync,
  copy: copyFileSync,
  symlink: (target, path) => symlinkSync(target, path),
  remove: (path) => rmSync(path, { force: true }),
  exists: existsSync,
};

/**
 * Points the stable path at a version. POSIX: a new link beside it, renamed over it, so the path
 * always resolves. Windows: the old file renamed aside, the new one copied in, and the old one
 * renamed back if the copy fails.
 */
export function activate(l: Layout, version: string, fs: Fs = realFs, now = Date.now()) {
  const target = binary(l, version);
  if (!fs.exists(target)) throw new Error(`${target} is missing`);
  if (!l.windows) {
    const temp = join(dirname(l.stable), `.cc-remote.new.${process.pid}`);
    fs.remove(temp);
    fs.symlink(target, temp);
    try {
      fs.rename(temp, l.stable);
    } catch (e) {
      fs.remove(temp);
      throw e;
    }
    return;
  }
  const aside = `${l.stable}.old-${now}`;
  const had = fs.exists(l.stable);
  if (had) fs.rename(l.stable, aside);
  try {
    fs.copy(target, l.stable);
  } catch (e) {
    if (had) fs.rename(aside, l.stable);
    throw e;
  }
}

/** Old Windows binaries left aside by activate(); deleting one fails while it still runs. */
export const asideFiles = (l: Layout, names: string[]) => names.filter((n) => n.startsWith(`${basename(l.stable)}.old-`)).map((n) => join(dirname(l.stable), n));
