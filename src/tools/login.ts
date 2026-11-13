import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { groups, type Launch, stop } from "./shell";

/**
 * The environment of the user's login shell, for local shell commands. cc-remote is usually
 * started by an editor or a daemon rather than a login shell, so the PATH entries profiles add
 * (Homebrew, nvm, conda, pyenv, `module`) would be missing, and a zsh user's profile ignored.
 * Starting a login shell per command re-runs the profile every time, which takes 200+ ms on some
 * machines. So the first command captures what a login bash or zsh leaves behind (exported
 * variables, functions, shell options, umask, soft resource limits) into a private snapshot,
 * checks that it loads silently and completely, and later commands load it into a plain
 * `$SHELL -c`. It is captured again after 10 minutes (startup files may source files nobody
 * watches) or once a startup file changes. Anything else (a shell other than bash or zsh, a failed
 * or timed-out capture, unsafe permissions, a capture already running for another command) runs
 * that command as a login shell instead; CC_REMOTE_SHELL_SNAPSHOT=off always does.
 *
 * Snapshots are shared by the user's cc-remote processes (Orca starts one per chat), in a private
 * cache directory: one file per machine, user, shell, home and environment, replaced by an atomic
 * rename, with a lock so one process captures at a time. Values that belong to one process (Orca's
 * per-chat variables, Claude's) are neither in the key nor in the snapshot, so each command keeps
 * its own. Each snapshot format has its own directory, so versions of cc-remote running side by
 * side never read, replace or remove each other's files. A cache that isn't private or can't be
 * made, or a file in it this version doesn't recognize, gives way to a per-process directory.
 *
 * Ported from remote-harness's run-on-project-host.sh ("Login shell snapshot").
 */

/** Settings, and the directories the snapshots live in; fields so tests can change them. */
export const snapshots = {
  maxAgeMs: 10 * 60_000,
  /** A failed capture is retried after this, or once a startup file changes. */
  retryMs: 10 * 60_000,
  captureTimeoutMs: 30_000,
  checkTimeoutMs: 10_000,
  /** A capture lock this old was left by a process that died capturing: longer than any capture with its checks. */
  lockStaleMs: 2 * 60_000,
  /** Snapshots and failure records nobody has refreshed for this long are removed after a capture. */
  pruneMs: 7 * 24 * 60 * 60_000,
  /** The shell for a login shell that is neither bash nor zsh: the tool's commands are bash. */
  bash: "bash",
  /** System files a login bash or zsh reads, directly, through /etc/profile.d, or through macOS path_helper. */
  systemFiles: ["/etc/environment", "/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zshenv", "/etc/zprofile", "/etc/zlogin", "/etc/zsh", "/etc/paths", "/etc/paths.d"],
  /** The shared cache; empty for ${XDG_CACHE_HOME:-~/.cache}/cc-remote/shell, as of each use. */
  cacheDir: "",
  /** This process's own: load markers, and the snapshots when the cache can't be used. Created on first use, removed when cc-remote exits. */
  dir: "",
  log: (message: string) => console.error(`cc-remote: ${message}`),
};

/**
 * Never restored from a snapshot: values that belong to one process or connection. Each command
 * keeps its own (__CC_REMOTE_PWD is the file its final directory goes to).
 */
const SKIP = "PWD OLDPWD SHLVL _ IFS XDG_SESSION_ID KRB5CCNAME SSH_CLIENT SSH_CONNECTION SSH_TTY SSH_ORIGINAL_COMMAND HOSTNAME HOST __CC_REMOTE_PWD";

/** Variables the app that started cc-remote sets per process (Orca's per chat), and cc-remote's own. */
const PER_PROCESS = /^(ORCA_|CLAUDE_|__CC_REMOTE_)/;

/**
 * The snapshot format: the capture scripts' output and the files kept beside it. Bump it with any
 * change to either; the new format then lives in a directory of its own.
 */
const FORMAT = 1;

