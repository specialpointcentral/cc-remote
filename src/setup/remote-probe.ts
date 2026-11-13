import { quote } from "../sh";
import { REMOTE_PATH } from "../ssh";

/**
 * What setup learns about the central server, from one connection: `/bin/sh -s` with this script
 * on stdin, so a fish or csh login shell can't get the quoting wrong. It only reads. Its output is
 * KEY=VALUE lines between random-token markers, since login shells can be chatty, and the longer
 * sections (claude's auth status, the sshd config) between `<token>:begin:<name>` and
 * `<token>:end:<name>`.
 *
 * `sshd -T` is not used: it needs root (non-root gets "no hostkeys available"). The sshd config is
 * read as text instead, Include lines inlined, which makes its values approximate.
 */
export function probeScript(token: string, machine: string): string {
  return String.raw`T=${quote(token)}
M=${quote(machine)}
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\r\n' '  ')"; }
begin() { printf '%s:begin:%s\n' "$T" "$1"; }
end() { printf '%s:end:%s\n' "$T" "$1"; }
printf '%s:begin\n' "$T"
kv OS "$(uname -s 2>/dev/null)"
kv ARCH "$(uname -m 2>/dev/null)"
if [ -r /etc/os-release ]; then
  kv DISTRO_ID "$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1)"
  kv DISTRO_LIKE "$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -n 1)"
  kv DISTRO_VERSION "$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -n 1)"
fi
shell=$SHELL
[ -n "$shell" ] || shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
[ -n "$shell" ] || shell=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed 's/^UserShell: //')
kv LOGIN_SHELL "$shell"
missing=
for t in tar sed mkdir rm env; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
kv TOOLS_MISSING "$missing"
claude=$(${REMOTE_PATH} command -v claude 2>/dev/null)
kv CLAUDE_NI "$claude"
if [ -z "$claude" ] && [ -n "$shell" ] && [ -x "$shell" ]; then
  # Only for the hint: where a login shell finds it, when ssh commands don't.
  found=$("$shell" -lc 'command -v claude' </dev/null 2>/dev/null | tail -n 1)
  case "$found" in /*) kv CLAUDE_LOGIN "$found" ;; esac
fi
if [ -n "$claude" ]; then
  auth=$(${REMOTE_PATH} claude auth status --json </dev/null 2>/dev/null)
  kv AUTH_EXIT "$?"
  begin auth; printf '%s\n' "$auth" | head -n 200; end auth
  help=$(${REMOTE_PATH} claude --help </dev/null 2>/dev/null)
  case "$help" in *'"auto"'*) kv HELP_AUTO 1 ;; *) kv HELP_AUTO 0 ;; esac
fi
d="$HOME/.cc-remote"
if [ -d "$d" ]; then kv CC_DIR dir
elif [ -L "$d" ]; then kv CC_DIR dangling
elif [ -e "$d" ]; then kv CC_DIR other
else kv CC_DIR absent; fi
if [ -d "$d" ]; then w="$d"; else w="$HOME"; fi
if [ -O "$w" ]; then kv CC_OWNED 1; else kv CC_OWNED 0; fi
if [ -w "$w" ]; then kv CC_WRITABLE 1; else kv CC_WRITABLE 0; fi
kv CC_FREE_KB "$(df -Pk "$w" 2>/dev/null | awk 'NR==2 {print $4}')"
sshd_emit() {
  [ -r "$1" ] || { printf '#cc-remote:unreadable %s\n' "$1"; return; }
  printf '#cc-remote:file %s\n' "$1"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      [Ii]nclude[[:space:]]*|[[:space:]]*[Ii]nclude[[:space:]]*)
        for pat in $(printf '%s' "$line" | sed 's/^[[:space:]]*[Ii]nclude[[:space:]]*//'); do
          case "$pat" in /*) ;; *) pat="/etc/ssh/$pat" ;; esac
          for f in $pat; do [ "$2" -lt 4 ] && [ -f "$f" ] && sshd_emit "$f" $(($2 + 1)); done
        done ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$1"
}
begin sshd; [ -e /etc/ssh/sshd_config ] && sshd_emit /etc/ssh/sshd_config 0 | head -n 2000; end sshd
kv NOFILE "$(ulimit -n 2>/dev/null)"
kv NPROC "$(ulimit -u 2>/dev/null || ulimit -p 2>/dev/null)"
if [ -r /proc/meminfo ]; then
  kv MEM_KB "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
elif command -v vm_stat >/dev/null 2>&1; then
  kv MEM_KB "$(vm_stat | awk '/page size of/ {ps=$8} /Pages free|Pages inactive|Pages speculative/ {gsub(/\./,"",$NF); n+=$NF} END {if (ps) print int(n*ps/1024)}')"
fi
kv CLAUDE_PROCS "$(ps -u "$(id -u)" -o comm= 2>/dev/null | awk '{n=split($0,p,"/")} p[n]=="claude" {c++} END {print c+0}')"
marker=$(head -c 4096 "$d/machines/$M.json" 2>/dev/null)
begin marker; [ -z "$marker" ] || printf '%s\n' "$marker"; end marker
printf '%s:end\n' "$T"
`;
}

export type Probe = { kv: Record<string, string>; sections: Record<string, string> };

