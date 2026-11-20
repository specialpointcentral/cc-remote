import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPopover } from './popover.mjs';

const MAX_AGE = 30 * 60_000;
/** Refresh in the background once the oldest shown value is this old, and no more often. */
const AUTO_AGE = 20 * 60_000;
/** After a failed refresh, wait this long before trying again on its own. */
const FAILED_GAP = 30 * 60_000;
const HOUR = 3600_000;
/** The windows' lengths; model-specific limits are weekly. */
const FIVE_HOURS = 5 * HOUR, WEEK = 7 * 24 * HOUR;
let timer;
let popover;
const run = promisify(execFile);

const validWindow = (w) => w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && Number.isFinite(Date.parse(w.observedAt));

/** Match the remote status line's compact reset countdown. */
function remainingTime(reset, now = Date.now()) {
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= now) return null;
  const seconds = Math.floor((reset - now) / 1000);
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return '<1m';
}

/**
 * The remote status line's colours (`pace_c` in its statusline-command.sh): "ok" at or under the
 * even pace for the time gone in the window, "warn" over it, "high" over it by 60% of the headroom
 * left (pace 50%: over 50% warns, over 80% is high). Without a reset ahead, its fixed 50%/80% scale.
 */
export function paceLevel(used, resetsAt, windowMs, now = Date.now()) {
  if (typeof resetsAt === 'number' && resetsAt > now) {
    const pace = ((windowMs - Math.min(resetsAt - now, windowMs)) / windowMs) * 100;
    return used > pace + (100 - pace) * 0.6 ? 'high' : used > pace ? 'warn' : 'ok';
  }
  return used >= 80 ? 'high' : used >= 50 ? 'warn' : 'ok';
}

/** The popover's rows: 5 hours, 7 days, Fable, then any other model limit. */
export function formatPanel(account, modelLimits, now = Date.now()) {
  const models = Array.isArray(modelLimits?.models) ? modelLimits.models.filter((m) => typeof m?.name === 'string') : [];
  const isFable = (m) => m.name.toLowerCase() === 'fable';
  return [
    ['5 小时', account?.fiveHour, FIVE_HOURS], ['7 天', account?.sevenDay, WEEK], ['Fable', models.find(isFable), WEEK],
    ...models.filter((m) => !isFable(m)).map((m) => [m.name, m, WEEK]),
  ].map(([label, w, windowMs]) => {
    if (!validWindow(w)) return { label, used: null, remaining: null, stale: false, level: null };
    const stale = now - Date.parse(w.observedAt) > MAX_AGE || (typeof w.resetsAt === 'number' && w.resetsAt <= now);
    return { label, used: w.usedPercent, remaining: remainingTime(w.resetsAt, now), stale, level: paceLevel(w.usedPercent, w.resetsAt, windowMs, now) };
  });
}

const TONE = { ok: 'neutral', warn: 'warning', high: 'danger' };

/**
 * The status-bar item, labelled remote, apart from Orca's local Claude account: the five-hour row
 * (else the seven-day one), stale and coloured by that row alone, not by limits it doesn't show.
 */
export function formatStatus(rows) {
  const [five, seven] = rows;
  const shown = five.used !== null ? five : seven;
  if (shown.used === null) return { id: 'remote-usage', text: '远程 Claude：等待数据', tooltip: '点击查看远程 Claude 用量', tone: 'neutral' };
  const text = `远程 Claude ${shown === seven ? '7 天 ' : ''}${shown.used}%${shown.stale ? '（过期）' : ''}`;
  return { id: 'remote-usage', text, tooltip: '点击查看远程 Claude 用量', tone: TONE[shown.level] };
}

/** Whether to refresh on its own: no data yet, data getting old, or a window past its reset. */
export function refreshDue(account, modelLimits, rows, now = Date.now()) {
  const observed = [account?.fiveHour, account?.sevenDay, ...(Array.isArray(modelLimits?.models) ? modelLimits.models : [])]
    .filter(validWindow).map((w) => Date.parse(w.observedAt));
  return !observed.length || now - Math.min(...observed) > AUTO_AGE || rows.some((row) => row.stale);
}

/** cc-remote's cache folder, found as cc-remote finds it (src/version.ts): test/plugin-contract.test.ts checks they agree. */
export function cacheRoot() {
  if (process.env.CC_REMOTE_USAGE_CACHE_DIR) return process.env.CC_REMOTE_USAGE_CACHE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cc-remote');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'cc-remote');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'cc-remote');
}

function readSmall(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65_536 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) return undefined;
    return readFileSync(path, 'utf8');
  } catch { return undefined; }
}

/** This host's cache files, named as cc-remote's usage.ts names them: by the host's sha256 alone. */
export function readCache(dir, host) {
  const key = createHash('sha256').update(host).digest('hex').slice(0, 24);
  const read = (kind) => {
    try {
      const data = JSON.parse(readSmall(join(dir, `${kind}-usage-v1-${key}.json`)) ?? '');
      return data?.host === host ? data : undefined;
    } catch { return undefined; /* None yet, or not ours. */ }
  };
  return { account: read('account'), model: read('model'), session: read('session') };
}