const HEADER = `# cc-remote shell snapshot (format ${FORMAT}):`;

/**
 * The capture scripts run as `<shell> -lc <script> cc-remote <output> <names to skip> <shell>`,
 * after the profile. They write only to <output> (with `>|`, as the profile may set noclobber) and
 * end it with a marker, so a truncated snapshot never loads as complete.
 */
const CAPTURE_BASH = String.raw`__cc_snap_opts=$(builtin set +o) __cc_snap_shopts=$(builtin shopt -p)
builtin set +e +u +x +v
__cc_snap_skip=" $2 " __cc_snap_ro=" "
while IFS= builtin read -r __cc_snap_line; do
  case $__cc_snap_line in
    "declare -"*" "*) __cc_snap_line=${"$"}{__cc_snap_line#declare -* }; __cc_snap_ro="$__cc_snap_ro${"$"}{__cc_snap_line%%=*} " ;;
  esac
done <<__CC_SNAP_EOF
$(builtin readonly -p)
__CC_SNAP_EOF
{
  builtin printf '${HEADER} %s\n' "$3"
  builtin printf 'umask %s\n' "$(builtin umask)"
  for __cc_snap_l in n c s u; do
    __cc_snap_v=$(builtin ulimit -S -"$__cc_snap_l" 2>/dev/null) || continue
    case $__cc_snap_v in unlimited) ;; ""|*[!0-9]*) continue ;; esac
    builtin printf 'ulimit -S -%s %s 2>/dev/null\n' "$__cc_snap_l" "$__cc_snap_v"
  done
  for __cc_snap_n in $(builtin compgen -e); do
    case $__cc_snap_skip in *" $__cc_snap_n "*) continue ;; esac
    case $__cc_snap_n in ""|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
    case " BASHOPTS SHELLOPTS EUID PPID UID " in *" $__cc_snap_n "*) continue ;; esac
    builtin printf 'export %s=%q\n' "$__cc_snap_n" "${"$"}{!__cc_snap_n}"
    case $__cc_snap_ro in *" $__cc_snap_n "*) builtin printf 'readonly %s\n' "$__cc_snap_n" ;; esac
  done
  # Functions parse with extglob on whatever the profile left it at; the options follow them.
  builtin printf '%s\n' 'shopt -s extglob'
  builtin declare -f
  while IFS= builtin read -r __cc_snap_line; do
    case $__cc_snap_line in "declare -fx "*) builtin printf 'export -f %q\n' "${"$"}{__cc_snap_line#declare -fx }" ;; esac
  done <<__CC_SNAP_EOF
$(builtin declare -F)
__CC_SNAP_EOF
  while IFS= builtin read -r __cc_snap_line; do
    case $__cc_snap_line in "shopt -"[su]" login_shell"|"shopt -"[su]" restricted_shell") continue ;; esac
    builtin printf '%s\n' "$__cc_snap_line"
  done <<__CC_SNAP_EOF
$__cc_snap_shopts
__CC_SNAP_EOF
  builtin printf '%s\n' "$__cc_snap_opts" '__cc_snapshot_complete=1'
} >| "$1"
`;

