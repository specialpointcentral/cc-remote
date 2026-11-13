import { tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { abs, bins, err, head, ok, streamLines, type Workspace } from "./util";

/** Claude Code's Grep shows this many results unless told otherwise. */
const HEAD_LIMIT = 250;
/** However many results are asked for, no more text than this is kept. */
const MAX_CHARS = 100_000;

type Input = {
  pattern: string; path?: string; glob?: string; type?: string; output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean; "-n"?: boolean; "-A"?: number; "-B"?: number; "-C"?: number; multiline?: boolean; head_limit?: number; offset?: number;
};

/** ripgrep when it's installed, plain grep otherwise (no --type or multiline there). */
function command(i: Input, mode: string, path: string): string[] {
  const context = (["-A", "-B", "-C"] as const).flatMap((f) => (i[f] !== undefined && mode === "content" ? [f, String(i[f])] : []));
  const flags = [
    ...(i["-i"] ? ["-i"] : []),
    ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c"] : i["-n"] === false ? [] : ["-n"]),
    ...context,
  ];
  if (bins.rg) {
    return [bins.rg, "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-columns", "500", ...flags,
      ...(i.multiline ? ["-U", "--multiline-dotall"] : []),
      ...(i.glob ? ["--glob", i.glob] : []),
      ...(i.type ? ["--type", i.type] : []),
      "-e", i.pattern, "--", path];
  }
  return [bins.grep!, "-r", "-E", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules", ...flags,
    ...(i.glob ? [`--include=${i.glob}`] : []),
    "-e", i.pattern, "--", path];
}

export const grep = (ws: Workspace) => tool(
  "Grep",
  `Searches file contents on the user's local filesystem with ripgrep (or grep when ripgrep is not installed).

- Supports full regex syntax, e.g. "log.*Error" or "function\\s+\\w+"
- Filter files with glob (e.g. "*.js", "**/*.tsx") or type (e.g. "js", "py")
- output_mode: "files_with_matches" (default) lists files, "content" shows matching lines, "count" shows counts per file
- Use multiline for patterns that span lines
- Shows the first ${HEAD_LIMIT} results unless head_limit says otherwise; offset pages through the rest
- Prefer this over running grep or rg through Bash`,
  {
    pattern: z.string().describe("The regular expression pattern to search for in file contents"),
    path: z.string().optional().describe("File or directory to search in. Defaults to the current working directory."),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
    type: z.string().optional().describe("File type to search (rg --type), e.g. js, py, rust, go"),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe('Output mode. Defaults to "files_with_matches".'),
    "-i": z.boolean().optional().describe("Case insensitive search"),
    "-n": z.boolean().optional().describe('Show line numbers in output. Requires output_mode: "content". Defaults to true.'),
    "-A": z.number().optional().describe('Number of lines to show after each match. Requires output_mode: "content".'),
    "-B": z.number().optional().describe('Number of lines to show before each match. Requires output_mode: "content".'),
    "-C": z.number().optional().describe('Number of lines to show before and after each match. Requires output_mode: "content".'),
    multiline: z.boolean().optional().describe("Enable multiline mode where . matches newlines and patterns can span lines. Default: false."),
    head_limit: z.number().optional().describe(`Limit output to the first N lines/entries, like "| head -N". Defaults to ${HEAD_LIMIT}; 0 for no limit (use sparingly).`),
    offset: z.number().optional().describe('Skip the first N lines/entries before applying head_limit, like "| tail -n +N | head -N". Defaults to 0.'),
  },
  async (input) => {
    if (!bins.rg && !bins.grep) return err("Grep needs ripgrep (rg) or grep on PATH, and this machine has neither. Ask the user to install ripgrep.");
    const mode = input.output_mode ?? "files_with_matches";
    const limit = input.head_limit === 0 ? Infinity : Math.max(1, input.head_limit ?? HEAD_LIMIT);
    const skip = Math.max(0, input.offset ?? 0);
    const path = abs(ws, input.path ?? ".");
    // ripgrep reads a glob relative to its working directory: the directory searched, or the file's.
    let cwd = path;
    try { if (!statSync(path).isDirectory()) cwd = dirname(path); } catch { cwd = ws.root; }
    const proc = Bun.spawn(command(input, mode, path), { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // Errors are kept short, and the search stops once it has found what will be shown.
    const errors = head(proc.stderr);
    const lines: string[] = [];
    let seen = 0, chars = 0, more = false;
    for await (const line of streamLines(proc.stdout, MAX_CHARS)) {
      if (!line || (mode === "count" && line.endsWith(":0"))) continue;
      if (++seen <= skip) continue;
      if (lines.length >= limit || chars + line.length > MAX_CHARS) { more = true; break; }
      lines.push(line);
      chars += line.length + 1;
    }
    if (more) proc.kill();
    const code = await proc.exited;
    const error = await errors;
    if (!more && code > 1 && !lines.length) return err(error || `search failed with exit code ${code}`);
    if (!lines.length) return ok(mode === "files_with_matches" ? "No files found" : "No matches found");
    const shown = mode === "files_with_matches" ? `Found ${lines.length} file${lines.length === 1 ? "" : "s"}\n${lines.join("\n")}` : lines.join("\n");
    return ok(more ? `${shown}\n\n(More results not shown. Pass offset: ${skip + lines.length} for the next ones, or narrow the search.)` : shown);
  },
  { annotations: { readOnlyHint: true } },
);
