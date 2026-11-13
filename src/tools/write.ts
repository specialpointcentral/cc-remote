import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, err, ok, type Workspace } from "./util";

const done = (path: string, existed: boolean) =>
  ok(existed ? `The file ${path} has been updated successfully.` : `File created successfully at: ${path}`);

export const write = (ws: Workspace) => tool(
  "Write",
  `Writes a file to the user's local filesystem, creating parent directories as needed.

- Overwrites the existing file if there is one at the provided path
- For an existing file, prefer Edit, which only sends the change
- Never create documentation files (*.md) or READMEs unless the user asks for them`,
  {
    file_path: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
    content: z.string().describe("The content to write to the file"),
  },
  async ({ file_path, content }) => {
    const remote = ws.host?.own(file_path);
    if (remote && ws.host) {
      // One of the host claude's own files, such as the plan file: it reads it there.
      const existed = await ws.host.write(remote, content).catch((e: Error) => e);
      return existed instanceof Error ? err(existed.message) : done(remote, existed);
    }
    const path = abs(ws, file_path);
    const existed = await Bun.file(path).exists();
    await Bun.write(path, content);
    return done(path, existed);
  },
);
