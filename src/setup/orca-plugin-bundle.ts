import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import manifest from "../../orca-usage-plugin/orca-plugin.json";
import worker from "../../orca-usage-plugin/src/worker.mjs" with { type: "text" };
import popover from "../../orca-usage-plugin/src/popover.mjs" with { type: "text" };
import swift from "../../orca-usage-plugin/src/usage-popover.swift" with { type: "text" };
import readme from "../../orca-usage-plugin/README.md" with { type: "text" };
import { readPrivate } from "./files";

/** These imports are embedded in a compiled cc-remote, including local builds without a release. */
export const bundledPluginFiles: Record<string, string> = {
  "orca-plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
  "src/worker.mjs": worker,
  "src/popover.mjs": popover,
  "src/usage-popover.swift": swift,
  "README.md": readme,
};
export const bundledPluginVersion = manifest.version;
export const bundledPluginKey = `local.${manifest.id}`;
/** The oldest Orca the plugin runs on, from the manifest's `>=x.y.z`. */
export const pluginMinOrca = manifest.engines.orca.replace(/^>=/, "");

/** A folder of this user's that others can't write to (`privateOnly`: nor read). lstat: a link isn't a directory. */
function safeDirectory(path: string, privateOnly: boolean) {
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & (privateOnly ? 0o077 : 0o022))) {
    throw new Error(`unsafe plugin directory: ${path}`);
  }
}

function verifyBundle(path: string) {
  safeDirectory(path, true);
  safeDirectory(join(path, "src"), true);
  for (const [relative, contents] of Object.entries(bundledPluginFiles)) {
    const file = join(path, relative);
    if (readPrivate(file) !== contents) throw new Error(`unsafe or changed bundled plugin file: ${file}`);
  }
}

/** Writes only new content-addressed files; never replaces a changed or linked bundle. */
export function materializePlugin(home: string): string {
  const local = join(home, ".local");
  const share = join(local, "share");
  const root = join(share, "cc-remote");
  const bundles = join(root, "orca-plugin");
  // One level at a time, so a linked ancestor is refused before anything is made through it.
  for (const path of [local, share, root, bundles]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    safeDirectory(path, path === bundles);
  }
  const digest = createHash("sha256").update(JSON.stringify(bundledPluginFiles)).digest("hex");
  const target = join(bundles, digest);
  if (lstatSync(target, { throwIfNoEntry: false })) { verifyBundle(target); return target; }
  const temporary = join(bundles, `.${digest}.${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const [relative, contents] of Object.entries(bundledPluginFiles)) {
      const path = join(temporary, relative);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
    }
    try { renameSync(temporary, target); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && (e as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw e;
    }
    verifyBundle(target);
    return target;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
