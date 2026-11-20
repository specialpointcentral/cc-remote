import { existsSync, readdirSync, readFileSync } from "node:fs";

/** Every process here as [pid, its command line, words joined by spaces]: /proc on Linux, ps elsewhere. */
export function processes(): [number, string][] {
  if (!existsSync("/proc/self/cmdline")) {
    const out = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,args="]).stdout.toString();
    return out.split("\n").flatMap((line): [number, string][] => {
      const m = /^\s*(\d+) (.*)$/.exec(line);
      return m ? [[Number(m[1]), m[2]!.trim()]] : [];
    });
  }
  const found: [number, string][] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      found.push([Number(pid), readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim()]);
    } catch {}
  }
  return found;
}
