import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../setup/files";
import { older, versionCache } from "../version";
import { latestVersion } from "./release";

/**
 * The "a new version is available" line setup and doctor print. Never more than a line: nothing is
 * downloaded or installed without `cc-remote update`. The latest version is cached for a day in
 * `latest-release.json` beside the version cache; a check takes at most 2 seconds and fails
 * silently. `--check` modes only read the cache.
 */
const DAY = 24 * 60 * 60_000;

const cacheFile = () => join(versionCache.dir, "latest-release.json");

export function cachedLatest(): { tag: string; checkedAt: number } | undefined {
  const data = readPrivateJson(cacheFile());
  return typeof data?.tag === "string" && typeof data.checkedAt === "number" ? { tag: data.tag, checkedAt: data.checkedAt } : undefined;
}

/** Asks GitHub for the latest version when the cache is a day old. Errors are silent. */
export async function refreshLatest(env: Record<string, string | undefined> = process.env, now = Date.now()) {
  const cached = cachedLatest();
  if (cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < DAY) return;
  try {
    const version = await latestVersion(env, 2_000);
    writePrivateJson(cacheFile(), { tag: `v${version}`, checkedAt: now });
  } catch {}
}

/** The notice for this version, when the cached latest one is newer. */
export function updateNotice(current: string, zh = false): string | undefined {
  const latest = cachedLatest()?.tag.replace(/^v/, "");
  if (!latest || !/^\d+\.\d+\.\d+/.test(latest) || !older(current, latest)) return undefined;
  return zh ? `cc-remote ${latest} 已发布（当前 ${current}）：cc-remote update` : `cc-remote ${latest} is available (you have ${current}): cc-remote update`;
}
