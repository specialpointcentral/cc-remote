import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { HostFiles } from "../host-fs";
import type { Monitors } from "../monitor";

export const home = homedir();

/**
 * One session's directories: relative paths resolve against root; Bash's cwd follows its `cd`s.
 * `host` knows the host's own files (host-fs.ts) once the session's claude has started. `envFile`
 * is where the session's SessionStart hooks write `export` lines (CLAUDE_ENV_FILE), which Bash
 * runs before each command, as Claude Code's own Bash does. `monitors` runs claude's Monitor
 * commands here, once the session's claude has started under the relay (monitor.ts).
 */
export type Workspace = { root: string; cwd: string; host?: HostFiles; envFile?: string; monitors?: Monitors };

export const workspace = (root: string): Workspace => ({ root, cwd: root });

export const abs = (ws: Workspace, p: string) =>
  p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? resolve(home, p.slice(2)) : isAbsolute(p) ? p : resolve(ws.root, p);

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const err = (text: string) => ({ ...ok(text), isError: true });

/** ripgrep and grep, when installed. Fields, so tests can take ripgrep away. */
export const bins = { rg: Bun.which("rg"), grep: Bun.which("grep") };

/**
 * A path to search, as ripgrep needs it, and how to put back what it prints. ripgrep matches a
 * glob against paths relative to its working directory, which it knows with links resolved: a
 * path reached through a link (macOS's /tmp, say) lies outside it, and a glob that is anchored
 * there, as Glob's all are, matches nothing. So ripgrep gets the path resolved, and `shown` gives
 * what it prints the path the model named back.
 */
export function forRipgrep(path: string): { real: string; shown: (line: string) => string } {
  const named = resolve(path);
  let real = named;
  try {
    real = realpathSync(named);
  } catch {
    // Missing: ripgrep says so.
  }
  if (real === named) return { real, shown: (line) => line };
  return { real, shown: (line) => (line === real || line.startsWith(real + sep) ? named + line.slice(real.length) : line) };
}

/**
 * The lines of a stream as they arrive, each cut to its first `keep` characters, without the
 * newline. A last line without one counts too; nothing after the last newline is no line. Leaving
 * the loop early cancels the stream, so a reader takes only what it uses.
 */
export async function* streamLines(stream: ReadableStream<Uint8Array>, keep = Infinity): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let open = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let i = 0;
      for (let nl = chunk.indexOf("\n"); nl >= 0; nl = chunk.indexOf("\n", i)) {
        if (line.length < keep) line += chunk.slice(i, Math.min(nl, i + keep - line.length));
        yield line;
        line = "";
        open = false;
        i = nl + 1;
      }
      if (i < chunk.length) {
        open = true;
        if (line.length < keep) line += chunk.slice(i, Math.min(chunk.length, i + keep - line.length));
      }
      if (done) break;
    }
    if (open) yield line;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The first `max` characters of a stream, read to its end so its writer never blocks. For error output. */
export async function head(stream: ReadableStream<Uint8Array>, max = 2_000): Promise<string> {
  let text = "";
  for await (const line of streamLines(stream, max)) if (text.length < max) text += `${line}\n`;
  return text.slice(0, max).trim();
}
