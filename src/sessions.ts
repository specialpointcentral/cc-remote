import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { home } from "./tools/util";

export const projectsDir = () => join(Bun.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");

/** Claude Code's folder name for a project: the real path with every non-alphanumeric turned to `-`. */
export function projectKey(cwd: string): string {
  let path = cwd;
  try { path = realpathSync(cwd); } catch {}
  if (process.platform === "darwin") path = path.normalize("NFC");
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

const lines = (entries: SessionStoreEntry[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");

/**
 * Appends mirrored entries where a local claude would have written them. Synchronous, so entries
 * from consecutive frames land in the order claude sent them.
 */
export function writeMirror(key: SessionKey, entries: SessionStoreEntry[]) {
  const dir = join(projectsDir(), key.projectKey);
  if (!key.subpath) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${key.sessionId}.jsonl`), lines(entries));
    return;
  }
  // Subagent transcripts, laid out as the SDK's own store import does.
  const base = join(dir, key.sessionId, key.subpath);
  mkdirSync(dirname(base), { recursive: true });
  const meta = entries.filter((e) => e.type === "agent_metadata");
  const rest = entries.filter((e) => e.type !== "agent_metadata");
  if (rest.length) appendFileSync(`${base}.jsonl`, lines(rest));
  if (meta.length) {
    const { type: _, ...last } = meta.at(-1)!;
    writeFileSync(`${base}.meta.json`, JSON.stringify(last));
  }
}

/**
 * The session a transcript file under the local projects folder belongs to, read as the SDK reads
 * a transcript_mirror frame's path: `<project>/<session>.jsonl`, or a subagent's file below
 * `<project>/<session>/`. Anything else is not a transcript.
 */
export function mirrorKey(filePath: string): SessionKey | undefined {
  const rel = relative(projectsDir(), filePath);
  const parts = rel.split(sep);
  if (parts[0] === ".." || isAbsolute(rel) || parts.length < 2) return undefined;
  const [project, session, ...rest] = parts as [string, string, ...string[]];
  if (!rest.length) return session.endsWith(".jsonl") ? { projectKey: project, sessionId: session.slice(0, -6) } : undefined;
  if (rest.length < 2) return undefined;
  return { projectKey: project, sessionId: session, subpath: rest.join("/").replace(/\.jsonl$/, "") };
}

/**
 * The remote claude writes the transcript on its host, and mirrors each entry back over the SDK
 * channel. This writes the mirror where a local claude would have written the file, so ACP's
 * session list, history replay, fork and titles read it like any other session. load() returns
 * nothing: the host still has its own copy to resume from.
 */
export const mirror: SessionStore = {
  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    writeMirror(key, entries);
  },
  async load() {
    return null;
  },
};

/** The local transcript of a session, preferring the one under this directory's project. */
export function localTranscript(sessionId: string, cwd: string): string | undefined {
  const own = join(projectsDir(), projectKey(cwd), `${sessionId}.jsonl`);
  if (existsSync(own)) return own;
  try {
    for (const file of new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: projectsDir(), absolute: true })) return file;
  } catch {} // No projects folder yet.
  return undefined;
}
