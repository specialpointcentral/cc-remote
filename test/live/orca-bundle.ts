/**
 * Builds an isolated `orca` CLI for the live checks from an orcad bundle that the Orca desktop app
 * pushed to this machine (such as ~/.orca-remote/orcad-0.1.0+<build>), as remote-harness's
 * tests/fixtures/orca_bundle.py does.
 *
 *   bun test/live/orca-bundle.ts <bundle-dir> <work-dir>     prints the CLI's path
 *
 * The bundle is copied into <work-dir>/bundles first, so a test server never writes its pid,
 * readiness or log files into a bundle that a live Orca Server is running from; its pinned Node
 * runtime is linked beside the copy, where orcad looks for it. The CLI supports only `--version`
 * and `serve --no-pairing --port N`. It serves only a throwaway profile: HOME must not be this
 * user's real home and ORCA_USER_DATA_PATH must be under HOME, so it can't start a server on a real
 * profile. The server binds 127.0.0.1, runs under `nice -n 10`, and its V8 heap is capped
 * (`--max-old-space-size=384`) so it can't crowd out what else runs on a small machine.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type OrcaCli = { cli: string; version: string; build: string };

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function buildOrcaCli(bundleDir: string, workDir: string): OrcaCli {
  const bundle = realpathSync(resolve(bundleDir.replace(/^~(?=\/|$)/, userInfo().homedir)));
  const work = resolve(workDir);
  const runtimeId = readFileSync(join(bundle, ".runtime-node"), "utf8").trim();
  const runtime = join(dirname(bundle), "runtimes", `node-${runtimeId}`);
  const node = join(runtime, "bin", "node");
  for (const required of [join(bundle, "orcad.js"), join(bundle, "out", "cli", "index.js"), node]) {
    if (!existsSync(required)) throw new Error(`orca-bundle: ${required} is missing; pass an orcad bundle directory`);
  }
  const copy = join(work, "bundles", basename(bundle));
  if (!existsSync(copy)) {
    mkdirSync(dirname(copy), { recursive: true });
    // As shutil.ignore_patterns(".orcad-*", "*.log"): the live server's own files, at any depth.
    cpSync(bundle, copy, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => src === bundle || !(basename(src).startsWith(".orcad-") || basename(src).endsWith(".log")),
    });
  }
  // orcad finds its pinned Node runtime beside the bundle and refuses to start without it.
  const link = join(work, "bundles", "runtimes", basename(runtime));
  mkdirSync(dirname(link), { recursive: true });
  try {
    lstatSync(link);
  } catch {
    symlinkSync(runtime, link, "dir");
  }
  const probe = Bun.spawnSync([node, join(copy, "out", "cli", "index.js"), "--version"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work },
    timeout: 30_000,
  });
  const version = probe.stdout.toString().trim();
  if (probe.exitCode !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`orca-bundle: ${bundle} reports version "${version}" ${probe.stderr.toString().trim()}`);
  }
  const build = basename(bundle).replace(/^orcad-/, "");
  const cli = join(work, `orca-${version}`);
  writeFileSync(cli, `#!/bin/sh
# Test stand-in for \`orca\`, built by test/live/orca-bundle.ts from ${bundle}.
unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE ELECTRON_RUN_AS_NODE ORCA_ORCAD_MANAGED_ACTIVATION_ROOT
node=${sq(node)}
bundle=${sq(copy)}
case "\${1:-}" in
  --version) exec "$node" "$bundle/out/cli/index.js" --version ;;
  serve)
    [ "$#" -eq 4 ] && [ "$2" = --no-pairing ] && [ "$3" = --port ] || { echo "unsupported: $*" >&2; exit 2; }
    # The account's home from the user database (getent where there is one, as on Linux; ~user
    # otherwise, as on macOS); with neither, nothing is served.
    real=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
    [ -n "$real" ] || real=$(eval "printf '%s' ~$(id -un)")
    case "$real" in /?*) ;; *) echo "can't tell this account's home directory" >&2; exit 2 ;; esac
    case "\${HOME:-}" in
      ""|/|"$real"|"$real"/) echo "HOME must be a throwaway test home, not $real" >&2; exit 2 ;;
    esac
    case "\${ORCA_USER_DATA_PATH:-}" in
      "$HOME"/?*) ;;
      *) echo "ORCA_USER_DATA_PATH must be a test profile under HOME" >&2; exit 2 ;;
    esac
    export ORCA_USER_DATA="$ORCA_USER_DATA_PATH" ORCA_VERSION=${sq(build)}
    exec nice -n 10 "$node" --disable-wasm-trap-handler --wasm-max-mem-pages=1024 --max-semi-space-size=8 \\
      --max-old-space-size=384 "$bundle/orcad.js" --json --bind 127.0.0.1 --port "$4" ;;
  *) echo "unsupported: $*" >&2; exit 2 ;;
esac
`, { mode: 0o700 });
  return { cli, version, build };
}

if (import.meta.main) {
  const [bundle, work] = process.argv.slice(2);
  if (!bundle || !work) {
    console.error("usage: bun test/live/orca-bundle.ts <bundle-dir> <work-dir>");
    process.exit(2);
  }
  try {
    console.log(buildOrcaCli(bundle, work).cli);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
