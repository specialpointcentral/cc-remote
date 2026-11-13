import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renderNotebook } from "./notebook";
import { abs, err, ok, streamLines, type Workspace } from "./util";

/** Longer lines are cut, as Claude Code's Read cuts them. */
const MAX_LINE = 2000;

const IMAGES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

export const read = (ws: Workspace) => tool(
  "Read",
  `Reads a file from the user's local filesystem.

- file_path should be an absolute path; relative paths resolve against the working directory
- By default reads up to 2000 lines from the start of the file; use offset and limit for long files
- Lines longer than 2000 characters are truncated
- Output uses cat -n format: line numbers starting at 1, then a tab, then the line
- Reads images (PNG, JPG, GIF, WEBP) and returns them visually
- Reads Jupyter notebooks (.ipynb) as cells with their ids and outputs
- Can only read files, not directories; use Bash with ls for directories
- Batch several reads in one response when you need several files`,
  {
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().int().optional().describe("The line number to start reading from. Only provide if the file is too large to read at once"),
    limit: z.number().int().optional().describe("The number of lines to read. Only provide if the file is too large to read at once."),
  },
  async ({ file_path, offset, limit }) => {
    const remote = ws.host?.own(file_path);
    let path: string;
    let file: Blob;
    if (remote && ws.host) {
      // One of the host claude's own files, such as a tool result it saved there.
      const got = await ws.host.read(remote).catch((e: Error) => e);
      if (got instanceof Error) return err(got.message);
      if (got === "missing") return err(`File does not exist: ${remote}`);
      if (got === "directory") return err(`EISDIR: illegal operation on a directory, read '${remote}'`);
      path = remote;
      file = new Blob([got]);
    } else {
      path = abs(ws, file_path);
      const local = Bun.file(path);
      const info = await local.stat().catch(() => null);
      if (!info) return err(`File does not exist: ${path}`);
      if (info.isDirectory()) return err(`EISDIR: illegal operation on a directory, read '${path}'`);
      file = local;
    }

    const ext = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "";
    if (IMAGES[ext]) {
      return { content: [{ type: "image" as const, data: Buffer.from(await file.arrayBuffer()).toString("base64"), mimeType: IMAGES[ext] }] };
    }
    if (ext === "ipynb") {
      try {
        return { content: renderNotebook(await file.text()) };
      } catch {
        // Not valid notebook JSON; show it as text below.
      }
    }

    // Only as far as the range needs: a line range of a large file doesn't load the whole file.
    // The file is read to its end only to say how short it is, without keeping its lines.
    const start = Math.max(1, offset ?? 1);
    const end = start - 1 + (limit ?? 2000);
    const shown: string[] = [];
    let lines = 0;
    for await (const line of streamLines(file.stream(), MAX_LINE + 1)) {
      lines++;
      if (lines >= start && lines <= end) shown.push(`${String(lines).padStart(6)}\t${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line}`);
      if (lines >= Math.max(start, end)) break;
    }
    if (lines === 0) return ok("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>");
    if (start > lines) {
      return ok(`<system-reminder>Warning: the file exists but is shorter than the provided offset (${start}). The file has ${lines} lines.</system-reminder>`);
    }
    const body = shown.join("\n");
    return ok(body);
  },
  { annotations: { readOnlyHint: true } },
);
