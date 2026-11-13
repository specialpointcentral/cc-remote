import { readdirSync, readlinkSync } from "node:fs";
import { sep } from "node:path";

/**
 * Whether a running process executes a file in a version's folder, so `update` keeps it. A running
 * ACP agent, an Orca chat or claudeShim's script (which names the versioned binary, not the stable
 * path) all pin their version until they end. Linux reads /proc/<pid>/exe, which also shows a file
 * since deleted; macOS asks lsof for each process's executable. Undefined when it can't be told,
 * and then the version is kept.
 */
export function inUse(dir: string, platform: NodeJS.Platform = process.platform, run = runSync): boolean | undefined {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  if (platform === "linux") {
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
    } catch {
      return undefined;
    }
    let readable = 0;
    for (const pid of pids) {
      let exe: string;
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        // Another user's process, or one that just ended. Our versions folder is private, so
        // another user's process can't be running a file in it.
        continue;
      }
      readable++;
      if (exe.replace(/ \(deleted\)$/, "").startsWith(prefix)) return true;
    }
    return readable > 0 ? false : undefined;
  }
  if (platform === "darwin") {
    const out = run(["lsof", "-n", "-d", "txt", "-Fn"]);
    if (out === undefined) return undefined;
    return out.split("\n").some((line) => line.startsWith("n") && line.slice(1).startsWith(prefix));
  }
  return undefined;
}

function runSync(argv: string[]): string | undefined {
  try {
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    // lsof exits 1 when some processes couldn't be read, with the rest listed.
    const out = proc.stdout.toString();
    return proc.exitCode === 0 || out ? out : undefined;
  } catch {
    return undefined;
  }
}
