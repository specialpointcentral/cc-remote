import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsLocations } from "../src/rules";
import { resetSnapshots, snapshots } from "../src/tools/login";

const realBash = Bun.which("bash")!;

/**
 * A bash that reads no real startup file: `-lc` sources only $HOME/.bash_profile, `-c` nothing,
 * as with the snapshot's fast path. Each start appends its flag to $FIXTURE_SHELL_LOG.
 */
export function fixtureShell(dir: string, name = "bash"): string {
  const path = join(dir, "bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String.raw`#!/bin/sh
[ -z "$FIXTURE_SHELL_LOG" ] || printf '%s\n' "$1" >> "$FIXTURE_SHELL_LOG"
flag=$1 command=$2
shift 2
if [ "$flag" = -lc ]; then
  command='[ ! -f "$HOME/.bash_profile" ] || . "$HOME/.bash_profile"
'"$command"
fi
exec ${realBash} --noprofile --norc -c "$command" "$@"
`);
  chmodSync(path, 0o755);
  return path;
}

const ENV = ["HOME", "SHELL", "CLAUDE_CONFIG_DIR", "BASH_ENV", "ENV", "CC_REMOTE_SHELL_SNAPSHOT", "FIXTURE_SHELL_LOG", "FIXTURE_LOGIN_LOG", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"];

/**
 * Points everything the shell tool reads at a temporary home: the login shell, its profile, the
 * snapshot directories, Claude's user and managed settings, and git's global config, where a
 * persisted approval adds its excludes entry. Nothing real is read or written.
 */
export function isolate() {
  const env = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const saved = { ...snapshots };
  const managed = settingsLocations.managed;
  const home = mkdtempSync(join(tmpdir(), "cc-remote-home-"));
  const shell = fixtureShell(home);
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { HOME: home, SHELL: shell, CLAUDE_CONFIG_DIR: join(home, ".claude"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig") });
  settingsLocations.managed = join(home, "managed");
  Object.assign(snapshots, { dir: mkdtempSync(join(tmpdir(), "cc-remote-snap-")), cacheDir: join(home, ".cache", "cc-remote", "shell"), systemFiles: [], bash: shell, log: () => {} });
  resetSnapshots();
  return {
    home,
    shell,
    restore() {
      rmSync(snapshots.dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      for (const k of ENV) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      Object.assign(snapshots, saved);
      settingsLocations.managed = managed;
      resetSnapshots();
    },
  };
}

export type Result = { content: { type: string; text?: string }[]; isError?: boolean };

export const call = async (t: { handler: (a: any, e: any) => Promise<unknown> }, input: object, extra: object = {}) => {
  const r = (await t.handler(input, extra)) as Result;
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join(""), error: !!r.isError };
};