/** The probe's output between its markers, or undefined when the markers aren't there. */
export function parseProbe(stdout: string, token: string): Probe | undefined {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(`${token}:begin`);
  const stop = lines.indexOf(`${token}:end`, start + 1);
  if (start < 0 || stop < 0) return undefined;
  const probe: Probe = { kv: {}, sections: {} };
  let section: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(start + 1, stop)) {
    if (section) {
      if (line === `${token}:end:${section}`) {
        probe.sections[section] = body.join("\n");
        section = undefined;
      } else body.push(line);
      continue;
    }
    if (line.startsWith(`${token}:begin:`)) {
      section = line.slice(token.length + 7);
      body = [];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && /^[A-Z_]+$/.test(line.slice(0, eq)) && !(line.slice(0, eq) in probe.kv)) probe.kv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return probe;
}

/** Why an ssh connection failed, from what ssh printed on stderr. */
export type SshFailure = "changed" | "hostkey" | "denied" | "dns" | "timeout" | "refused" | "noroute" | "toomany" | "kex" | "other";

export function classifySsh(stderr: string): SshFailure {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr)) return "changed";
  if (/Host key verification failed|host key is known for|authenticity of host .* can't be established/i.test(stderr)) return "hostkey";
  if (/Too many authentication failures/i.test(stderr)) return "toomany";
  if (/Permission denied \(/i.test(stderr)) return "denied";
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return "dns";
  if (/timed out/i.test(stderr)) return "timeout";
  if (/Connection refused/i.test(stderr)) return "refused";
  if (/No route to host|Network is unreachable/i.test(stderr)) return "noroute";
  if (/kex_exchange_identification|Connection closed by|Connection reset by/i.test(stderr)) return "kex";
  return "other";
}

/** The last meaningful line of ssh's error output, for a message. */
export function sshError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[@*]+$/.test(l) && !/^Warning: Permanently added/.test(l));
  return (lines.at(-1) ?? "").slice(0, 300);
}

/** claude's login, from `claude auth status --json`; logged out exits 1 but still prints JSON. */
export type Auth = { loggedIn: boolean; method?: string; subscription?: string; provider?: string; email?: string };

export function parseAuth(text: string | undefined): Auth | undefined {
  if (!text?.trim()) return undefined;
  try {
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const provider = typeof data.apiProvider === "string" ? data.apiProvider : undefined;
    // As claude's own auth status decides: an OAuth login, an API key, or a third-party provider.
    const loggedIn = data.loggedIn === true || !!data.apiKeySource || (!!provider && provider !== "firstParty");
    return { loggedIn, method: data.authMethod, subscription: data.subscriptionType ?? undefined, provider, email: data.email };
  } catch {
    return undefined;
  }
}

/**
 * sshd settings from the config text the probe sent: the first value of each keyword wins, as in
 * sshd, and nothing after a Match line counts (conditional). Approximate, by design.
 */
export type Sshd = { readable: boolean; maxSessions?: number; clientAliveInterval?: number; maxStartups?: string };

export function parseSshd(text: string | undefined): Sshd {
  const lines = (text ?? "").split("\n");
  const readable = lines.some((l) => l.startsWith("#cc-remote:file "));
  const values = new Map<string, string>();
  let inMatch = false;
  for (const line of lines) {
    const m = line.trim().match(/^(\w+)(?:\s*=\s*|\s+)(.+?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const key = m[1]!.toLowerCase();
    if (key === "match") inMatch = true;
    if (!inMatch && !values.has(key)) values.set(key, m[2]!);
  }
  const number = (key: string) => {
    const v = values.get(key);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  return { readable, maxSessions: number("maxsessions"), clientAliveInterval: number("clientaliveinterval"), maxStartups: values.get("maxstartups") };
}

/** The machine marker on the central server, `~/.cc-remote/machines/<hostname>.json`. */
export type Marker = { machineId: string; firstSeen?: string; lastSeen?: string; ccRemote?: string };

export function parseMarker(text: string | undefined): Marker | undefined {
  try {
    const data = JSON.parse(text ?? "");
    return typeof data?.machineId === "string" ? data : undefined;
  } catch {
    return undefined;
  }
}

/** A hostname that can name a marker file. */
export const markerName = (host: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(host) ? host : undefined);

/**
 * Creates `~/.cc-remote/ws` and `machines/` on the central server, private, and writes this
 * machine's marker when there is none or it already holds this machine's id. Prints
 * `RESULT=created|updated|foreign|symlink|notdir|failed`.
 */
export function saveScript(machine: string, id: string, marker: string): string {
  return String.raw`umask 077
d="$HOME/.cc-remote"
m="$d/machines/"${quote(`${machine}.json`)}
if { [ -e "$d" ] || [ -L "$d" ]; } && [ ! -d "$d" ]; then echo RESULT=notdir; exit 0; fi
if [ -L "$d/machines" ]; then echo RESULT=symlink; exit 0; fi
mkdir -p "$d/ws" "$d/machines" && chmod 700 "$d" "$d/ws" "$d/machines" || { echo RESULT=failed; exit 0; }
if [ -L "$m" ]; then echo RESULT=symlink; exit 0; fi
if [ -e "$m" ]; then
  grep -q ${quote(`"machineId":"${id}"`)} "$m" 2>/dev/null || grep -q ${quote(`"machineId": "${id}"`)} "$m" 2>/dev/null || { echo RESULT=foreign; exit 0; }
  r=updated
else r=created; fi
printf '%s\n' ${quote(marker)} > "$m.tmp.$$" && mv -f "$m.tmp.$$" "$m" && echo RESULT=$r || { rm -f "$m.tmp.$$"; echo RESULT=failed; }
`;
}
