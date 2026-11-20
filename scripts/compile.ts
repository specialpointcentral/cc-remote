/**
 * `bun run compile`: runs the build:<os>-<arch> script for this machine, stamped with this checkout
 * and its source id (src/update/local.ts) so that `cc-remote update` can build it again once it
 * changes, then puts the binary at dist/cc-remote, where package.json's bin points, so `bun link`
 * installs it.
 */
import { copyFileSync, linkSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { WINDOWS } from "../src/platform";
import { sourceId } from "../src/update/local";

const os = WINDOWS ? "windows" : process.platform;
const target = `${os}-${process.arch}`;
const script = `build:${target}`;
if (!(script in pkg.scripts)) {
  const known = Object.keys(pkg.scripts).filter((s) => s.startsWith("build:")).map((s) => s.slice("build:".length));
  console.error(`compile: no build script for ${target}. Known targets: ${known.join(", ")}`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
// `--out <file>`: the binary goes there and dist/ is left as it is. `cc-remote update` builds this
// way, so that a cc-remote linked to dist/cc-remote keeps running its build until the update switches.
const outAt = process.argv.indexOf("--out");
const out = outAt >= 0 ? process.argv[outAt + 1] : undefined;
// Outside a git checkout there is no id to update by: the build is unstamped, as a release is.
const id = await sourceId(root);
const stamp = id ? ["--define", `CC_REMOTE_BUILD=${JSON.stringify(JSON.stringify({ id, source: root }))}`] : [];
// The script's own words (no shell), then the stamp.
const command = pkg.scripts[script as keyof typeof pkg.scripts].split(" ");
const outfile = command.indexOf("--outfile");
if (outfile < 0) {
  console.error(`compile: ${script} has no --outfile <file> to build to`);
  process.exit(1);
}
if (out) command[outfile + 1] = out;
// bun build --compile leaves its scratch copy of bun (.<hash>-00000000.bun-build, 88 MB) in the folder
// it runs in, which is this checkout: every `cc-remote update` would add one. The build's own go.
const scratch = () => readdirSync(root).filter((n) => n.endsWith(".bun-build"));
const before = new Set(scratch());
const build = Bun.spawnSync([...command, ...stamp], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
for (const name of scratch()) if (!before.has(name)) rmSync(join(root, name), { force: true });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

let made = out;
if (!made) {
  // Bun adds .exe to Windows builds. The bin keeps no extension so one package.json fits every
  // platform; the .exe copy is for running or copying by hand, and is a hard link rather than a
  // second copy of the binary.
  const exe = WINDOWS ? ".exe" : "";
  const dist = join(root, "dist");
  const built = join(dist, `cc-remote-${target}${exe}`);
  const bin = join(dist, "cc-remote");
  const linked = join(dist, `cc-remote${exe}`);
  copyFileSync(built, bin);
  if (exe) {
    rmSync(linked, { force: true });
    linkSync(bin, linked);
  }
  made = `${built} -> ${bin}${exe ? `, ${linked}` : ""}`;
}
console.log(`compile: ${made}${id ? ` (${id})` : ""}`);
