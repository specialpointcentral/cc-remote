import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createPopover } from './popover.mjs';

test('opens one popover, streams updates, handles refresh and closes on a second click', async () => {
  const child = new EventEmitter();
  const lines = [];
  child.stdin = new Writable({ write(chunk, encoding, done) { lines.push(String(chunk)); done(); } });
  child.stdout = new PassThrough();
  child.kill = () => { child.emit('exit', 0); return true; };
  let launches = 0;
  let refreshes = 0;
  const popover = createPopover(async () => { launches++; return child; }, () => { refreshes++; });
  await popover.toggle({ rows: [{ label: 'Fable', used: 42 }] });
  popover.update({ rows: [{ label: 'Fable', used: 43 }] });
  assert.equal(launches, 1);
  assert.equal(JSON.parse(lines[0]).rows[0].used, 42);
  assert.equal(JSON.parse(lines[1]).rows[0].used, 43);
  child.stdout.write('{"action":"refresh"}\n');
  assert.equal(refreshes, 1);
  await popover.toggle({ rows: [] });
  assert.equal(popover.isOpen(), false);
  popover.stop();
});

test('a click while it starts lets it open rather than cancelling it', async () => {
  let finish;
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, encoding, done) { done(); } });
  child.stdout = new PassThrough();
  child.kill = () => true;
  const popover = createPopover(() => new Promise((resolve) => { finish = resolve; }), () => {});
  const opening = popover.toggle({ rows: [] });
  await popover.toggle({ rows: [] });
  finish(child);
  await opening;
  assert.equal(popover.isOpen(), true);
  popover.stop();
});

test('does not leave a popover running if the plugin stops during startup', async () => {
  let finish;
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new Writable({ write(chunk, encoding, done) { done(); } });
  child.stdout = new PassThrough();
  child.kill = () => { killed = true; return true; };
  const popover = createPopover(() => new Promise((resolve) => { finish = resolve; }), () => {});
  const opening = popover.toggle({ rows: [] });
  popover.stop();
  finish(child);
  await opening;
  assert.equal(killed, true);
  assert.equal(popover.isOpen(), false);
});
