import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * cc-remote's own small files (the host file, setup history and state, install.json): private,
 * replaced atomically by a rename (the pattern of rememberVersion in src/version.ts), and never
 * through a symbolic link, which could point a write somewhere else.
 */
const POSIX = process.platform !== "win32";

/** Why a path can't hold one of our files, if it can't: it, or its folder, is a symbolic link. */
function unsafe(path: string): string | undefined {
  for (const p of [dirname(path), path]) {
    try {
      if (lstatSync(p).isSymbolicLink()) return `${p} is a symbolic link`;
    } catch {}
  }
  return undefined;
}

/** Makes a private folder (0700) and its parents. Refuses a symbolic link. */
export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a folder`);
}

/** Writes a file atomically, readable by this user only. */
export function writePrivate(path: string, content: string) {
  const problem = unsafe(path);
  if (problem) throw new Error(problem);
  privateDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

export const writePrivateJson = (path: string, value: unknown) => writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Reads a file of ours: undefined when it's missing, a symbolic link, or (on POSIX) not a regular
 * file of this user's that only they can read.
 */
export function readPrivate(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    if (POSIX && (info.uid !== process.getuid!() || info.mode & 0o077)) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A JSON object of ours, or undefined when it's missing, unsafe or corrupt. */
export function readPrivateJson(path: string): Record<string, unknown> | undefined {
  const text = readPrivate(path);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid is running. */
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes a lock file holding our pid, made with O_EXCL. A lock whose pid is dead is stale and taken
 * over. Returns the release function, or undefined when another live process holds the lock.
 */
export function lock(path: string): (() => void) | undefined {
  privateDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (POSIX ? constants.O_NOFOLLOW : 0), 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {}
      if (alive(holder) && holder !== process.pid) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
}
