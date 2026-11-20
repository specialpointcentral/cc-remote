import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installed, layout } from "../src/install/layout";
import { updateArgs } from "../src/setup/index";
import { main } from "../src/update/index";
import { sourceId, VERSION_ID } from "../src/update/local";
import { refreshUpdateStatus, updateNotice, updateStatus } from "../src/update/notice";
import { versionCache } from "../src/version";

/**
 * `cc-remote update` building from a source checkout. The builds are shell scripts that print their
 * id and play doctor and setup; the checkout's id comes from a real git repository.
 */
const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const savedCache = versionCache.dir;
afterEach(() => {
  versionCache.dir = savedCache;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A cc-remote binary that says it is `id`, passes doctor (or finds the server's claude too old), and updates the plugin (or can't). */
const script = (id: string, plugin = "0.4.0", doctor: "ok" | "old" = "ok", pluginUpdate: "ok" | "fails" = "ok") =>
  `#!/bin/sh\ncase "$1" in\n  --version) echo "${id} (cc-remote, claude-agent-acp 0.99.1, usage plugin ${plugin})";;\n  doctor) echo "remote claude: 2.1.400 (Claude Code)"; ${doctor === "ok" ? "echo ok" : "exit 1"};;\n  update) ${pluginUpdate === "ok" ? `echo "usage plugin: updated 0.4.0 → ${plugin}"` : `echo "usage plugin: Orca refused"; exit 1`};;\nesac\n`;

/** A home whose stable path is a managed `current`, a copied binary, or nothing. */
function home(stable: { managed?: string; copied?: string } = {}) {
  const dir = temp("ccr-local-");
  versionCache.dir = join(dir, "cache");
  const env: Record<string, string> = { HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" };
  const l = layout(env, "linux");
  mkdirSync(join(dir, ".local", "bin"), { recursive: true });
  if (stable.managed) {
    mkdirSync(join(l.versions, stable.managed), { recursive: true, mode: 0o700 });
    writeFileSync(join(l.versions, stable.managed, "cc-remote"), script(stable.managed), { mode: 0o755 });
    symlinkSync(join(l.versions, stable.managed, "cc-remote"), l.stable);
    writeFileSync(l.installJson, JSON.stringify({ current: stable.managed }), { mode: 0o600 });
  }
  if (stable.copied) writeFileSync(l.stable, script(stable.copied), { mode: 0o755 });
  const source = temp("ccr-source-");
  mkdirSync(join(source, "dist"));
  return { dir, env, l, source };
}

/** A builder that makes `id` where it is told, or fails; `outs` collects where that was. */
const outs: string[] = [];
const builder = (id: string | Error, plugin?: string, doctor?: "ok" | "old", pluginUpdate?: "ok" | "fails") => async (_source: string, _env: unknown, _say: unknown, out: string) => {
  if (id instanceof Error) throw id;
  outs.push(out);
  writeFileSync(out, script(id, plugin, doctor, pluginUpdate), { mode: 0o755 });
  return out;
};

async function update(h: ReturnType<typeof home>, argv: string[], build: ReturnType<typeof builder> = builder("0.2.0-bbbbbbb"), platform: NodeJS.Platform = "linux") {
  let out = "";
  const code = await main(argv, { env: h.env, out: { write: (s: string) => (out += s) }, platform, build });
  return { code, out };
}

const current = (h: ReturnType<typeof home>) => {
  const s = installed(h.l);
  return s.kind === "managed" ? s.version : s.kind;
};

/** A git checkout with a package.json, a source file and docs, committed. */
function checkout() {
  const root = temp("ccr-git-");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cc-remote", version: "0.2.0" }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "docs\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  return { root, git, head: git("rev-parse", "--short=7", "HEAD").stdout.toString().trim() };
}

describe("the source id", () => {
  test("is the version and commit, then a hash of uncommitted build inputs; docs don't count; the checkout is untouched", async () => {
    const c = checkout();
    expect(await sourceId(c.root)).toBe(`0.2.0-${c.head}`);
    writeFileSync(join(c.root, "README.md"), "more docs\n");
    expect(await sourceId(c.root)).toBe(`0.2.0-${c.head}`);
    writeFileSync(join(c.root, "src", "a.ts"), "export const a = 2;\n");
    const changed = await sourceId(c.root);
    expect(changed).toMatch(new RegExp(`^0\\.2\\.0-${c.head}\\.[0-9a-f]{8}$`));
    writeFileSync(join(c.root, "src", "b.ts"), "export const b = 1;\n");
    const untracked = await sourceId(c.root);
    expect(untracked).not.toBe(changed);
    // Nothing was staged: the real index still has only the commit.
    expect(c.git("diff", "--cached", "--quiet").exitCode).toBe(0);
    expect(c.git("status", "--porcelain").stdout.toString()).toContain("?? src/b.ts");
  });

  test("writes nothing into the repository, and counts a deleted folder", async () => {
    const c = checkout();
    writeFileSync(join(c.root, "src", "a.ts"), "export const a = 5;\n");
    const objects = () => c.git("count-objects", "-v").stdout.toString();
    const before = objects();
    expect(await sourceId(c.root)).toMatch(/\.[0-9a-f]{8}$/);
    expect(objects()).toBe(before);
    c.git("checkout", "--", "src");
    rmSync(join(c.root, "src"), { recursive: true });
    expect(await sourceId(c.root)).toMatch(new RegExp(`^0\\.2\\.0-${c.head}\\.[0-9a-f]{8}$`));
  });

  test("is undefined outside a checkout", async () => {
    expect(await sourceId(temp("ccr-plain-"))).toBeUndefined();
  });
});

describe("cc-remote update from source", () => {
  test("builds the checkout, installs the build as a version and switches to it", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const r = await update(h, ["--source", h.source]);
    expect(r.code).toBe(0);
    expect(current(h)).toBe("0.2.0-bbbbbbb");
    expect(JSON.parse(readFileSync(h.l.installJson, "utf8"))).toMatchObject({ current: "0.2.0-bbbbbbb", previous: "0.1.0-aaaaaaa", source: `local:${h.source}` });
    expect(updateStatus()).toMatchObject({ current: "0.2.0-bbbbbbb", latest: "0.2.0-bbbbbbb", source: h.source });
    expect(r.out).toContain("Updated 0.1.0-aaaaaaa → 0.2.0-bbbbbbb");
  });

  test("an unchanged checkout changes nothing", async () => {
    const h = home({ managed: "0.2.0-bbbbbbb" });
    const r = await update(h, ["--source", h.source]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed and current");
    expect(JSON.parse(readFileSync(h.l.installJson, "utf8")).previous).toBeUndefined();
  });

  test("a copied binary at the stable path is kept as the previous version, and --rollback goes back to it", async () => {
    const h = home({ copied: "0.1.0" });
    const r = await update(h, ["--source", h.source]);
    expect(r.code).toBe(0);
    expect(lstatSync(h.l.stable).isSymbolicLink()).toBe(true);
    expect(current(h)).toBe("0.2.0-bbbbbbb");
    expect(readFileSync(join(h.l.versions, "0.1.0", "cc-remote"), "utf8")).toBe(script("0.1.0"));
    expect(r.out).toContain("as 0.1.0");
    expect((await update(h, ["--rollback"])).code).toBe(0);
    expect(current(h)).toBe("0.1.0");
  });

  test("a cc-remote linked to the checkout's dist/ keeps its build until the switch, and that build is kept", async () => {
    const h = home();
    const dist = join(h.source, "dist", "cc-remote");
    writeFileSync(dist, script("0.1.0-aaaaaaa"), { mode: 0o755 });
    symlinkSync(dist, h.l.stable);
    mkdirSync(join(h.dir, ".config", "cc-remote"), { recursive: true });
    writeFileSync(join(h.dir, ".config", "cc-remote", "host"), "central\n");
    // The server's claude is too old for the new build: nothing switches, and nothing ran it.
    expect((await update(h, ["--source", h.source], builder("0.2.0-bbbbbbb", undefined, "old"))).code).toBe(1);
    expect(outs.at(-1)!.startsWith(join(h.source, "dist"))).toBe(false);
    expect(readFileSync(realpathSync(h.l.stable), "utf8")).toBe(script("0.1.0-aaaaaaa"));
    // Fine now: the switch keeps the build the link ran, not the new one.
    expect((await update(h, ["--source", h.source])).code).toBe(0);
    expect(current(h)).toBe("0.2.0-bbbbbbb");
    expect(readFileSync(join(h.l.versions, "0.1.0-aaaaaaa", "cc-remote"), "utf8")).toBe(script("0.1.0-aaaaaaa"));
    expect(readFileSync(dist, "utf8")).toBe(script("0.1.0-aaaaaaa"));
  });

  test("a checkout whose compile ignores --out (one from before) fails the update, and what runs stays", async () => {
    const h = home();
    const dist = join(h.source, "dist", "cc-remote");
    writeFileSync(dist, script("0.1.0-aaaaaaa"), { mode: 0o755 });
    symlinkSync(dist, h.l.stable);
    // As an older compile.ts does: dist/cc-remote rewritten, nothing at --out.
    const old = async (_source: string, _env: unknown, _say: unknown, out: string) => {
      writeFileSync(dist, script("0.2.0-bbbbbbb"), { mode: 0o755 });
      return out;
    };
    const r = await update(h, ["--source", h.source], old);
    expect(r.code).toBe(1);
    expect(r.out).toContain("predates");
    expect(readFileSync(realpathSync(h.l.stable), "utf8")).toBe(script("0.1.0-aaaaaaa"));
    expect(current(h)).toBe("0.1.0-aaaaaaa");
  });

  test("a build that fails --version doesn't pass for current, whatever it prints first", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const broken = async (_source: string, _env: unknown, _say: unknown, out: string) => {
      writeFileSync(out, '#!/bin/sh\necho "0.1.0-aaaaaaa broken candidate"; exit 1\n', { mode: 0o755 });
      return out;
    };
    const r = await update(h, ["--source", h.source], broken);
    expect(r.code).toBe(1);
    expect(r.out).toContain("didn't run as cc-remote");
    expect(r.out).not.toContain("installed and current");
  });

  test("the Orca setup went by is the one the plugin update goes to", async () => {
    // setup names it to the update with --orca-profile, as it is named to setup...
    expect(updateArgs({ orca: "auto", orcaPlugin: "auto" }, "en", "/profile/a")).toEqual(["--lang", "en", "--orca-profile", "/profile/a"]);
    // ...and the update hands it to the plugin step as it is.
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const echo = async (_source: string, _env: unknown, _say: unknown, out: string) => {
      writeFileSync(out, `#!/bin/sh\ncase "$1" in\n  --version) echo "0.2.0-bbbbbbb (cc-remote, claude-agent-acp 0.99.1, usage plugin 0.4.0)";;\n  doctor) echo ok;;\n  update) echo "plugin step: $*";;\nesac\n`, { mode: 0o755 });
      return out;
    };
    const r = await update(h, ["--source", h.source, "--orca-profile", "/profile/a"], echo, "darwin");
    expect(r.code).toBe(0);
    expect(r.out).toContain("plugin step: update --orca-plugin only --orca-profile /profile/a");
  });

  test("setup told to skip the plugin or Orca has the update leave the plugin, and cc-remote still updates", async () => {
    expect(updateArgs({ orca: "auto", orcaPlugin: "skip" }, "zh", undefined)).toEqual(["--lang", "zh", "--orca-plugin", "skip"]);
    expect(updateArgs({ orca: "skip", orcaPlugin: "auto" }, "en", undefined)).toEqual(["--lang", "en", "--orca-plugin", "skip"]);
    expect(updateArgs({ orca: "auto", orcaPlugin: "auto" }, "en", undefined)).toEqual(["--lang", "en"]);
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const r = await update(h, ["--source", h.source, "--orca-plugin", "skip"], builder("0.2.0-bbbbbbb", "9.9.9"), "darwin");
    expect(r.code).toBe(0);
    expect(current(h)).toBe("0.2.0-bbbbbbb");
    expect(r.out).toContain("left as it is (--orca-plugin skip)");
    expect(r.out).not.toContain("usage plugin: updated");
    expect((await update(h, ["--orca-plugin", "bogus"])).code).toBe(2);
  });

  test("an unchanged checkout isn't built at all", async () => {
    const c = checkout();
    const h = home({ managed: `0.2.0-${c.head}` });
    const r = await update(h, ["--source", c.root], builder(new Error("built")));
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed and current");
    expect(r.out).not.toContain("Building");
  });

  test("a copied binary kept under a taken name can still be rolled back to", async () => {
    const h = home({ copied: "0.1.0" });
    mkdirSync(join(h.l.versions, "0.1.0"), { recursive: true, mode: 0o700 });
    writeFileSync(join(h.l.versions, "0.1.0", "cc-remote"), script("0.1.0", "0.3.0"), { mode: 0o755 });
    expect((await update(h, ["--source", h.source])).code).toBe(0);
    const kept = JSON.parse(readFileSync(h.l.installJson, "utf8")).previous;
    expect(kept).toMatch(/^0\.1\.0-kept\.\d+$/);
    const back = await update(h, ["--rollback"]);
    expect(back.out).toContain("Rolled back");
    expect(current(h)).toBe(kept);
  });

  test("--orca-plugin only updates just the plugin, before any lock, and says so where there is none", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const linux = await update(h, ["--orca-plugin", "only"]);
    expect(linux).toMatchObject({ code: 0, out: expect.stringContaining("nothing to update") });
    // No Orca in this home: nothing to do, and no setup ran.
    const mac = await update(h, ["--orca-plugin", "only"], builder("x"), "darwin");
    expect(mac).toMatchObject({ code: 0, out: expect.stringContaining("Orca isn't running") });
    expect(existsSync(join(h.dir, ".config", "cc-remote", "setup.lock"))).toBe(false);
    expect((await update(h, ["--orca-plugin", "only", "--check"])).code).toBe(2);
    // A profile named, by flag or environment, is the one meant: said when it isn't running, not another one used.
    for (const [argv, env] of [[["--orca-plugin", "only", "--orca-profile", "/nonexistent/orca"], h.env], [["--orca-plugin", "only"], { ...h.env, CC_REMOTE_ORCA_PROFILE: "/nonexistent/orca" }]] as const) {
      let out = "";
      expect(await main([...argv], { env, out: { write: (s: string) => (out += s) }, platform: "darwin" })).toBe(0);
      expect(out).toContain("the Orca Server of /nonexistent/orca isn't running");
    }
  });

  test("a failed build leaves everything as it was", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const r = await update(h, ["--source", h.source], builder(new Error("`bun run compile` failed")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("Nothing was switched");
    expect(current(h)).toBe("0.1.0-aaaaaaa");
  });

  test("with no checkout to build it says how to name one", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const r = await update(h, []);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--source");
  });

  test("on macOS a build carrying another usage plugin updates the installed one, with update --orca-plugin only", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const r = await update(h, ["--source", h.source], builder("0.2.0-bbbbbbb", "9.9.9"), "darwin");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage plugin: updated 0.4.0 → 9.9.9");
    // The plugin not following leaves the switch standing, told apart by exit status 3.
    const h2 = home({ managed: "0.1.0-aaaaaaa" });
    const partial = await update(h2, ["--source", h2.source], builder("0.2.0-bbbbbbb", "9.9.9", "ok", "fails"), "darwin");
    expect(partial.code).toBe(3);
    expect(partial.out).toContain("usage plugin: Orca refused");
    expect(partial.out).toContain("retry with `cc-remote update`");
    expect(current(h2)).toBe("0.2.0-bbbbbbb");
  });

  test("--check shows both builds and saves what it found", async () => {
    const h = home({ managed: "0.1.0-aaaaaaa" });
    const c = checkout();
    const r = await update(h, ["--check", "--source", c.root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`source:    0.2.0-${c.head}`);
    expect(r.out).toContain("Update available");
    expect(updateStatus()).toMatchObject({ current: "0.1.0-aaaaaaa", latest: `0.2.0-${c.head}` });
  });

  test("--version without --release, and --source with --release, are refused", async () => {
    const h = home();
    expect((await update(h, ["--version", "0.3.0"])).code).toBe(2);
    expect((await update(h, ["--release", "--source", h.source])).code).toBe(2);
  });
});

describe("the update status", () => {
  test("is checked at most every ten minutes, said only of the install it was found for", async () => {
    const h = home();
    const c = checkout();
    const env = { ...h.env, CC_REMOTE_SOURCE: c.root };
    const first = await refreshUpdateStatus(env, { now: 1_000 });
    expect(first).toMatchObject({ current: VERSION_ID, latest: `0.2.0-${c.head}`, source: c.root });
    expect(updateNotice(false, h.env)).toContain(`0.2.0-${c.head}`);
    writeFileSync(join(c.root, "src", "a.ts"), "export const a = 3;\n");
    // Within ten minutes the saved answer stands; forced, the checkout is asked again.
    expect((await refreshUpdateStatus(env, { now: 2_000 }))?.latest).toBe(`0.2.0-${c.head}`);
    expect((await refreshUpdateStatus(env, { now: 3_000, force: true }))?.latest).not.toBe(`0.2.0-${c.head}`);
    // Once another version is installed, the saved notice isn't this install's.
    const other = home({ managed: "9.9.9-ccccccc" });
    versionCache.dir = join(h.dir, "cache");
    expect(updateNotice(false, other.env)).toBeUndefined();
    expect(await refreshUpdateStatus({ ...env, CC_REMOTE_NO_UPDATE_CHECK: "1" }, { force: true })).toBeUndefined();
    expect(existsSync(join(h.dir, "cache", "update-status.json"))).toBe(true);
  });
});
