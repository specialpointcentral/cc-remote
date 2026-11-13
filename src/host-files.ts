import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "./platform";
import { type ClaudeFile, clearCommand, installCommand, syncedTest } from "./project-claude";
import { quote, REMOTE_PATH } from "./sh";
import { archive, type TarFile } from "./tar";

/**
 * Something claude on the host needs before it starts, which only this machine has:
 *
 * - a plugin, under a name that changes with its content, so present means current;
 * - the transcript of a session to resume that the host has never seen (a fork, or a session a
 *   local claude wrote);
 * - the project's commands, skills and agents, stamped with their content;
 * - the relay (relay.ts), under a name that changes with its content, needed only on a host
 *   whose python3 can run it.
 *
 * A session start checks for all of them on the host, and sends only what's missing.
 */
export type Need =
  | { kind: "plugin"; local: string; remote: string }
  | { kind: "transcript"; local: string; sessionId: string }
  | { kind: "project"; files: ClaudeFile[]; stamp: string }
  | { kind: "relay"; remote: string; data: Uint8Array };

/**
 * sh: claude's transcript folder for the current directory, which is the host folder. The name is
 * claude's: the real path with every non-alphanumeric turned to `-`.
 */
const PROJECTS = `P="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"`;

const home = (path: string) => `"$HOME"/${quote(path)}`;
const transcript = (sessionId: string) => `"$P"/${quote(`${sessionId}.jsonl`)}`;

/** sh: whether the host has it. Run in the host folder, with $P set when a transcript is needed. */
function present(need: Need): string {
  if (need.kind === "plugin") return `[ -e ${home(need.remote)} ]`;
  if (need.kind === "relay") return `[ -f ${home(need.remote)} ]`;
  if (need.kind === "transcript") return `[ -f ${transcript(need.sessionId)} ]`;
  return syncedTest(need.stamp);
}

/** The lines the check prints. A random token keeps the host's own output from passing for them. */
export type Tokens = { ready: string; missing: string };

/** What the check exits with when something is missing; claude doesn't start then. */
export const MISSING_STATUS = 97;

/**
 * What the ready line says after its token, each field after a tab: where the host's claude keeps
 * its own files, so the file tools can tell them from local ones (host-fs.ts), then claude's
 * version when the start asked for it, else nothing; then `r` when claude starts under the relay.
 */
export type Ready = {
  /** The host's $HOME. */
  home: string;
  /** claude's config folder there: $CLAUDE_CONFIG_DIR, else ~/.claude. */
  config: string;
  /** The host folder's real path, which claude names its project folders after. */
  folder: string;
  version: string;
  /** Whether claude starts under the relay, which outlives a dropped connection. */
  relay: boolean;
};

/** The fields of a ready line, from what follows its token. */
export function readyFields(rest: string): Ready {
  const [, home = "", config = "", folder = "", version = "", relay = ""] = rest.replace(/\r$/, "").split("\t");
  return { home, config, folder, version: version.trim(), relay: relay.trim() === "r" };
}

/**
 * sh, part of the check: sets $py to a python3 of 3.6 or later on the PATH claude gets, when there
 * is one, and only then counts the relay at `index` as missing if the host lacks it. Without
 * python3, $py stays empty and claude starts as it is.
 */
function relayCheck(need: Extract<Need, { kind: "relay" }>, index: number): string {
  const find = `py=$(${REMOTE_PATH} command -v python3 2>/dev/null)`;
  const fit = `"$py" -S -c 'import sys; sys.exit(sys.version_info < (3, 6))' 2>/dev/null`;
  return `if ${find} && ${fit}; then { ${present(need)} || m="$m ${index}"; }; else py=; fi`;
}

/**
 * sh: stops the relay daemons, claude and all, that an earlier launch left running for this
 * session, so two claudes never write its transcript at once. A grep first, so the usual case
 * costs no python.
 */
function reapCommand(relay: string, sessionId: string): string {
  const id = quote(sessionId);
  return `if [ -n "$py" ] && grep -qsxF ${id} "$HOME"/.cc-remote/run/*/session 2>/dev/null; then "$py" -S ${home(relay)} reap ${id}; fi`;
}

/**
 * sh, run in the host folder ahead of claude: checks that the host has everything in `needs`, and
 * removes the host's copy of the project's trees when the project has none (`clear`). With all of
 * it there, it prints the ready line on stdout (see Ready; the version when `version` names the
 * command that prints it) and goes on; otherwise it prints the missing line, the indexes of what's
 * missing, on stderr and exits with MISSING_STATUS.
 */
export function checkScript(needs: Need[], clear: boolean, tokens: Tokens, version?: string, sessionId?: string): string {
  const steps = ["m=", "py="];
  if (needs.some((n) => n.kind === "transcript")) steps.push(PROJECTS);
  needs.forEach((need, i) => steps.push(need.kind === "relay" ? relayCheck(need, i) : `{ ${present(need)} || m="$m ${i}"; }`));
  if (clear) steps.push(clearCommand());
  steps.push(`if [ -n "$m" ]; then printf '%s%s\\n' ${quote(tokens.missing)} "$m" >&2; exit ${MISSING_STATUS}; fi`);
  const relay = needs.find((n): n is Extract<Need, { kind: "relay" }> => n.kind === "relay");
  if (relay && sessionId) steps.push(reapCommand(relay.remote, sessionId));
  const fields = `"$HOME" "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$(pwd -P)" "${version ? `$(${version} 2>/dev/null)` : ""}" "\${py:+r}"`;
  steps.push(`printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' ${quote(tokens.ready)} ${fields}`);
  return steps.join(" && ");
}

