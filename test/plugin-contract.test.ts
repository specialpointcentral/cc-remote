import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activate, binary, layout, writeInstall } from "../src/install/layout";
import { saveUpdateStatus, updateNotice } from "../src/update/notice";
import * as usage from "../src/usage";
import { versionCache } from "../src/version";

/**
 * The Orca usage plugin is plain JavaScript that Orca runs, so it can't import cc-remote's code: it
 * finds cc-remote's files on its own. These cases write them with cc-remote's code and read them
 * with the plugin's, so neither side can change how they're found or named without the other.
 */
type Worker = {
  cacheRoot(): string;
  readCache(dir: string, host: string): { account?: any; model?: any; session?: any };
  readUpdate(dir: string, home: string): { current: string; latest: string } | null;
};
const worker: Worker = await import(join(import.meta.dir, "..", "orca-usage-plugin", "src", "worker.mjs"));

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccr-contract-"));
});
afterEach(() => {
  delete process.env.CC_REMOTE_USAGE_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the usage plugin and cc-remote", () => {
  test("find the same cache folder, CC_REMOTE_USAGE_CACHE_DIR first", () => {
    expect(worker.cacheRoot()).toBe(versionCache.dir);
    process.env.CC_REMOTE_USAGE_CACHE_DIR = dir;
    expect(worker.cacheRoot()).toBe(dir);
  });

  test("the plugin reads the usage cc-remote saves, by host", () => {
    process.env.CC_REMOTE_USAGE_CACHE_DIR = dir;
    usage.rememberFetchedUsage("host-a", {
      five_hour: { utilization: 32, resets_at: "2026-11-20T00:00:00Z" },
      seven_day: { utilization: 71, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 42, resets_at: "2026-11-26T14:00:00Z" }],
    });
    usage.rememberSessionUsage("host-a", { type: "result", session_id: "s1", modelUsage: { m: { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 8 } } });
    const read = worker.readCache(worker.cacheRoot(), "host-a");
    expect(read.account).toMatchObject({ host: "host-a", fiveHour: { usedPercent: 32 }, sevenDay: { usedPercent: 71, resetsAt: null } });
    expect(read.model).toMatchObject({ host: "host-a", models: [{ name: "Fable", usedPercent: 42 }] });
    expect(read.session).toMatchObject({ host: "host-a", sessionId: "s1", totals: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 } });
    expect(worker.readCache(worker.cacheRoot(), "host-b")).toEqual({ account: undefined, model: undefined, session: undefined });
  });

  test("agree on the update to offer: one found for the installed version, none once it has switched", () => {
    const saved = versionCache.dir;
    versionCache.dir = dir;
    try {
      const home = join(dir, "home");
      const env = { HOME: home };
      const l = layout(env);
      // As `cc-remote update` installs a version: its folder, the stable link, install.json.
      const install = (id: string) => {
        mkdirSync(dirname(binary(l, id)), { recursive: true });
        writeFileSync(binary(l, id), "");
        mkdirSync(dirname(l.stable), { recursive: true });
        activate(l, id);
        writeInstall(l, { current: id, installedAt: new Date().toISOString() });
      };
      install("0.1.0-aaaaaaa");
      saveUpdateStatus({ current: "0.1.0-aaaaaaa", latest: "0.1.0-bbbbbbb", source: "/src", checkedAt: Date.now() });
      expect(worker.readUpdate(dir, home)).toEqual({ current: "0.1.0-aaaaaaa", latest: "0.1.0-bbbbbbb" });
      expect(updateNotice(false, env)).toContain("0.1.0-bbbbbbb");
      install("0.1.0-ccccccc");
      expect(worker.readUpdate(dir, home)).toBeNull();
      expect(updateNotice(false, env)).toBeUndefined();
    } finally {
      versionCache.dir = saved;
    }
  });
});
