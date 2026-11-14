#!/usr/bin/env bash
# Checks cc-remote against a real Orca Server build before adding it to VERIFIED in
# src/setup/orca.ts. Pass an orcad bundle directory (as the Orca desktop pushes it to
# ~/.orca-remote, such as ~/.orca-remote/orcad-0.1.0+<build>) or an Orca CLI that can serve. With a
# previous build as well, the chat starts on that one and the server is restarted into the new one,
# as the desktop's automatic update does.
#
# The server runs on a throwaway HOME and profile under a fresh /tmp folder, bound to 127.0.0.1 on a
# free port, with Orca's Claude Command pointing at this checkout's cc-remote. The central server is
# test/e2e/fakessh with FAKE_HOST_ISOLATED=1 (the host side on this machine, in a mount namespace of
# its own, with this machine's Claude login), or a real one with --host. The chats are real claude
# turns: four small ones on the cheapest model (CC_REMOTE_LIVE_MODEL, default haiku; three without a
# previous build), plus the title Orca has Claude write for the chat. Needs
# 1000 MB of available memory; every process of the run is stopped at the end, also after a failure.
# CC_REMOTE_LIVE_KEEP=1 keeps the run's folder (logs, launches, chat pages) even when it passes.
#
# usage: scripts/verify-orca.sh [--host <server>] <new-bundle-or-cli> [<previous-bundle-or-cli>]
set -euo pipefail

usage() { sed -n '2,17p' "$0" | cut -c3-; exit 2; }
host=""
if [ "${1:-}" = --host ]; then
  [ "$#" -ge 2 ] || usage
  host=$2
  shift 2
fi
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage

root=$(cd "$(dirname "$0")/.." && pwd)
available() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
if [ "$(available)" -lt 1000 ]; then
  echo "verify-orca: only $(available) MB of memory available, 1000 MB needed; not starting" >&2
  exit 2
fi

# Short, since Orca's Unix socket lives in the profile under it.
work=$(mktemp -d /tmp/ccro-live.XXXXXX)
token=${work##*/}
# Outside /tmp, which the isolated fake host replaces with a tmpfs of its own.
mkdir -p "$HOME/.cache"
state=$(mktemp -d "$HOME/.cache/ccro-host.XXXXXX")
report="$work/report.json"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  bun "$root/test/live/orca-live.ts" cleanup "$token" || true
  FAKE_HOST_STATE="$state" "$root/test/e2e/fakessh" --stop || true
  rm -rf "$state"
  # Kept after a failure or with CC_REMOTE_LIVE_KEEP, once there's something to look at.
  if [ ! -e "$work/h" ] || { [ "$status" -eq 0 ] && [ -z "${CC_REMOTE_LIVE_KEEP:-}" ]; }; then
    rm -rf "$work"
  else
    echo "verify-orca: the run's logs, launches and chat pages are in $work"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cli_for() {
  if [ -d "$1" ]; then
    bun "$root/test/live/orca-bundle.ts" "$1" "$work"
  elif [ -f "$1" ] && [ -x "$1" ]; then
    printf '%s\n' "$1"
  else
    echo "verify-orca: $1 is neither an orcad bundle directory nor an executable Orca CLI" >&2
    exit 2
  fi
}

new=$(cli_for "$1")
version=$("$new" --version)
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "verify-orca: unexpected Orca version output: $version" >&2; exit 2 ;;
esac
previous=""
before=""
if [ "$#" -eq 2 ]; then
  previous=$(cli_for "$2")
  before=$("$previous" --version)
fi

cd "$root"
printf '== cc-remote under Orca Server %s%s, %s\n' "$version" "${before:+ (updating from $before)}" "${host:-the isolated fake host}"
set +e
CC_REMOTE_LIVE_ORCA="$new" CC_REMOTE_LIVE_ORCA_BEFORE="$previous" CC_REMOTE_LIVE_HOST="$host" \
  CC_REMOTE_LIVE_WORK="$work" CC_REMOTE_LIVE_STATE="$state" CC_REMOTE_LIVE_REPORT="$report" \
  timeout --kill-after=30 1800 nice -n 10 bun test test/live/orca.test.ts
status=$?
set -e

if [ -f "$report" ]; then
  bun -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const split = r.messages === undefined ? "" : `: ${r.messages} chat messages on ${r.model}, ${r.titles} chat titles`;
    console.log(`\n== Results (${r.turns} claude turns${split}${r.aborted ? ", aborted" : ""})`);
    for (const x of r.results) console.log(`${x.status.toUpperCase().padEnd(12)} ${x.check}: ${x.detail}`);
  ' "$report"
fi
if [ "$status" -ne 0 ]; then
  echo "verify-orca: Orca Server $version did not pass (exit $status)" >&2
  exit "$status"
fi
if grep -q "^export const VERIFIED = .*\"$version\"" "$root/src/setup/orca.ts"; then
  printf '\nOrca Server %s passed. It is already in VERIFIED in src/setup/orca.ts.\n' "$version"
else
  printf '\nOrca Server %s passed. Add "%s" to VERIFIED in src/setup/orca.ts.\n' "$version" "$version"
fi
