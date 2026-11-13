import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { snapshots } from "../src/tools/login";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash as makeBash } from "../src/tools/bash";
import { edit as makeEdit } from "../src/tools/edit";
import { glob as makeGlob } from "../src/tools/glob";
import { grep as makeGrep } from "../src/tools/grep";
import { notebookEdit as makeNotebookEdit } from "../src/tools/notebook";
import { read as makeRead } from "../src/tools/read";
import { stopping } from "../src/tools/shell";
import { bins, workspace } from "../src/tools/util";
import { write as makeWrite } from "../src/tools/write";
import { call, isolate } from "./fixture";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-test-"));
const ws = workspace(dir);
const [bash, edit, glob, grep, notebookEdit, read, write] = [makeBash, makeEdit, makeGlob, makeGrep, makeNotebookEdit, makeRead, makeWrite].map((t) => t(ws));
let env: ReturnType<typeof isolate>;
beforeAll(() => {
  env = isolate();
  snapshots.cacheDir = join(env.home, ".cache", "cc-remote", "shell");
});
afterAll(() => {
  env.restore();
  rmSync(dir, { recursive: true, force: true });
});

describe("Write and Read", () => {
  test("creates parent directories and reads back with line numbers", async () => {
    const file = join(dir, "a/b/c.txt");
    expect((await call(write, { file_path: file, content: "one\ntwo\nthree\n" })).text).toBe(`File created successfully at: ${file}`);
    expect((await call(write, { file_path: file, content: "one\ntwo\nthree\n" })).text).toContain("updated successfully");
    expect((await call(read, { file_path: file })).text).toBe("     1\tone\n     2\ttwo\n     3\tthree");
    expect((await call(read, { file_path: file, offset: 2, limit: 1 })).text).toBe("     2\ttwo");
  });
  test("reports missing files and directories", async () => {
    expect(await call(read, { file_path: join(dir, "nope") })).toMatchObject({ error: true });
    expect((await call(read, { file_path: dir })).text).toContain("EISDIR");
  });
  test("returns images as image blocks", async () => {
    await Bun.write(join(dir, "x.png"), new Uint8Array([137, 80, 78, 71]));
    expect((await call(read, { file_path: join(dir, "x.png") })).text).toBe("[image]");
  });
});

describe("Read line ranges", () => {
  const file = join(dir, "lines.txt");
  test("keeps Claude Code's numbering, cut long lines and messages for empty and short files", async () => {
    await Bun.write(file, `one\n${"x".repeat(2500)}\nthree`);
    expect((await call(read, { file_path: file })).text).toBe(`     1\tone\n     2\t${"x".repeat(2000)}…\n     3\tthree`);
    expect((await call(read, { file_path: file, offset: 3 })).text).toBe("     3\tthree");
    expect((await call(read, { file_path: file, offset: 9 })).text).toContain("shorter than the provided offset (9). The file has 3 lines.");
    await Bun.write(file, "");
    expect((await call(read, { file_path: file })).text).toContain("the contents are empty");
    await Bun.write(file, "\n");
    expect((await call(read, { file_path: file })).text).toBe("     1\t");
  });
  test("reads only as far as the range: a file that never ends still answers", async () => {
    const fifo = join(dir, "endless");
    Bun.spawnSync(["mkfifo", fifo]);
    // The writer keeps its end open, so the file never reaches its end.
    const holder = Bun.spawn(["sh", "-c", `exec 3>'${fifo}'; printf 'a\\nb\\nc\\n' >&3; sleep 30`], { stdout: "ignore" });
    const started = Date.now();
    expect((await call(read, { file_path: fifo, limit: 2 })).text).toBe("     1\ta\n     2\tb");
    expect(Date.now() - started).toBeLessThan(5000);
    holder.kill();
  });
});

