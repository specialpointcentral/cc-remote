import pkg from "../../../package.json";
import type { Ctx } from "../context";
import { type Marker, saveScript } from "../remote-probe";

/**
 * On the central server, only in cc-remote's own folder: `~/.cc-remote/ws` (where sessions get
 * their working folders) and this machine's marker, written only when there is none or it already
 * holds this machine's id. Nothing else there is ever changed.
 */
export type SaveResult = "created" | "updated" | "foreign" | "symlink" | "notdir" | "failed";

export async function saveRemote(ctx: Ctx, base: string[], host: string, machine: string, id: string, old?: Marker): Promise<SaveResult> {
  const now = new Date(ctx.now()).toISOString();
  const marker = JSON.stringify({ machineId: id, firstSeen: old?.machineId === id ? (old.firstSeen ?? now) : now, lastSeen: now, ccRemote: pkg.version });
  const r = await ctx.run([...base, host, "/bin/sh -s"], { input: saveScript(machine, id, marker), timeoutMs: 60_000 });
  const result = r.stdout.match(/^RESULT=(\w+)$/m)?.[1];
  return (["created", "updated", "foreign", "symlink", "notdir"].includes(result ?? "") ? result : "failed") as SaveResult;
}
