import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { WINDOWS } from "./platform";
import { quote } from "./sh";
import { ustarSplit } from "./tar";

/**
 * The project's own Claude Code commands, skills and agents. claude runs in an empty folder on the
 * host, so it would never find `.claude/commands`, `.claude/skills` or `.claude/agents`; these are
 * copied into that folder when a session starts. Nothing else in `.claude/` goes: settings and
 * their permission rules are applied here, and hooks would run on the host. Paths in a skill that
 * point into the host folder are mapped back to the local directory, so its scripts run here.
 */
export const TREES = ["commands", "skills", "agents"] as const;

/** Enough for any set of prompts and skills; a large binary in a skill's folder is skipped. */
export const limits = { files: 1_000, fileBytes: 1 << 20, totalBytes: 8 << 20 };

/** Never copied: version control, dependency and cache folders, and hidden files (`.env`, `.DS_Store`). */
const SKIPPED = new Set(["node_modules", "__pycache__"]);

export type ClaudeFile = {
  /** Relative to `.claude`, with `/` separators, such as `skills/review/SKILL.md`. */
  path: string;
  data: Uint8Array;
  executable: boolean;
  /** Modification time, in seconds. */
  mtime: number;
};

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The three trees under `root/.claude`, files in a fixed order (each folder's entries by name).
 * A symlink is followed only when it resolves inside its own tree, and a tree that is itself a
 * symlink only when it resolves inside the project. What doesn't fit the limits is listed in
 * `skipped` instead.
 */
export function collect(root: string): { files: ClaudeFile[]; skipped: string[] } {
  const files: ClaudeFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let project: string;
  try { project = realpathSync(root); } catch { return { files, skipped }; }

  function walk(dir: string, rel: string, tree: string, seen: Set<string>) {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      const path = `${rel}/${name}`;
      let full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
          full = realpathSync(full);
          if (!inside(full, tree)) { skipped.push(`${path} (a symlink out of .claude/${rel.split("/")[0]})`); continue; }
          stat = statSync(full);
        }
      } catch {
        continue; // A dangling symlink, or gone since the listing.
      }
      if (stat.isDirectory()) {
        if (seen.has(full)) continue; // A symlink loop.
        walk(full, path, tree, new Set(seen).add(full));
      } else if (stat.isFile()) {
        if (files.length >= limits.files) { skipped.push(`${path} (more than ${limits.files} files)`); continue; }
        if (stat.size > limits.fileBytes) { skipped.push(`${path} (larger than ${limits.fileBytes} bytes)`); continue; }
        if (total + stat.size > limits.totalBytes) { skipped.push(`${path} (over ${limits.totalBytes} bytes in all)`); continue; }
        if (!ustarSplit(path)) { skipped.push(`${path} (path too long)`); continue; }
        let data: Uint8Array;
        try { data = readFileSync(full); } catch { continue; }
        total += data.length;
        files.push({ path, data, executable: !WINDOWS && (stat.mode & 0o111) !== 0, mtime: Math.floor(stat.mtimeMs / 1000) });
      }
    }
  }

  for (const name of TREES) {
    let tree: string;
    try {
      tree = realpathSync(join(root, ".claude", name));
      if (!statSync(tree).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!inside(tree, project)) { skipped.push(`${name} (a symlink out of the project)`); continue; }
    walk(tree, name, tree, new Set([tree]));
  }
  return { files, skipped };
}

/**
 * Names the copy of the trees a host folder has, so a session start finds out with a test or two
 * whether the trees need to go up again. Kept in the host folder's `.claude`, next to them.
 *
 * The `v1` is the stamp's format. cc-remotes with other formats may share the host folder (a
 * running chat keeps its old binary), so each one reads and removes only its own stamps, and
 * counts the trees as missing when it finds none of its own. Whoever replaces the trees writes
 * its stamp last, so a stamp is current only while no `.cc-remote-sync-*` stamp, of any format,
 * is newer than it: one left behind by another format then reads as stale, not as present.
 */
const STAMP = ".cc-remote-sync-v1-";

/** A name for the trees' content: paths, modes and bytes. */
export function stamp(files: ClaudeFile[]): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const f of files) hash.update(`${f.path}\0${f.executable ? 1 : 0}\0${f.data.length}\0`).update(f.data);
  return hash.digest("hex").slice(0, 20);
}

/** The project's trees for a session start, and the stamp a host folder with this copy has. */
export function projectTrees(root: string): { files: ClaudeFile[]; skipped: string[]; stamp: string } {
  const { files, skipped } = collect(root);
  return { files, skipped, stamp: stamp(files) };
}

const hostTrees = TREES.map((t) => `.claude/${t}`).join(" ");

/** sh, run in the host folder: whether its trees are the copy with this stamp. */
export function syncedTest(s: string): string {
  const own = `.claude/${quote(STAMP + s)}`;
  return `[ -e ${own} ] && [ -z "$(find .claude/. ! -name . -prune -name '.cc-remote-sync-*' -newer ${own})" ]`;
}

/**
 * sh, run in the host folder, for a project with none of the trees: removes the host's copy, which
 * needs nothing from here, so it runs as part of the session start. Only a folder that has a
 * `.claude` has anything to remove.
 */
export const clearCommand = () => `if [ -d .claude ]; then rm -rf ${hostTrees} .claude/${STAMP}*; fi`;

/**
 * sh, run in the host folder: replaces its trees with those unpacked under `from` (a shell word),
 * then stamps them. Each tree moves in whole, so claude never sees half of one.
 */
export function installCommand(from: string, s: string): string {
  const move = `for t in ${TREES.join(" ")}; do if [ -e ${from}/"$t" ]; then mv ${from}/"$t" .claude/"$t"; fi; done`;
  return `mkdir -p .claude && rm -rf ${hostTrees} .claude/${STAMP}* && ${move} && : >.claude/${quote(STAMP + s)}`;
}
