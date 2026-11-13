import { tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { z } from "zod";
import type { HostFiles } from "../host-fs";
import { abs, bins, err, head, ok, streamLines, type Workspace } from "./util";

const LIMIT = 100;
const SKIP = /(^|[\\/])(\.git|node_modules)[\\/]/;

/**
 * The pattern as a ripgrep glob, which follows .gitignore rules: one without a `/` would match a
 * name at any depth there, so it is anchored at the search root, as a glob is. Undefined for what
 * only Bun.Glob reads the same way: absolute patterns, or ones that leave the directory.
 */
function rgGlob(pattern: string): string | undefined {
  const p = pattern.replace(/^(\.\/)+/, "");
  if (!p || isAbsolute(p) || p.split(/[\\/]/).includes("..")) return undefined;
  return p.includes("/") ? p : `/${p}`;
}

/** Keeps the `limit` newest files of those it is given, without holding them all. */
function newest(limit: number) {
  let kept: (readonly [string, number])[] = [];
  let count = 0;
  const trim = () => { kept = kept.sort((a, b) => b[1] - a[1]).slice(0, limit); };
  return {
    add(file: string) {
      let mtime: number;
      try { mtime = statSync(file).mtimeMs; } catch { return; } // Gone since it was listed.
      count++;
      kept.push([file, mtime]);
      if (kept.length >= limit * 2) trim();
    },
    result() {
      trim();
      return { files: kept.map(([f]) => f), count };
    },
  };
}

/**
 * ripgrep's file list: ignore files apply, hidden files are listed, and .git and node_modules are
 * skipped unless the pattern names them, as in Grep. Errors only matter when nothing was found.
 */
async function rgFiles(glob: string, cwd: string, skip: boolean, add: (file: string) => void): Promise<string | undefined> {
  // ripgrep reads globs relative to its working directory, whatever path it searches.
  const proc = Bun.spawn([bins.rg!, "--files", "--hidden", "--glob", glob, ...(skip ? ["--glob", "!.git", "--glob", "!node_modules"] : []), "--", cwd], {
    cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const errors = head(proc.stderr);
  let found = false;
  for await (const line of streamLines(proc.stdout)) {
    if (line) { found = true; add(line); }
  }
  const code = await proc.exited;
  return code > 1 && !found ? ((await errors).trim() || `rg failed with exit code ${code}`) : undefined;
}

/** An absolute pattern as the folder its literal start names and the pattern below it; no folder for any other. */
function splitAbsolute(pattern: string): [string | undefined, string] {
  if (!pattern.startsWith("/")) return [undefined, pattern];
  const parts = pattern.split("/");
  const wild = parts.findIndex((p) => /[*?[{]/.test(p));
  if (wild < 1) return [undefined, pattern];
  return [parts.slice(0, wild).join("/") || "/", parts.slice(wild).join("/")];
}

/** A folder of the host claude's own, such as its memory: listed there, matched here, in name order. */
async function hostGlob(host: HostFiles, dir: string, pattern: string) {
  const listed = await host.list(dir).catch((e: Error) => e);
  if (listed instanceof Error) return err(listed.message);
  if (listed === "missing") return err(`Directory does not exist: ${dir}`);
  const matcher = new Bun.Glob(pattern);
  const files = listed.filter((f) => matcher.match(f)).map((f) => posix.join(dir, f));
  if (!files.length) return ok("No files found");
  const shown = files.slice(0, LIMIT).join("\n");
  return ok(files.length > LIMIT ? `${shown}\n(Results are truncated. Consider using a more specific path or pattern.)` : shown);
}

export const glob = (ws: Workspace) => tool(
  "Glob",
  `Fast file pattern matching on the user's local filesystem.

- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching absolute file paths, most recently modified first, at most ${LIMIT}
- Files that .gitignore and other ignore files exclude are left out when ripgrep is installed
- Skips .git and node_modules unless the pattern names them`,
  {
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
  },
  async ({ pattern, path }) => {
    if (ws.host) {
      // A host folder given as the path, or as the literal start of an absolute pattern.
      const [dir, rest] = path !== undefined ? [path, pattern] : splitAbsolute(pattern);
      const remote = dir === undefined ? undefined : ws.host.own(dir);
      if (remote) return hostGlob(ws.host, remote, rest);
    }
    const cwd = abs(ws, path ?? ".");
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return err(`Directory does not exist: ${cwd}`);
    const skip = !/\.git|node_modules/.test(pattern);
    const found = newest(LIMIT);
    const rg = bins.rg ? rgGlob(pattern) : undefined;
    if (rg) {
      const failed = await rgFiles(rg, cwd, skip, (f) => found.add(f));
      if (failed) return err(failed);
    } else {
      for await (const file of new Bun.Glob(pattern).scan({ cwd, dot: true, onlyFiles: true })) {
        if (!skip || !SKIP.test(file)) found.add(join(cwd, file));
      }
    }
    const { files, count } = found.result();
    if (!count) return ok("No files found");
    const shown = files.join("\n");
    return ok(count > LIMIT ? `${shown}\n(Results are truncated. Consider using a more specific path or pattern.)` : shown);
  },
  { annotations: { readOnlyHint: true } },
);