/** Compile the macOS view from this approved plugin's source into a private cache. */
async function popoverExecutable(signal) {
  const source = fileURLToPath(new URL('./usage-popover.swift', import.meta.url));
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const root = cacheRoot();
  const directory = join(root, 'popover');
  for (const path of [root, directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('popover cache is not private');
  }
  const executable = join(directory, `usage-${process.arch}-${digest}`);
  if (existsSync(executable)) {
    const info = lstatSync(executable);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || !(info.mode & 0o100)) throw new Error('popover executable is not private');
    return executable;
  }
  const temp = `${executable}.${process.pid}.tmp`;
  try {
    await run('/usr/bin/swiftc', ['-O', source, '-o', temp], { timeout: 60_000, windowsHide: true, signal });
    chmodSync(temp, 0o700);
    renameSync(temp, executable);
    return executable;
  } finally { rmSync(temp, { force: true }); }
}

/** Runs `task` now, or once more right after the run in progress: a call while it runs is never lost. */
export function coalesce(task) {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { await task(); } finally {
      running = false;
      if (again) { again = false; void run(); }
    }
  };
  return run;
}

let compiling;
let stopCompiling;
/** The popover's binary, compiled at most once at a time; deactivate() stops a compile in progress. */
function popoverBinary() {
  if (!compiling) {
    stopCompiling = new AbortController();
    compiling = popoverExecutable(stopCompiling.signal).catch((e) => { compiling = undefined; throw e; });
  }
  return compiling;
}

export default function activate(orca) {
  const dir = cacheRoot();
  let lastStatus = '';
  let lastPopover = '';
  let lastQuery = 0;
  let querying = false;
  let queryFailed = false;
  let popoverState = { rows: [], tokens: null, querying: false, queryFailed: false, host: '' };
  const hostName = () => process.env.CC_REMOTE_HOST?.trim() || readSmall(join(homedir(), '.config', 'cc-remote', 'host'))?.trim() || '';
  // A refresh asked for while one runs (a query starting or ending) runs right after it.
  const refresh = coalesce(async () => {
    try {
      const host = hostName();
      const { account, model, session } = readCache(dir, host);
      const rows = formatPanel(account, model);
      const status = formatStatus(rows);
      popoverState = { rows, tokens: session?.totals ?? null, querying, queryFailed, host };
      // Apart: the popover's countdowns change every minute, the status bar's text rarely.
      const statusText = JSON.stringify(status);
      if (statusText !== lastStatus) {
        await orca.host.call('statusBar.update', status);
        lastStatus = statusText;
      }
      const popoverText = JSON.stringify(popoverState);
      if (popoverText !== lastPopover) {
        popover?.update(popoverState);
        lastPopover = popoverText;
      }
      // Sessions update the main windows only while they run, and model limits not at all.
      if (host && refreshDue(account, model, rows)) fetchRemote(queryFailed ? FAILED_GAP : AUTO_AGE);
    } catch (e) { console.error('Remote Claude usage status:', e.message); }
  });
  /** Runs `cc-remote usage`, which saves what it gets, unless one ran less than `minGap` ago. */
  const fetchRemote = (minGap) => {
    if (querying || Date.now() - lastQuery < minGap) return;
    lastQuery = Date.now();
    querying = true;
    queryFailed = false;
    void refresh();
    const localBinary = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'cc-remote.exe' : 'cc-remote');
    const binary = existsSync(localBinary) ? localBinary : 'cc-remote';
    void run(binary, ['usage'], { timeout: 30_000, windowsHide: true })
      .catch(() => { queryFailed = true; })
      .finally(() => { querying = false; void refresh(); });
  };
  if (process.platform === 'darwin') {
    // Ahead of the first click, which then opens it at once instead of waiting for swiftc.
    popoverBinary().catch((e) => console.error('Remote Claude usage popover:', e.message));
    popover = createPopover(async () => {
      const child = spawn(await popoverBinary(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.on('data', (data) => console.error('Remote Claude usage popover:', String(data).trim()));
      return child;
    }, () => fetchRemote(0));
  }
  orca.commands?.register('usage.open', async () => {
    if (popover) {
      const currentPopover = popover;
      try {
        await currentPopover.toggle(popoverState);
        if (currentPopover.isOpen()) fetchRemote(60_000);
      } catch (e) {
        console.error('Remote Claude usage popover:', e.message);
        return '无法打开远程 Claude 用量弹窗';
      }
      return;
    }
    return '远程 Claude 用量弹窗目前仅支持 macOS';
  });
  void refresh();
  // Reads local files; asks the host only through refreshDue's throttle, or when the popover opens.
  timer = setInterval(refresh, 10_000);
  timer.unref?.();
}

export function deactivate() {
  if (timer) clearInterval(timer);
  popover?.stop();
  popover = undefined;
  stopCompiling?.abort();
  compiling = undefined;
}
