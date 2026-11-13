import { loginLaunch, loginShell } from "./login";
import { MAX_OUTPUT, shellTool } from "./shell";

/** The trap records where the command left us; `exec 2>&1` interleaves stderr like a terminal would. */
const script = (command: string) =>
  `exec 2>&1\ntrap '[ -n "$__CC_REMOTE_PWD" ] && pwd -P >| "$__CC_REMOTE_PWD"' EXIT\n${command}`;

/** bash or zsh, whichever is the user's login shell; bash for any other. */
const kind = loginShell().kind ?? "bash";

export const bash = shellTool({
  name: "Bash",
  description: `Executes a ${kind} command on the user's local machine and returns its combined stdout and stderr.

- Commands run in the user's login shell environment (${kind}), with the PATH, variables and functions their profile sets up
- The working directory persists between commands (cd carries over); environment variables and shell functions you set do not
- Prefer absolute paths so you don't depend on the current directory
- Default timeout is 120000ms (2 minutes); max is 600000ms (10 minutes)
- Output over ${MAX_OUTPUT} characters is truncated
- The command gets no stdin; avoid interactive commands
- Set run_in_background for long-running processes such as dev servers. You get back an ID and an output file to Read; the process stops when the session ends
- Prefer Read, Edit, Write, Glob and Grep over cat, sed, echo >, find and grep for file work
- Chain dependent commands with &&; make independent calls in parallel in one response`,
  launch: (command, ws) => loginLaunch(script(command), ws.root),
  stopHint: (pid) => `kill -- -${pid}`,
});
