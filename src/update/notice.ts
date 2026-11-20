import { join } from "node:path";
import { installed, layout } from "../install/layout";
import { readPrivateJson, writePrivateJson } from "../setup/files";
import { versionCache } from "../version";
import { BUILD, sourceId, VERSION_ID } from "./local";

/**
 * Whether the source checkout has a newer build than the installed cc-remote: the notice setup and
 * doctor print, and what the Orca usage plugin offers to update. Any cc-remote refreshes
 * `update-status.json` beside the version cache in the background, at most every ten minutes; a
 * check never blocks, fails silently, and is off with CC_REMOTE_NO_UPDATE_CHECK=1. Nothing is built
 * or installed without `cc-remote update`.
 */
const TTL = 10 * 60_000;

export type UpdateStatus = { current: string; latest: string; source: string; checkedAt: number };

const file = () => join(versionCache.dir, "update-status.json");

export function updateStatus(): UpdateStatus | undefined {
  const d = readPrivateJson(file());
  return typeof d?.current === "string" && typeof d.latest === "string" && typeof d.source === "string" && typeof d.checkedAt === "number" ? (d as UpdateStatus) : undefined;
}

/** The checkout to build from: CC_REMOTE_SOURCE, else the one this binary was built from. */
export const sourceDir = (env: Record<string, string | undefined>) => env.CC_REMOTE_SOURCE?.trim() || BUILD?.source;

/**
 * The installed version, which an older binary still running a chat must not stand in for: the
 * managed install's current one, else this binary's.
 */
function installedId(env: Record<string, string | undefined>) {
  const state = installed(layout(env));
  return state.kind === "managed" ? state.version : VERSION_ID;
}

export function saveUpdateStatus(status: UpdateStatus) {
  try {
    writePrivateJson(file(), status);
  } catch {}
}

/** Never throws or rejects: the callers start it in the background and go on. */
export async function refreshUpdateStatus(env: Record<string, string | undefined> = process.env, options: { force?: boolean; now?: number } = {}): Promise<UpdateStatus | undefined> {
  try {
    const source = sourceDir(env);
    if (env.CC_REMOTE_NO_UPDATE_CHECK === "1" || !source) return undefined;
    const now = options.now ?? Date.now();
    const current = installedId(env);
    const cached = updateStatus();
    const ours = cached?.current === current && cached.source === source;
    if (!options.force && ours && now - cached.checkedAt >= 0 && now - cached.checkedAt < TTL) return cached;
    // Marked as checked first: chats that start together check once, and one that fails waits too.
    if (ours) saveUpdateStatus({ ...cached, checkedAt: now });
    const latest = await sourceId(source);
    if (!latest) return undefined;
    const status = { current, latest, source, checkedAt: now };
    saveUpdateStatus(status);
    return status;
  } catch {
    return undefined;
  }
}

/** The line for setup and doctor when the checkout has a build the install doesn't. */
export function updateNotice(zh = false, env: Record<string, string | undefined> = process.env): string | undefined {
  const s = updateStatus();
  // Said of another install, such as one switched to since: not this one's to tell.
  if (!s || s.latest === s.current || s.current !== installedId(env)) return undefined;
  return zh ? `源码有新版本 ${s.latest}（已安装 ${s.current}）：cc-remote update` : `The source has a newer build, ${s.latest} (installed: ${s.current}): cc-remote update`;
}
