import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../context";
import { writePrivate } from "../files";

/**
 * Local ssh changes setup may make, each with consent: a passphrase-less key for cc-remote
 * (Orca Server is a daemon without ssh-agent), copying it to the central server with ssh-copy-id
 * (the password goes to ssh, never to cc-remote), and naming it in a managed block of
 * ~/.ssh/config, backed up first.
 */
export const BEGIN = "# >>> cc-remote setup >>>";
export const END = "# <<< cc-remote setup <<<";

/** The host part of a destination: `me@h`, `ssh://me@h:2222` and `h` all give `h`. */
export function hostPart(dest: string): string {
  return dest.replace(/^ssh:\/\//, "").replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
}

/** A word that can go into ssh_config unquoted. */
const SAFE = /^[A-Za-z0-9._@%+:~/[\]-]+$/;

export type HostEntry = { pattern: string; hostName?: string; user?: string; port?: string; identity?: string; jump?: string };

function entryText(e: HostEntry): string {
  for (const v of [e.pattern, e.hostName, e.user, e.port, e.identity, e.jump]) {
    if (v !== undefined && !SAFE.test(v)) throw new Error(`unsafe value for ~/.ssh/config: ${JSON.stringify(v)}`);
  }
  return [
    `Host ${e.pattern}`,
    e.hostName && `    HostName ${e.hostName}`,
    e.user && `    User ${e.user}`,
    e.port && e.port !== "22" && `    Port ${e.port}`,
    e.jump && `    ProxyJump ${e.jump}`,
    e.identity && `    IdentityFile ${e.identity}`,
    e.identity && "    IdentitiesOnly yes",
  ].filter(Boolean).join("\n");
}

/**
 * The config text with the managed block holding this entry: other hosts' entries in the block
 * are kept, an entry for the same Host is replaced, and a config without the block gets it at the
 * end (where IdentityFile still adds to any other block for the host, since ssh tries them all).
 */
export function withEntry(config: string, entry: HostEntry): string {
  const start = config.indexOf(BEGIN);
  const stop = start >= 0 ? config.indexOf(END, start) : -1;
  const inside = start >= 0 && stop > start ? config.slice(start + BEGIN.length, stop) : "";
  const entries = inside.split(/\n(?=Host\s)/).map((s) => s.trim()).filter((s) => s.startsWith("Host "));
  const kept = entries.filter((s) => s.split("\n")[0]!.trim() !== `Host ${entry.pattern}`);
  const block = [BEGIN, ...kept, entryText(entry), END].join("\n");
  if (start >= 0 && stop > start) return config.slice(0, start) + block + config.slice(stop + END.length);
  return `${config}${config && !config.endsWith("\n") ? "\n" : ""}${config ? "\n" : ""}${block}\n`;
}

/**
 * Writes the entry into ~/.ssh/config: the old file is copied to config.cc-remote-<ts>.bak (0600)
 * first, the new one keeps the old one's mode, or is 0600 when new. Returns the backup's path.
 */
export function writeEntry(ctx: Ctx, entry: HostEntry): string | undefined {
  const dir = join(ctx.home, ".ssh");
  const file = join(dir, "config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("~/.ssh/config is a symbolic link; edit it yourself");
  const old = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const next = withEntry(old ?? "", entry);
  if (old === next) return undefined;
  let backup: string | undefined;
  const mode = old !== undefined ? statSync(file).mode & 0o777 : 0o600;
  if (old !== undefined) {
    backup = join(dir, `config.cc-remote-${new Date(ctx.now()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}.bak`);
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  }
  writePrivate(file, next);
  chmodSync(file, mode);
  return backup;
}

/**
 * The key to use: an earlier cc-remote key, else ~/.ssh/id_ed25519 when the user has no key at all
 * (ssh tries it without any config), else a new ~/.ssh/cc-remote_ed25519.
 */
export function chooseKey(home: string): { path: string; exists: boolean; standard: boolean } {
  const dir = join(home, ".ssh");
  const ours = join(dir, "cc-remote_ed25519");
  if (existsSync(ours)) return { path: ours, exists: true, standard: false };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const any = names.some((n) => /^id_(rsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk|dsa)$/.test(n));
  return any ? { path: ours, exists: false, standard: false } : { path: join(dir, "id_ed25519"), exists: false, standard: true };
}

/** Makes a passphrase-less ed25519 key. */
export async function keygen(ctx: Ctx, path: string): Promise<boolean> {
  mkdirSync(join(ctx.home, ".ssh"), { recursive: true, mode: 0o700 });
  const r = await ctx.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `cc-remote@${hostname()}`, "-f", path], { timeoutMs: 30_000 });
  if (r.code !== 0) ctx.term.line(`    ${r.stderr.trim()}`);
  return r.code === 0 && existsSync(path);
}

/** Copies a public key to the server with ssh-copy-id, on the terminal: it may ask for a password. */
export async function copyId(ctx: Ctx, publicKey: string, dest: string): Promise<boolean> {
  return (await ctx.interactive(["ssh-copy-id", "-i", publicKey, dest])) === 0;
}
