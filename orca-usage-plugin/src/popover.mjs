/** Owns only the popover process started by this plugin. */
export function createPopover(launch, onRefresh) {
  let child;
  let opening;
  let buffer = '';
  let generation = 0;

  const stop = () => {
    generation++;
    if (!child) return;
    const previous = child;
    child = undefined;
    previous.kill();
  };
  const update = (state) => {
    if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(state)}\n`);
  };
  const toggle = async (state) => {
    // A second click while it starts (the first open after an update compiles it) lets it open.
    if (opening) return;
    if (child) { stop(); return; }
    const startedGeneration = ++generation;
    opening = launch();
    try {
      const started = await opening;
      if (startedGeneration !== generation) {
        started.on('error', () => {});
        started.kill();
        return;
      }
      child = started;
      buffer = '';
      started.stdin?.on('error', () => {});
      started.on('error', () => { if (child === started) child = undefined; });
      started.on('exit', () => { if (child === started) child = undefined; });
      started.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        if (buffer.length > 4096) buffer = '';
        for (let n; (n = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          try { if (JSON.parse(line)?.action === 'refresh') onRefresh(); } catch {}
        }
      });
      update(state);
    } finally { opening = undefined; }
  };
  return { toggle, update, stop, isOpen: () => Boolean(child) };
}
