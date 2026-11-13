import { REPO, VERSION } from "../install/layout";

/**
 * GitHub releases: the latest tag from the API, the assets and SHA256SUMS from the release's
 * download folder. CC_REMOTE_RELEASE_API and CC_REMOTE_RELEASE_BASE point both somewhere else, for
 * tests only.
 */
type Env = Record<string, string | undefined>;

export const releaseApi = (env: Env = process.env) => env.CC_REMOTE_RELEASE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
export const releaseBase = (env: Env = process.env) => (env.CC_REMOTE_RELEASE_BASE || `https://github.com/${REPO}/releases`).replace(/\/+$/, "");

/** The newest release's version, without the tag's `v`. */
export async function latestVersion(env: Env = process.env, timeoutMs = 15_000): Promise<string> {
  const response = await fetch(releaseApi(env), {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "cc-remote" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${releaseApi(env)}: HTTP ${response.status}`);
  const tag = String(((await response.json()) as { tag_name?: unknown }).tag_name ?? "");
  const version = tag.replace(/^v/, "");
  if (!VERSION.test(version)) throw new Error(`the latest release has an unexpected tag: ${tag || "none"}`);
  return version;
}

/** Downloads a release file to `path`. */
export async function download(version: string, name: string, path: string, env: Env = process.env, timeoutMs = 10 * 60_000) {
  const url = `${releaseBase(env)}/download/v${version}/${name}`;
  const response = await fetch(url, { headers: { "User-Agent": "cc-remote" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await Bun.write(path, response);
}

/** The checksum SHA256SUMS lists for a file (`<hex>  <name>`, or `*<name>` in binary mode). */
export function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return undefined;
}

/** A file's SHA-256, in hex. */
export async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
