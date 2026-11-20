import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import activate, { coalesce, deactivate, formatPanel, formatStatus, paceLevel, refreshDue } from './worker.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
const recent = new Date(now - 60_000).toISOString();

test('shows the remote five-hour usage in the status bar', () => {
  const status = formatStatus(formatPanel({
    fiveHour: { usedPercent: 24, resetsAt: now + 3600_000, observedAt: recent },
    sevenDay: { usedPercent: 13, resetsAt: now + 86400_000, observedAt: recent },
  }, undefined, now));
  assert.equal(status.text, '远程 Claude 24%');
  assert.equal(status.tooltip, '点击查看远程 Claude 用量');
});

test('worker publishes the configured host data from private local cache files, never another host\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-plugin-test-'));
  const previousDir = process.env.CC_REMOTE_USAGE_CACHE_DIR;
  const previousHost = process.env.CC_REMOTE_HOST;
  process.env.CC_REMOTE_USAGE_CACHE_DIR = dir;
  process.env.CC_REMOTE_HOST = 'central';
  const observedAt = new Date().toISOString();
  const name = (host) => `account-usage-v1-${createHash('sha256').update(host).digest('hex').slice(0, 24)}.json`;
  const write = (file, host, used) => writeFileSync(join(dir, file), JSON.stringify({ host, observedAt, fiveHour: { usedPercent: used, resetsAt: null, observedAt } }), { mode: 0o600 });
  write(name('central'), 'central', 31);
  write(name('different'), 'different', 88);
  try {
    const published = new Promise((resolve) => activate({ host: { call: async (method, value) => { assert.equal(method, 'statusBar.update'); resolve(value); } } }));
    const value = await published;
    assert.equal(value.text, '远程 Claude 31%');
  } finally {
    deactivate();
    if (previousDir === undefined) delete process.env.CC_REMOTE_USAGE_CACHE_DIR; else process.env.CC_REMOTE_USAGE_CACHE_DIR = previousDir;
    if (previousHost === undefined) delete process.env.CC_REMOTE_HOST; else process.env.CC_REMOTE_HOST = previousHost;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks old quota as stale and waits when there is none', () => {
  const old = new Date(now - 31 * 60_000).toISOString();
  const status = formatStatus(formatPanel({ fiveHour: { usedPercent: 24, resetsAt: now + 60_000, observedAt: old } }, undefined, now));
  assert.match(status.text, /过期/);
  assert.match(formatStatus(formatPanel(undefined, undefined, now)).text, /等待/);
});

test('panel shows 5h, 7d and Fable limits with relative reset times', () => {
  const account = {
    fiveHour: { usedPercent: 24, resetsAt: now + 3 * 3600_000 + 15 * 60_000, observedAt: recent },
    sevenDay: { usedPercent: 13, resetsAt: now + 2 * 86400_000 + 4 * 3600_000, observedAt: recent } };
  const models = { observedAt: recent, models: [
    { name: 'Fable', usedPercent: 42, resetsAt: now + 3 * 86400_000 + 5 * 3600_000, observedAt: recent },
  ] };
  const rows = formatPanel(account, models, now);
  assert.deepEqual(rows.map(({ label, used, remaining }) => ({ label, used, remaining })), [
    { label: '5 小时', used: 24, remaining: '3h 15m' },
    { label: '7 天', used: 13, remaining: '2d 4h' },
    { label: 'Fable', used: 42, remaining: '3d 5h' },
  ]);
  assert.ok(rows.every((row) => row.stale === false));
  assert.equal(formatPanel(account, undefined, now)[2].used, null);
});

test('a refresh asked for while one runs runs once more after it, never lost', async () => {
  let runs = 0;
  let release;
  const refresh = coalesce(async () => { runs++; if (runs === 1) await new Promise((r) => (release = r)); });
  const first = refresh();
  void refresh();
  void refresh();
  assert.equal(runs, 1);
  release();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs, 2);
});

test('colours by pace as the remote status line does', () => {
  const HOUR = 3600_000;
  // Half of the five hours gone: the even pace is 50%, red past 50 + 0.6 × 50 = 80%.
  const reset = now + 2.5 * HOUR;
  assert.equal(paceLevel(50, reset, 5 * HOUR, now), 'ok');
  assert.equal(paceLevel(51, reset, 5 * HOUR, now), 'warn');
  assert.equal(paceLevel(80, reset, 5 * HOUR, now), 'warn');
  assert.equal(paceLevel(81, reset, 5 * HOUR, now), 'high');
  // Early in a week, little use already runs ahead of pace.
  assert.equal(paceLevel(10, now + 6.5 * 24 * HOUR, 7 * 24 * HOUR, now), 'warn');
  // No reset ahead: the fixed 50% / 80% scale.
  assert.equal(paceLevel(49, null, 5 * HOUR, now), 'ok');
  assert.equal(paceLevel(50, null, 5 * HOUR, now), 'warn');
  assert.equal(paceLevel(80, now - 1, 5 * HOUR, now), 'high');
});

test('the status bar takes its tone and staleness from the five-hour row alone', () => {
  const old = new Date(now - 31 * 60_000).toISOString();
  const account = { fiveHour: { usedPercent: 90, resetsAt: now + 2.5 * 3600_000, observedAt: recent } };
  const models = { models: [{ name: 'Fable', usedPercent: 5, resetsAt: now + 86400_000, observedAt: old }] };
  const rows = formatPanel(account, models, now);
  assert.equal(rows[2].stale, true);
  const status = formatStatus(rows);
  assert.equal(status.text, '远程 Claude 90%');
  assert.equal(status.tone, 'danger');
});

test('with only the seven-day window the status bar shows it, labelled', () => {
  const rows = formatPanel({ sevenDay: { usedPercent: 37, resetsAt: now + 3 * 86400_000, observedAt: recent } }, undefined, now);
  assert.equal(formatStatus(rows).text, '远程 Claude 7 天 37%');
});

test('refreshes on its own when there is no data, data is getting old, or a window is stale', () => {
  const fresh = { fiveHour: { usedPercent: 10, resetsAt: now + 3600_000, observedAt: recent } };
  assert.equal(refreshDue(fresh, undefined, formatPanel(fresh, undefined, now), now), false);
  assert.equal(refreshDue(undefined, undefined, formatPanel(undefined, undefined, now), now), true);
  const aging = { fiveHour: { ...fresh.fiveHour, observedAt: new Date(now - 21 * 60_000).toISOString() } };
  assert.equal(refreshDue(aging, undefined, formatPanel(aging, undefined, now), now), true);
  const reset = { fiveHour: { ...fresh.fiveHour, resetsAt: now - 1 } };
  assert.equal(refreshDue(reset, undefined, formatPanel(reset, undefined, now), now), true);
});
