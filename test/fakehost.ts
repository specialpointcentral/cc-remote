import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the fake claude prints the settings every launch adds, after the caller's arguments: agent teams off. */
export const TEAMS_OFF = ' [--settings] [{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"0"}}]';

/**
 * A host on this machine: an `ssh` that logs its arguments, drops the options and the host, and
 * runs the command with sh under a separate HOME, and a `claude` there that prints its arguments
 * and then echoes its stdin. Environment knobs, read by the fake ssh at each run:
 *
 * - FAKE_REFUSE_SHARED: refuse a session on a shared connection, as a master at sshd's MaxSessions;
 * - FAKE_NOISE: print a line on stdout and one on stderr before the command, as a chatty login shell;
 * - FAKE_CLAUDE_VERSION: what claude --version prints.
 */
export function fakeHost(dir: string) {
  const home = join(dir, "host-home");
  const log = join(dir, "ssh.log");
  const ssh = join(dir, "bin", "ssh");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(ssh, String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in *ControlMaster=no*) shared=;; *ControlMaster=auto*) shared=1;; *) shared=;; esac
while [ $# -gt 1 ]; do
  case "$1" in -o|-p|-i) shift 2;; -*) shift;; *) shift; break;; esac
done
if [ -n "$FAKE_REFUSE_SHARED" ] && [ -n "$shared" ]; then
  echo "mux_client_request_session: session request failed: Session open refused by peer" >&2
  exit 255
fi
if [ -n "$FAKE_NOISE" ]; then echo "welcome to the host"; echo "a login warning" >&2; fi
export HOME="$FAKE_HOST_HOME"
if [ -n "$FAKE_HOST_CONFIG" ]; then export CLAUDE_CONFIG_DIR="$FAKE_HOST_CONFIG"; else unset CLAUDE_CONFIG_DIR; fi
exec sh -c "$1"
`);
  chmodSync(ssh, 0o755);
  const claude = join(home, ".local", "bin", "claude");
  writeFileSync(claude, String.raw`#!/bin/sh
case "$1" in --version|-v) echo "${"$"}{FAKE_CLAUDE_VERSION:-2.1.323} (Claude Code)"; exit 0;; esac
printf 'ARGS'; for a; do printf ' [%s]' "$a"; done; printf '\n'
printf 'TEAMS=%s\n' "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
exec cat
`);
  chmodSync(claude, 0o755);
  return {
    ssh,
    home,
    log,
    /** The environment that points cc-remote at this host. */
    env: { CC_REMOTE_SSH: ssh, FAKE_SSH_LOG: log, FAKE_HOST_HOME: home },
    /** Every ssh run so far, as its argument list joined by spaces. */
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
    reset: () => writeFileSync(log, ""),
  };
}
