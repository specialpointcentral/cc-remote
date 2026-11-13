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
 *
 * And for setup's checks, all off unless set:
 *
 * - FAKE_SSH_FAIL=hostkey|changed|denied|dns|timeout|refused: fail the connection as ssh does,
 *   with its message and exit 255. An unknown host key is learned (into $FAKE_SSH_LOG.known) by a
 *   run with StrictHostKeyChecking=accept-new or ask; a denied login passes once the host's
 *   ~/.ssh/authorized_keys has a key in it, as after ssh-copy-id;
 * - FAKE_AGENTLESS_DENY: deny the login without SSH_AUTH_SOCK until authorized_keys has a key;
 * - FAKE_AUTH_STATUS=in|out|apikey: what claude auth status --json prints (out exits 1);
 * - FAKE_HELP=auto|noauto: claude --help with or without permission mode "auto";
 * - FAKE_HOST_PATH, FAKE_LOGIN_SHELL: the remote command's PATH and SHELL.
 */
export function fakeHost(dir: string) {
  const home = join(dir, "host-home");
  const log = join(dir, "ssh.log");
  const ssh = join(dir, "bin", "ssh");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(ssh, String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
all="$*"
case "$*" in *ControlMaster=no*) shared=;; *ControlMaster=auto*) shared=1;; *) shared=;; esac
while [ $# -gt 1 ]; do
  case "$1" in -o|-p|-i) shift 2;; -*) shift;; *) shift; break;; esac
done
keys="$FAKE_HOST_HOME/.ssh/authorized_keys"
case "$FAKE_SSH_FAIL" in
  hostkey)
    case "$all" in *StrictHostKeyChecking=accept-new*|*StrictHostKeyChecking=ask*) : > "$FAKE_SSH_LOG.known";; esac
    if [ ! -e "$FAKE_SSH_LOG.known" ]; then
      echo "No ED25519 host key is known for central and you have requested strict checking." >&2
      echo "Host key verification failed." >&2
      exit 255
    fi;;
  changed) printf '%s\n' "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" "Host key verification failed." >&2; exit 255;;
  denied) [ -s "$keys" ] || { echo "me@central: Permission denied (publickey)." >&2; exit 255; };;
  dns) echo "ssh: Could not resolve hostname centrl: Name or service not known" >&2; exit 255;;
  timeout) echo "ssh: connect to host central port 22: Connection timed out" >&2; exit 255;;
  refused) echo "ssh: connect to host central port 22: Connection refused" >&2; exit 255;;
esac
if [ -n "$FAKE_AGENTLESS_DENY" ] && [ -z "$SSH_AUTH_SOCK" ] && [ ! -s "$keys" ]; then
  echo "me@central: Permission denied (publickey)." >&2
  exit 255
fi
if [ -n "$FAKE_REFUSE_SHARED" ] && [ -n "$shared" ]; then
  echo "mux_client_request_session: session request failed: Session open refused by peer" >&2
  exit 255
fi
if [ -n "$FAKE_NOISE" ]; then echo "welcome to the host"; echo "a login warning" >&2; fi
export HOME="$FAKE_HOST_HOME"
[ -z "$FAKE_HOST_PATH" ] || export PATH="$FAKE_HOST_PATH"
[ -z "$FAKE_LOGIN_SHELL" ] || export SHELL="$FAKE_LOGIN_SHELL"
if [ -n "$FAKE_HOST_CONFIG" ]; then export CLAUDE_CONFIG_DIR="$FAKE_HOST_CONFIG"; else unset CLAUDE_CONFIG_DIR; fi
exec sh -c "$1"
`);
  chmodSync(ssh, 0o755);
  const claude = join(home, ".local", "bin", "claude");
  writeFileSync(claude, String.raw`#!/bin/sh
case "$1" in --version|-v) echo "${"$"}{FAKE_CLAUDE_VERSION:-2.1.323} (Claude Code)"; exit 0;; esac
if [ "$1 $2" = "auth status" ] && [ -n "$FAKE_AUTH_STATUS" ]; then
  case "$FAKE_AUTH_STATUS" in
    in) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","subscriptionType":"max"}'; exit 0;;
    apikey) echo '{"loggedIn":false,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}'; exit 0;;
    *) echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1;;
  esac
fi
if [ "$1" = --help ] && [ -n "$FAKE_HELP" ]; then
  if [ "$FAKE_HELP" = auto ]; then echo '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")'
  else echo '  --permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "plan")'; fi
  exit 0
fi
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