const CAPTURE_ZSH = String.raw`__cc_snap_setopt=$(setopt)
__cc_snap_capture() {
  emulate -L zsh
  local __cc_snap_skip=" $2 " __cc_snap_ro __cc_snap_n __cc_snap_l __cc_snap_v
  __cc_snap_ro=" ${"$"}{(j: :)${"$"}{(f)"$(typeset +r)"}} "
  {
    print -r -- "${HEADER} $3"
    print -r -- "umask $(umask)"
    for __cc_snap_l in n c s u; do
      __cc_snap_v=$(ulimit -S -$__cc_snap_l 2>/dev/null) || continue
      [[ $__cc_snap_v == unlimited || $__cc_snap_v == <-> ]] || continue
      print -r -- "ulimit -S -$__cc_snap_l $__cc_snap_v 2>/dev/null"
    done
    for __cc_snap_n in ${"$"}{(f)"$(typeset +x)"}; do
      [[ $__cc_snap_skip == *" $__cc_snap_n "* ]] && continue
      [[ $__cc_snap_n == [A-Za-z_]* && $__cc_snap_n != *[^A-Za-z0-9_]* ]] || continue
      print -r -- "export $__cc_snap_n=${"$"}{(qq)${"$"}{(P)__cc_snap_n}}"
      [[ $__cc_snap_ro == *" $__cc_snap_n "* ]] && print -r -- "readonly $__cc_snap_n"
    done
    print -r -- "fpath=( ${"$"}{(qq)fpath[@]} )"
    typeset -f
    print -r -- 'unfunction __cc_snap_capture 2>/dev/null'
    # Options that differ from the defaults, minus those that describe how this shell was started.
    for __cc_snap_n in ${"$"}{(f)__cc_snap_setopt}; do
      case $__cc_snap_n in
        (login|interactive|shinstdin|monitor|zle|privileged|restricted|singlecommand) ;;
        ([a-z]*) print -r -- "setopt $__cc_snap_n" ;;
      esac
    done
    print -r -- '__cc_snapshot_complete=1'
  } >| "$1"
}
__cc_snap_capture "$@"
`;

type Kind = "bash" | "zsh";
export type LoginShell = { path: string; kind?: Kind };
type Env = Record<string, string | undefined>;

const executable = (path: string) => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};

/**
 * The user's login shell: $SHELL, else the passwd entry, which a daemon's environment may lack.
 * Bash and zsh can be snapshot; any other shell (fish, tcsh, sh) can't run the tool's bash, so
 * bash runs as a login shell in its place.
 */
export function loginShell(env: Env = Bun.env): LoginShell {
  let passwd: string | undefined;
  try { passwd = userInfo().shell ?? undefined; } catch {}
  const shell = [env.SHELL, passwd].find((s) => s && isAbsolute(s) && executable(s));
  const name = shell && basename(shell);
  return shell && (name === "bash" || name === "zsh") ? { path: shell, kind: name } : { path: snapshots.bash };
}

/** Whether this process is capturing now. Decided before any await, so a second command arriving meanwhile starts a login shell. */
let capturing = false;
let loads = 0;