/** The indexes in a missing line, or undefined when the line is something else. */
export function missingIn(line: string, tokens: Tokens): number[] | undefined {
  if (!line.startsWith(tokens.missing)) return undefined;
  return line.slice(tokens.missing.length).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

/**
 * Every file under a local directory, symlinks followed (a link to a local path would mean nothing
 * on the host), hidden files included: a plugin keeps its manifest in `.claude-plugin/`.
 */
function walk(dir: string, prefix: string, out: TarFile[], seen = new Set<string>()) {
  const real = realpathSync(dir);
  if (seen.has(real)) return; // A symlink loop.
  seen = new Set(seen).add(real);
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    let info;
    try { info = statSync(full); } catch { continue; } // A dangling symlink.
    if (info.isDirectory()) walk(full, `${prefix}/${name}`, out, seen);
    else if (info.isFile()) out.push({ path: `${prefix}/${name}`, data: readFileSync(full), mode: mode(info.mode), mtime: Math.floor(info.mtimeMs / 1000) });
  }
}

const mode = (m: number) => (WINDOWS ? 0o644 : m & 0o777);

/**
 * One tar of the needs at `missing` (indexes into `needs`), each under its index: a plugin
 * directory's files under `<i>/`, a file plugin or a transcript as the file `<i>`, the project's
 * trees under `<i>/`.
 */
export function bundle(needs: Need[], missing: number[]): Uint8Array {
  const files: TarFile[] = [];
  for (const i of missing) {
    const need = needs[i]!;
    if (need.kind === "project") {
      for (const f of need.files) files.push({ path: `${i}/${f.path}`, data: f.data, mode: f.executable ? 0o755 : 0o644, mtime: f.mtime });
      continue;
    }
    if (need.kind === "relay") {
      files.push({ path: `${i}`, data: need.data, mode: 0o700, mtime: 0 });
      continue;
    }
    const info = statSync(need.local);
    if (info.isDirectory()) walk(need.local, `${i}`, files);
    // A transcript is private, as claude keeps it.
    else files.push({ path: `${i}`, data: readFileSync(need.local), mode: need.kind === "transcript" ? 0o600 : mode(info.mode), mtime: Math.floor(info.mtimeMs / 1000) });
  }
  return archive(files);
}

/**
 * sh: waits for the host's install lock, then holds it, setting $held. Sessions often start
 * together (Orca starts a chat and its title call at once), and two moving the same tree into
 * place at once would put one inside the other. Only renames happen under the lock, so it's
 * held for milliseconds; one left by an install that was killed is broken after about 5 seconds.
 * Every cc-remote format takes this same lock before it puts anything in place.
 */
const LOCK = `L="$HOME"/.cc-remote/.install-lock && n=0 && until mkdir "$L" 2>/dev/null; do n=$((n + 1)); if [ "$n" -ge 50 ]; then rmdir "$L" 2>/dev/null; n=0; fi; sleep 0.1 2>/dev/null || sleep 1; done && held=1`;

/**
 * sh, run in the host folder: unpacks a bundle from stdin into a scratch folder, then, under the
 * install lock, puts each need in its place unless a session that started meanwhile already has.
 */
export function installScript(needs: Need[], missing: number[]): string {
  const from = (i: number) => `"$U"/${i}`;
  const steps = missing.map((i) => {
    const need = needs[i]!;
    if (need.kind === "plugin") {
      const dest = home(need.remote);
      // An empty plugin directory has no entries to unpack.
      const make = statSync(need.local).isDirectory() ? `mkdir -p ${from(i)} && ` : "";
      return `{ [ -e ${dest} ] || { ${make}mkdir -p "$(dirname ${dest})" && mv ${from(i)} ${dest}; }; }`;
    }
    if (need.kind === "transcript") {
      const dest = transcript(need.sessionId);
      return `${PROJECTS} && mkdir -p "$P" && { [ -f ${dest} ] || mv ${from(i)} ${dest}; }`;
    }
    if (need.kind === "relay") {
      const dest = home(need.remote);
      return `{ [ -f ${dest} ] || { mkdir -p "$(dirname ${dest})" && chmod 700 "$(dirname ${dest})" && mv ${from(i)} ${dest}; }; }`;
    }
    return `{ ${syncedTest(need.stamp)} || { ${installCommand(from(i), need.stamp)}; }; }`;
  });
  // Named after this process on the host, so no other upload, of this cc-remote or another, uses it.
  const scratch = `held= && U="$HOME"/.cc-remote/.upload-v1.$$ && rm -rf "$U" && mkdir -p "$U" && tar -xmf - -C "$U"`;
  return `${[scratch, LOCK, ...steps].join(" && ")}; s=$?; [ -z "$held" ] || rmdir "$L"; rm -rf "$U"; exit $s`;
}
