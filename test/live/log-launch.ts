// Records launches of the live checks' Claude Command (see writeClaudeCommand in orca-live.ts).
//
//   bun test/live/log-launch.ts <log.jsonl> <claude arguments...>
//       one launch: its arguments, folder, the names of the variables in its environment (never
//       their values) and the Orca build that started it
//   bun test/live/log-launch.ts --exit <log.jsonl> <wrapper pid> <status> <output file>
//       how a one-off `claude -p` ended, with the start of what it printed
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--exit") {
  const [, log, pid, status, output] = argv;
  let text = "";
  try {
    text = readFileSync(output!, "utf8").slice(0, 2000);
  } catch {}
  appendFileSync(log!, `${JSON.stringify({ exitOf: Number(pid), status: Number(status), output: text, at: Date.now() })}\n`);
} else {
  const [log, ...args] = argv;
  // What started the wrapper: its program and script, by name only (orcad.js, or `node -e`).
  let parent = "";
  try {
    const ppid = readFileSync(`/proc/${process.ppid}/stat`, "utf8").split(") ")[1]!.split(" ")[1];
    const argv = readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const script = argv.slice(1).find((a) => /\.(js|ts|py)$/.test(a))?.split("/").pop() ?? argv.slice(1).find((a) => a === "-e" || a === "-c");
    parent = `${argv[0]?.split("/").pop()} ${script ?? ""}`.trim();
  } catch {}
  appendFileSync(log!, `${JSON.stringify({
    at: Date.now(),
    pid: process.ppid,
    parent,
    cwd: process.cwd(),
    args,
    env: Object.keys(process.env).sort(),
    orcaAppVersion: process.env.ORCA_APP_VERSION,
  })}\n`);
}
