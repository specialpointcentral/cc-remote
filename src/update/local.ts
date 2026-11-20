import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../../package.json";

/**
 * Builds from a local source checkout, which is where cc-remote updates come from: `bun run
 * compile` stamps each binary with the checkout it was built from and an id for that source, and
 * `cc-remote update` builds the checkout again when its id has moved on.
 */

/** Defined by scripts/compile.ts (`bun build --define`); absent from source and in other builds. */
declare const CC_REMOTE_BUILD: string | undefined;

type Build = { id: string; source: string };

export const BUILD: Build | undefined = (() => {
  try {
    const build = typeof CC_REMOTE_BUILD === "string" ? JSON.parse(CC_REMOTE_BUILD) : undefined;
    return typeof build?.id === "string" && typeof build.source === "string" ? build : undefined;
  } catch {
    return undefined;
  }
})();

/** What `--version` leads with, and this binary's folder name in a managed install. */
export const VERSION_ID = BUILD?.id ?? pkg.version;

/** What a build is made from: a change anywhere else (docs, tests) needs no new binary. */
const INPUTS = ["src", "scripts", "package.json", "bun.lock", "patches", "orca-usage-plugin"];

async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["git", "-C", root, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id a build of this checkout gets now: package.json's version and the HEAD commit, then, when
 * the build inputs differ from HEAD (staged, unstaged, untracked or deleted), a hash of them. The
 * checkout is left as it is: changes go into a copy of its index, and the objects that makes into a
 * folder of their own, the repository's being only read. Undefined when it isn't a checkout.
 */
export async function sourceId(root: string): Promise<string | undefined> {
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
  const [commit, status, where, tracked] = await Promise.all([
    git(root, ["rev-parse", "--short=7", "HEAD"]),
    // Clean inputs, the usual case, need no hash: status says so, without writing the index.
    git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...INPUTS], { GIT_OPTIONAL_LOCKS: "0" }),
    git(root, ["rev-parse", "--git-path", "index", "--git-path", "objects"]),
    git(root, ["ls-files", "--", ...INPUTS]),
  ]);
  if (typeof version !== "string" || !commit || status === undefined) return undefined;
  if (status === "") return `${version}-${commit}`;
  const [index, objects] = where?.split("\n") ?? [];
  if (!index || !objects || tracked === undefined) return undefined;
  // What there is to stage: an input on disk, or one git tracks that is gone (a deleted folder too).
  const known = new Set(tracked.split("\n").map((f) => f.split("/")[0]));
  const paths = INPUTS.filter((p) => existsSync(join(root, p)) || known.has(p));
  const temp = mkdtempSync(join(tmpdir(), "cc-remote-source-"));
  try {
    if (existsSync(resolve(root, index))) copyFileSync(resolve(root, index), join(temp, "index"));
    mkdirSync(join(temp, "objects"));
    const env = { GIT_INDEX_FILE: join(temp, "index"), GIT_OBJECT_DIRECTORY: join(temp, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(root, objects) };
    if (paths.length && (await git(root, ["add", "-A", "--", ...paths], env)) === undefined) return undefined;
    const tree = await git(root, ["write-tree"], env);
    const [now, head] = await Promise.all([tree ? git(root, ["ls-tree", tree, "--", ...INPUTS], env) : undefined, git(root, ["ls-tree", "HEAD", "--", ...INPUTS])]);
    if (now === undefined || head === undefined) return undefined;
    return now === head ? `${version}-${commit}` : `${version}-${commit}.${createHash("sha256").update(now).digest("hex").slice(0, 8)}`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