describe("Grep limits", () => {
  const path = join(dir, "many");
  beforeAll(async () => {
    for (let i = 0; i < 300; i++) await Bun.write(join(path, `f${String(i).padStart(3, "0")}.txt`), "hit\n");
  });
  test("shows 250 results unless head_limit says otherwise, and offset pages through them", async () => {
    const first = (await call(grep, { pattern: "hit", path })).text;
    expect(first.split("\n")[0]).toBe("Found 250 files");
    expect(first).toContain("Pass offset: 250");
    const page = (await call(grep, { pattern: "hit", path, head_limit: 100, offset: 250 })).text;
    expect(page.split("\n")[0]).toBe("Found 50 files");
    expect(page).not.toContain("offset");
    expect((await call(grep, { pattern: "hit", path, head_limit: 0 })).text.split("\n")[0]).toBe("Found 300 files");
    expect((await call(grep, { pattern: "hit", path, output_mode: "count", head_limit: 2 })).text.split("\n").slice(0, 2).every((l) => l.endsWith(":1"))).toBe(true);
  });
  test("stops searching once it has what it shows", async () => {
    const fifo = join(dir, "endless-matches");
    Bun.spawnSync(["mkfifo", fifo]);
    const holder = Bun.spawn(["sh", "-c", `exec 3>'${fifo}'; while :; do echo hit >&3 || exit; done`], { stdout: "ignore", stderr: "ignore" });
    const started = Date.now();
    const { text } = await call(grep, { pattern: "hit", path: fifo, output_mode: "content", "-n": false, head_limit: 3 });
    expect(text.split("\n").slice(0, 3)).toEqual(["hit", "hit", "hit"]);
    expect(Date.now() - started).toBeLessThan(5000);
    holder.kill();
  });
});

