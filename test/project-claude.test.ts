import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { collect, limits } from "../src/project-claude";
import { archive } from "../src/tar";

const base = mkdtempSync(join(tmpdir(), "cc-remote-dotclaude-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const put = (path: string, content = path) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Every file under a directory, relative, with its content. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const saved = { ...limits };
let n = 0;
let project = "", claude = "";
beforeEach(() => {
  Object.assign(limits, saved);
  project = join(base, `project-${++n}`);
  claude = join(project, ".claude");
  put(join(claude, "settings.json"), "{}");
  put(join(claude, "settings.local.json"), "{}");
  put(join(claude, "hooks", "guard.sh"));
  put(join(claude, "CLAUDE.md"));
  put(join(claude, "commands", "deploy.md"), "deploy it");
  put(join(claude, "commands", "git", "pr.md"), "open a pr");
  put(join(claude, "commands", ".draft.md"));
  put(join(claude, "skills", "review", "SKILL.md"), "---\nname: review\n---\nreview");
  put(join(claude, "skills", "review", "scripts", "run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(join(claude, "skills", "review", "scripts", "run.sh"), 0o755);
  put(join(claude, "skills", "review", "node_modules", "dep.js"));
  put(join(claude, "agents", "helper.md"), "a helper");
});

describe("project .claude", () => {
  test("collects commands, skills and agents in a fixed order, and nothing else", () => {
    const { files, skipped } = collect(project);
    expect(files.map((f) => f.path)).toEqual(["commands/deploy.md", "commands/git/pr.md", "skills/review/SKILL.md", "skills/review/scripts/run.sh", "agents/helper.md"]);
    expect(files.find((f) => f.path.endsWith("run.sh"))?.executable).toBe(true);
    expect(skipped).toEqual([]);
  });

  test("follows symlinks only within their tree", () => {
    const outside = join(base, `outside-${n}`);
    put(join(outside, "secret.md"), "secret");
    symlinkSync(join(claude, "skills", "review"), join(claude, "skills", "alias"));
    symlinkSync(join(outside, "secret.md"), join(claude, "commands", "leak.md"));
    symlinkSync(outside, join(claude, "agents", "more"));
    symlinkSync(join(claude, "skills"), join(claude, "skills", "review", "loop"));
    symlinkSync(join(claude, "nowhere"), join(claude, "commands", "dangling.md"));
    const { files, skipped } = collect(project);
    expect(files.map((f) => f.path)).toEqual([
      "commands/deploy.md", "commands/git/pr.md",
      "skills/alias/SKILL.md", "skills/alias/scripts/run.sh", "skills/review/SKILL.md", "skills/review/scripts/run.sh",
      "agents/helper.md",
    ]);
    expect(skipped).toEqual(["commands/leak.md (a symlink out of .claude/commands)", "agents/more (a symlink out of .claude/agents)"]);
    expect(JSON.stringify(files)).not.toContain("secret");
  });

  test("a tree that links out of the project is skipped", () => {
    const shared = join(base, `shared-${n}`);
    put(join(shared, "x.md"));
    rmSync(join(claude, "agents"), { recursive: true });
    symlinkSync(shared, join(claude, "agents"));
    expect(collect(project).skipped).toEqual(["agents (a symlink out of the project)"]);
    // Inside the project it is followed.
    rmSync(join(claude, "agents"));
    put(join(project, "tools", "agents", "builder.md"));
    symlinkSync(join(project, "tools", "agents"), join(claude, "agents"));
    expect(collect(project).files.map((f) => f.path)).toContain("agents/builder.md");
  });

  test("skips what exceeds the limits", () => {
    Object.assign(limits, { files: 3, fileBytes: 25, totalBytes: 30 });
    put(join(claude, "commands", "big.md"), "x".repeat(26));
    put(join(claude, "agents", "zzz.md"), "z");
    const { files, skipped } = collect(project);
    // 9 + 9 + 8 bytes; SKILL.md is 29 bytes, run.sh 20.
    expect(files.map((f) => f.path)).toEqual(["commands/deploy.md", "commands/git/pr.md", "agents/helper.md"]);
    expect(skipped).toEqual([
      "commands/big.md (larger than 25 bytes)",
      "skills/review/SKILL.md (larger than 25 bytes)",
      "skills/review/scripts/run.sh (over 30 bytes in all)",
      "agents/zzz.md (more than 3 files)",
    ]);
  });

  test("the archive extracts with tar, long paths and modes included", () => {
    const deep = `skills/${"d".repeat(120)}/${"f".repeat(90)}.md`;
    const tooLong = `skills/${"a".repeat(200)}/${"b".repeat(150)}.md`;
    put(join(claude, ...deep.split("/")), "deep");
    put(join(claude, ...tooLong.split("/")), "long");
    const { files, skipped } = collect(project);
    expect(skipped).toEqual([`${tooLong} (path too long)`]);
    const out = join(base, `extract-${n}`);
    mkdirSync(out);
    const r = Bun.spawnSync(["tar", "-xf", "-", "-C", out], { stdin: archive(files.map((f) => ({ ...f, mode: f.executable ? 0o755 : 0o644 }))), stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(tree(out)[deep]).toBe("deep");
    expect(tree(out)["agents/helper.md"]).toBe("a helper");
    expect(statSync(join(out, "skills/review/scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, "agents/helper.md")).mode & 0o111).toBe(0);
  });

});