/** Forgets this process's state. For tests. */
export function resetSnapshots() {
  capturing = false;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Ours, not a symlink, writable by nobody else. */
function isPrivate(path: string, directory: boolean): boolean {
  try {
    const s = lstatSync(path);
    return (directory ? s.isDirectory() : s.isFile()) && s.uid === process.getuid?.() && (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** This process's directory, private, removed when cc-remote exits. */
function privateDir(): string | undefined {
  if (!snapshots.dir) {
    snapshots.dir = mkdtempSync(join(tmpdir(), "cc-remote-shell-"));
    const dir = snapshots.dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return isPrivate(snapshots.dir, true) ? snapshots.dir : undefined;
}

/** This format's directory in the shared cache (0700, as its parents are made), if it is private. */
function cacheDir(env: Env): string | undefined {
  let root = snapshots.cacheDir;
  if (!root) {
    const xdg = env.XDG_CACHE_HOME;
    const home = env.HOME || homedir();
    if (!(xdg && isAbsolute(xdg)) && !home) return undefined;
    root = join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "cc-remote", "shell");
  }
  const dir = join(root, `v${FORMAT}`);
  try {
    if (!isPrivate(dir, true)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  // Whoever could write the parent could swap the directory itself.
  return isPrivate(root, true) && isPrivate(dir, true) ? dir : undefined;
}

/** What a snapshot depends on besides the startup files: the format, machine, user and shell, and the environment it starts from. */
function snapshotKey(shell: LoginShell, env: Env): string {
  const skip = new Set(SKIP.split(" "));
  const inherited = Object.entries(env).filter(([k, v]) => v !== undefined && !skip.has(k) && !PER_PROCESS.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  const key = JSON.stringify([FORMAT, hostname(), process.getuid?.() ?? -1, shell.path, env.HOME ?? "", env.ZDOTDIR ?? "", inherited]);
  return `${basename(shell.path)}-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** A failure record: when the capture failed, and when it started, for the startup files. */
type Failure = { at: number; stamp: number };

function readFailure(file: string): Failure | undefined {
  const record = JSON.parse(readFileSync(file, "utf8"));
  return typeof record?.at === "number" && typeof record?.stamp === "number" ? record : undefined;
}

/**
 * Whether a file is there that this version can't vouch for: not private, or not a snapshot or
 * failure record of this format and shell. Such a file is left alone, and this process keeps its own.
 */
function foreign(file: string, shell: LoginShell): boolean {
  try {
    lstatSync(file);
  } catch {
    return false; // Nothing there yet.
  }
  try {
    if (!isPrivate(file, false)) return true;
    return file.endsWith(".failed") ? !readFailure(file) : firstLine(file) !== `${HEADER} ${shell.path}`;
  } catch {
    return true;
  }
}

/** Where this environment's snapshot, failure record and lock go: the shared cache, else this process's directory. */
function locate(shell: LoginShell, env: Env): { file: string; failure: string; lock: string } | undefined {
  const key = snapshotKey(shell, env);
  const at = (dir: string) => ({ file: join(dir, `${key}.sh`), failure: join(dir, `${key}.failed`), lock: join(dir, `${key}.lock`) });
  const shared = cacheDir(env);
  if (shared) {
    const paths = at(shared);
    if (!foreign(paths.file, shell) && !foreign(paths.failure, shell)) return paths;
  }
  const own = privateDir();
  return own ? at(own) : undefined;
}

/** The snapshot file for this environment's login shell, used or not. */
export function snapshotFile(env: Env = Bun.env): string | undefined {
  const shell = loginShell(env);
  return shell.kind ? locate(shell, env)?.file : undefined;
}

/** Files a login bash or zsh reads. A dotfile that is a symlink into a dotfiles repository counts by its target. */
function startupFiles(shell: LoginShell, env: Env): string[] {
  const home = env.HOME ?? "";
  const zdot = env.ZDOTDIR || home;
  const own = home ? [".profile", ".bash_profile", ".bash_login", ".bashrc"].map((f) => join(home, f)) : [];
  const zsh = zdot ? [".zshenv", ".zprofile", ".zlogin", ".zshrc"].map((f) => join(zdot, f)) : [];
  return [shell.path, ...snapshots.systemFiles, ...own, ...zsh];
}

/** True when one of the files, or an entry of one that is a directory, changed after `stamp`. */
function changedSince(files: string[], stamp: number): boolean {
  for (const file of files) {
    try {
      const s = statSync(file);
      if (s.mtimeMs > stamp) return true;
      if (s.isDirectory() && readdirSync(file).some((e) => {
        try { return statSync(join(file, e)).mtimeMs > stamp; } catch { return false; }
      })) return true;
    } catch {}
  }
  return false;
}

/** The file's first line, read without reading the rest. */
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0)).split("\n")[0]!;
  } finally {
    closeSync(fd);
  }
}

/** A snapshot to load: the file, and its identity and capture time (its mtime) as chosen. */
type Snapshot = { file: string; ino: number; stamp: number };

/**
 * The per-command check: a private snapshot of this shell, recent, and newer than every startup
 * file. Its modification time is when its capture started, so a file edited meanwhile is newer.
 */
function usable(file: string, shell: LoginShell, env: Env): Snapshot | undefined {
  try {
    if (!isPrivate(join(file, ".."), true) || !isPrivate(file, false)) return undefined;
    const s = statSync(file);
    if (Date.now() - s.mtimeMs > snapshots.maxAgeMs || firstLine(file) !== `${HEADER} ${shell.path}`) return undefined;
    return changedSince(startupFiles(shell, env), s.mtimeMs) ? undefined : { file, ino: s.ino, stamp: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Runs a process in its own group with output to files, stopping the group at the deadline. */
async function runFor(argv: string[], opts: { cwd: string; env: Env; out?: string; err?: string; timeoutMs: number }) {
  const fds = [opts.out, opts.err].map((f) => (f ? openSync(f, "a") : undefined));
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Output goes to files: a daemon a profile starts would hold a pipe open past the deadline.
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, detached: true, stdin: "ignore", stdout: fds[0] ?? "ignore", stderr: fds[1] ?? "ignore" });
  } finally {
    for (const fd of fds) if (fd !== undefined) closeSync(fd);
  }
  groups.add(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(proc.pid); }, opts.timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  groups.delete(proc.pid);
  return timedOut ? "timeout" : code;
}

const text = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return undefined; } };

/**
 * Takes the capture lock, a file holding the owner's pid. One left by a process that died, or older
 * than any capture, is broken. Two processes breaking it at once only means two captures: each
 * renames a complete snapshot into place.
 */
function lock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    if (!abandoned(path)) return false;
    try { unlinkSync(path); } catch {}
  }
  return false;
}

function abandoned(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > snapshots.lockStaleMs) return true;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false; // Being written, or its writer died at once: wait for its age.
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return ["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "");
  }
}

/** A failed capture waits for the retry period, or a changed startup file. The record is shared like the snapshot. */
function mayCapture(failure: string, shell: LoginShell, env: Env): boolean {
  let record: Failure | undefined;
  try {
    record = isPrivate(failure, false) ? readFailure(failure) : undefined;
  } catch {}
  return !record || !(Date.now() - record.at <= snapshots.retryMs) || changedSince(startupFiles(shell, env), record.stamp);
}

function fail(failure: string | undefined, record: Failure, reason: string, detail = ""): undefined {
  snapshots.log(`no login shell snapshot (${reason}); commands start a login shell for now${detail ? `\n${detail}` : ""}`);
  if (!failure) return undefined;
  const temporary = `${failure}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...record, reason })}\n`, { mode: 0o600 });
    renameSync(temporary, failure);
  } catch {
    rmSync(temporary, { force: true });
  }
  return undefined;
}

/**
 * Removes this format's snapshots and failure records nobody refreshed for a long time, and its
 * captures that never finished. Nothing else in the directory is touched.
 */
function prune(dir: string) {
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const age = now - lstatSync(path).mtimeMs;
      if ((/^(bash|zsh)-[0-9a-f]{32}\.(sh|failed)$/.test(name) && age > snapshots.pruneMs) || (/^\.capture-\w+$/.test(name) && age > snapshots.lockStaleMs)) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {}
  }
}

/** Captures a new snapshot into `file`, or records why it couldn't and returns undefined. */
async function capture(shell: LoginShell & { kind: Kind }, file: string, failure: string, cwd: string, env: Env): Promise<Snapshot | undefined> {
  const dir = join(file, "..");
  const work = mkdtempSync(join(dir, ".capture-"));
  try {
    // The snapshot takes the capture's start time, so a startup file edited during the capture is newer.
    const stampFile = join(work, "stamp");
    writeFileSync(stampFile, "");
    const stamp = statSync(stampFile).mtimeMs;
    const failed = (reason: string, detail?: string) => fail(failure, { at: Date.now(), stamp }, reason, detail);
    const output = join(work, "snapshot");
    const errors = join(work, "capture.err");
    const { __CC_REMOTE_PWD: _, ...childEnv } = env;
    const skip = [SKIP, ...Object.keys(childEnv).filter((k) => PER_PROCESS.test(k))].join(" ");
    const script = shell.kind === "bash" ? CAPTURE_BASH : CAPTURE_ZSH;
    const status = await runFor([shell.path, "-lc", script, "cc-remote", output, skip, shell.path], { cwd, env: childEnv, err: errors, timeoutMs: snapshots.captureTimeoutMs });
    const stderr = () => (text(errors) ?? "").split("\n").slice(0, 5).join("\n").trim();
    if (status === "timeout") return failed(`the login shell did not finish within ${snapshots.captureTimeoutMs}ms`, stderr());
    if (status !== 0 || !text(output)) return failed(`the login shell exited with status ${status}`, stderr());
    chmodSync(output, 0o600);
    // Loading it must print exactly what the same shell prints without it.
    const [plainOut, loadOut] = [join(work, "plain.out"), join(work, "load.out")];
    const check = { cwd, env: childEnv, timeoutMs: snapshots.checkTimeoutMs };
    const plain = await runFor([shell.path, "-c", "printf %s CC_REMOTE_SNAPSHOT_OK"], { ...check, out: plainOut, err: plainOut });
    const load = await runFor([shell.path, "-c", '. "$1" && [ "${__cc_snapshot_complete:-}" = 1 ] && printf %s CC_REMOTE_SNAPSHOT_OK', "cc-remote", output], { ...check, out: loadOut, err: loadOut });
    if (plain !== 0 || load !== 0 || text(plainOut) !== text(loadOut)) return failed("the snapshot did not load silently and completely");
    utimesSync(output, stamp / 1000, stamp / 1000);
    renameSync(output, file);
    rmSync(failure, { force: true });
    try { prune(dir); } catch {}
    return usable(file, shell, env) ?? { file, ino: statSync(file).ino, stamp };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * How to run a script in the user's login environment. The snapshot is loaded before the script;
 * a marker file stays empty unless it loaded completely, also when the shell dies loading it. Then
 * the command never started: the snapshot is dropped and done() asks for one more launch, which
 * starts a login shell.
 */
export async function loginLaunch(script: string, cwd: string, env: Env = Bun.env): Promise<Launch> {
  const shell = loginShell(env);
  const login: Launch = { argv: [shell.path, "-lc", script] };
  if (!shell.kind || env.CC_REMOTE_SHELL_SNAPSHOT === "off") return login;
  const paths = locate(shell, env);
  const own = privateDir();
  if (!paths || !own) return login;
  const { file, failure } = paths;
  let snapshot = usable(file, shell, env);
  if (!snapshot) {
    // Decided before any await: one capture per process, and per user while the lock is held.
    if (capturing || !mayCapture(failure, shell, env) || !lock(paths.lock)) return login;
    capturing = true;
    try {
      // Another process may have finished one between the check and the lock.
      snapshot = usable(file, shell, env) ?? await capture(shell as LoginShell & { kind: Kind }, file, failure, cwd, env);
    } catch (e) {
      snapshot = fail(failure, { at: Date.now(), stamp: Date.now() }, `the capture could not run: ${(e as Error).message}`);
    } finally {
      capturing = false;
      rmSync(paths.lock, { force: true });
    }
    if (!snapshot) return login;
  }
  const s = snapshot;
  const marker = join(own, `loaded-${process.pid}-${++loads}`);
  const load = `: >| ${quote(marker)}; . ${quote(s.file)} && [ "\${__cc_snapshot_complete:-}" = 1 ] && printf ok >| ${quote(marker)} || { printf '%s\\n' 'cc-remote: the login shell snapshot did not load' >&2; exit 125; }; unset __cc_snapshot_complete\n`;
  return {
    argv: [shell.path, "-c", load + script],
    done: () => {
      const loaded = text(marker);
      rmSync(marker, { force: true });
      if (loaded !== "") return false;
      // Drop the snapshot that failed, unless another process has replaced it since.
      try { if (statSync(s.file).ino === s.ino) rmSync(s.file, { force: true }); } catch {}
      fail(failure, { at: Date.now(), stamp: s.stamp }, "the snapshot did not load for a command");
      return true;
    },
  };
}
