import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, err, ok, type Workspace } from "./util";

/** An edit of a file's text, `undefined` for a file that isn't there: the new text, or why there is none. */
export function applyEdit(text: string | undefined, path: string, old_string: string, new_string: string, replace_all?: boolean): { text: string } | { error: string } {
  if (old_string === new_string) return { error: "No changes to make: old_string and new_string are exactly the same." };
  if (text === undefined) return old_string === "" ? { text: new_string } : { error: `File does not exist: ${path}` };
  if (old_string === "") return { error: "Cannot create new file - file already exists." };
  const parts = text.split(old_string);
  const matches = parts.length - 1;
  if (matches === 0) return { error: `String to replace not found in file.\nString: ${old_string}` };
  if (matches > 1 && !replace_all) {
    return {
      error: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
    };
  }
  // split/join instead of String.replace: replacement strings must not interpret `$&` and friends.
  return { text: replace_all ? parts.join(new_string) : parts[0] + new_string + parts.slice(1).join(old_string) };
}

const done = (path: string, created: boolean) =>
  ok(created ? `File created successfully at: ${path}` : `The file ${path} has been updated successfully.`);

export const edit = (ws: Workspace) => tool(
  "Edit",
  `Performs exact string replacements in a file on the user's local filesystem.

- Read the file first so old_string matches it exactly, including indentation. Do not include the line-number prefix from Read output
- The edit fails if old_string is not found, or matches more than once while replace_all is false. Add surrounding context to make it unique, or set replace_all
- Use replace_all to rename a variable or replace every occurrence
- An empty old_string creates a new file with new_string as its content`,
  {
    file_path: z.string().describe("The absolute path to the file to modify"),
    old_string: z.string().describe("The text to replace"),
    new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
    replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    const remote = ws.host?.own(file_path);
    if (remote && ws.host) {
      // One of the host claude's own files, such as the plan file: read there, changed here, written back.
      const host = ws.host;
      try {
        const got = await host.read(remote);
        if (got === "directory") return err(`EISDIR: illegal operation on a directory, read '${remote}'`);
        const before = got === "missing" ? undefined : new TextDecoder().decode(got);
        const r = applyEdit(before, remote, old_string, new_string, replace_all);
        if ("error" in r) return err(r.error);
        await host.write(remote, r.text);
        return done(remote, before === undefined);
      } catch (e) {
        return err((e as Error).message);
      }
    }
    const path = abs(ws, file_path);
    const file = Bun.file(path);
    const before = (await file.exists()) ? await file.text() : undefined;
    const r = applyEdit(before, path, old_string, new_string, replace_all);
    if ("error" in r) return err(r.error);
    await Bun.write(path, r.text);
    return done(path, before === undefined);
  },
);