describe("Glob", () => {
  const root = join(dir, "globbed");
  beforeAll(async () => {
    for (const f of ["top.ts", "a/x.ts", "a/b/y.ts", ".hidden/h.ts", "node_modules/n/i.ts", "skipped/s.ts"]) await Bun.write(join(root, f), "");
    await Bun.write(join(root, ".gitignore"), "skipped/\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  });
  // Both ways of listing, when ripgrep is installed: they agree on what a pattern means.
  for (const [name, rg] of [["Bun.Glob", null], ...(bins.rg ? [["ripgrep", bins.rg]] : [])] as [string, string | null][]) {
    test(`${name}: anchors a bare pattern at the directory, lists hidden files and skips node_modules`, async () => {
      const saved = bins.rg;
      bins.rg = rg;
      try {
        const list = async (pattern: string) => (await call(glob, { pattern, path: root })).text.split("\n").map((f) => f.slice(root.length + 1)).sort();
        expect(await list("*.ts")).toEqual(["top.ts"]);
        expect(await list("a/*.ts")).toEqual(["a/x.ts"]);
        const all = await list("**/*.ts");
        expect(all).toEqual(rg ? [".hidden/h.ts", "a/b/y.ts", "a/x.ts", "top.ts"] : [".hidden/h.ts", "a/b/y.ts", "a/x.ts", "skipped/s.ts", "top.ts"]);
        expect(await list("node_modules/**/*.ts")).toEqual(["node_modules/n/i.ts"]);
        expect((await call(glob, { pattern: "*.nothing", path: root })).text).toBe("No files found");
      } finally {
        bins.rg = saved;
      }
    });
  }
  test("keeps the newest 100", async () => {
    const many = join(dir, "hundreds");
    for (let i = 0; i < 150; i++) await Bun.write(join(many, `f${i}.txt`), "");
    await Bun.sleep(20);
    await Bun.write(join(many, "newest.txt"), "");
    const lines = (await call(glob, { pattern: "*.txt", path: many })).text.split("\n");
    expect(lines[0]).toBe(join(many, "newest.txt"));
    expect(lines).toHaveLength(101);
    expect(lines[100]).toContain("Results are truncated");
  });
});

describe("Edit", () => {
  const file = join(dir, "edit.txt");
  test("replaces a unique match literally", async () => {
    await Bun.write(file, "price: 1\nname: x\n");
    expect((await call(edit, { file_path: file, old_string: "price: 1", new_string: "price: $&" })).error).toBe(false);
    expect(await Bun.file(file).text()).toBe("price: $&\nname: x\n");
  });
  test("refuses ambiguous matches unless replace_all", async () => {
    await Bun.write(file, "a a a");
    expect((await call(edit, { file_path: file, old_string: "a", new_string: "b" })).text).toContain("Found 3 matches");
    await call(edit, { file_path: file, old_string: "a", new_string: "b", replace_all: true });
    expect(await Bun.file(file).text()).toBe("b b b");
  });
  test("reports a missing string and creates files from an empty old_string", async () => {
    expect((await call(edit, { file_path: file, old_string: "zzz", new_string: "y" })).text).toContain("not found");
    const created = join(dir, "new.txt");
    await call(edit, { file_path: created, old_string: "", new_string: "hi" });
    expect(await Bun.file(created).text()).toBe("hi");
  });
});

describe("Bash", () => {
  test("merges stdout and stderr and reports exit codes", async () => {
    expect(await call(bash, { command: "echo out; echo err >&2" })).toEqual({ text: "out\nerr", error: false });
    expect(await call(bash, { command: "echo nope; exit 3" })).toEqual({ text: "nope\nExit code 3", error: true });
  });
  test("keeps the working directory between calls, per workspace", async () => {
    await call(bash, { command: `mkdir -p sub && cd sub` });
    expect((await call(bash, { command: "pwd -P" })).text).toBe(Bun.spawnSync(["realpath", join(dir, "sub")]).stdout.toString().trim());
    const other = makeBash(workspace(tmpdir()));
    expect((await call(other, { command: "pwd -P" })).text).toBe(Bun.spawnSync(["realpath", tmpdir()]).stdout.toString().trim());
  });
  test("resolves relative paths against the workspace", async () => {
    await call(write, { file_path: "rel.txt", content: "here" });
    expect(await Bun.file(join(dir, "rel.txt")).text()).toBe("here");
  });
  test("runs commands in the background and writes their output to a file", async () => {
    const { text } = await call(bash, { command: "echo bg-ok; sleep 30", run_in_background: true });
    const file = text.match(/written to: (\S+)\./)![1]!;
    await Bun.sleep(300);
    expect(await Bun.file(file).text()).toBe("bg-ok\n");
    const pid = Number(text.match(/ID: (\d+)/)![1]);
    process.kill(-pid, "SIGKILL");
    rmSync(file, { force: true });
  });
  test("times out and does not wait for background children", async () => {
    const started = Date.now();
    expect((await call(bash, { command: "sleep 30", timeout: 1000 })).text).toContain("timed out");
    expect((await call(bash, { command: "sleep 30 & echo started" })).text).toBe("started");
    expect(Date.now() - started).toBeLessThan(5000);
  });
  test("stops a timed-out command with SIGTERM first, so it can clean up", async () => {
    const { text, error } = await call(bash, { command: "trap 'echo cleaned-up; exit 3' TERM; sleep 30 & wait", timeout: 1000 });
    expect(error).toBe(true);
    expect(text).toBe("cleaned-up\nCommand timed out after 1000ms");
  });
  test("kills what ignores SIGTERM once the grace period ends", async () => {
    const grace = stopping.graceMs;
    stopping.graceMs = 300;
    try {
      const started = Date.now();
      expect((await call(bash, { command: "trap '' TERM; sleep 30", timeout: 1000 })).text).toContain("timed out");
      expect(Date.now() - started).toBeGreaterThanOrEqual(1300);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      stopping.graceMs = grace;
    }
  });
  test("an abort stops the command", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const started = Date.now();
    await call(bash, { command: "sleep 30" }, { signal: abort.signal });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  test("refuses a command the user's deny rules cover, before it runs, in every mode", async () => {
    const settings = join(env.home, ".claude", "settings.json");
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "x");
    try {
      for (const command of [`rm ${victim}`, `echo ok && rm ${victim}`, `echo "$(rm ${victim})"`]) {
        const { text, error } = await call(bash, { command });
        expect(error).toBe(true);
        expect(text).toContain("Bash(rm:*)");
      }
      expect((await call(bash, { command: `rm ${victim}`, run_in_background: true })).error).toBe(true);
      expect(existsSync(victim)).toBe(true);
      expect((await call(bash, { command: `echo rm ${victim}` })).error).toBe(false);
    } finally {
      rmSync(settings);
    }
    // The rules are read again once the file changes.
    expect((await call(bash, { command: `rm ${victim}` })).error).toBe(false);
    expect(existsSync(victim)).toBe(false);
  });
});

describe("Glob and Grep", () => {
  test("finds files newest first and skips node_modules", async () => {
    await Bun.write(join(dir, "g/old.ts"), "export const needle = 1;\n");
    await Bun.sleep(20);
    await Bun.write(join(dir, "g/new.ts"), "const NEEDLE = 2;\n");
    await Bun.write(join(dir, "g/node_modules/dep.ts"), "needle");
    expect((await call(glob, { pattern: "**/*.ts", path: join(dir, "g") })).text).toBe(`${dir}/g/new.ts\n${dir}/g/old.ts`);
  });
  test("searches contents in each output mode", async () => {
    const path = join(dir, "g");
    expect((await call(grep, { pattern: "needle", path })).text).toBe(`Found 1 file\n${dir}/g/old.ts`);
    expect((await call(grep, { pattern: "needle", path, "-i": true, output_mode: "count" })).text.split("\n").sort()).toEqual([`${dir}/g/new.ts:1`, `${dir}/g/old.ts:1`]);
    expect((await call(grep, { pattern: "NEEDLE", path, output_mode: "content" })).text).toBe(`${dir}/g/new.ts:1:const NEEDLE = 2;`);
    expect((await call(grep, { pattern: "absent", path })).text).toBe("No files found");
  });
});

describe("Notebooks", () => {
  const file = join(dir, "nb.ipynb");
  const nb = {
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [
      { id: "intro", cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
      { id: "calc", cell_type: "code", metadata: {}, execution_count: 1, source: ["1 + 1"],
        outputs: [{ output_type: "execute_result", data: { "text/plain": ["2"] }, metadata: {}, execution_count: 1 }] },
    ],
  };
  test("Read shows cells with ids and outputs", async () => {
    await Bun.write(file, JSON.stringify(nb));
    const { text } = await call(read, { file_path: file });
    expect(text).toContain('<cell id="intro" type="markdown">\n# Title\n');
    expect(text).toContain('<cell id="calc" type="code">\n1 + 1\n</cell>\n<output>\n2\n</output>');
  });
  test("NotebookEdit replaces, inserts and deletes cells", async () => {
    await Bun.write(file, JSON.stringify(nb));
    await call(notebookEdit, { notebook_path: file, cell_id: "calc", new_source: "2 + 2" });
    let cells = (await Bun.file(file).json()).cells;
    expect(cells[1]).toMatchObject({ source: ["2 + 2"], outputs: [], execution_count: null });

    const inserted = await call(notebookEdit, { notebook_path: file, cell_id: "intro", new_source: "x = 1\ny = 2", cell_type: "code", edit_mode: "insert" });
    cells = (await Bun.file(file).json()).cells;
    expect(cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(["markdown", "code", "code"]);
    expect(cells[1].source).toEqual(["x = 1\n", "y = 2"]);
    expect(inserted.text).toContain(cells[1].id);

    await call(notebookEdit, { notebook_path: file, cell_id: "intro", new_source: "", edit_mode: "delete" });
    expect((await Bun.file(file).json()).cells).toHaveLength(2);
    expect((await call(notebookEdit, { notebook_path: file, cell_id: "nope", new_source: "" })).error).toBe(true);
  });
});
