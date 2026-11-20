import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriter } from "../src/proxy";
import { planLimits } from "../src/usage-query";
import * as usage from "../src/usage";
import { versionCache } from "../src/version";

const savedDir = versionCache.dir;
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccr-usage-"));
  versionCache.dir = dir;
});
afterEach(() => {
  versionCache.dir = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

/** The one saved file of a kind, as the Orca plugin reads it. */
const saved = (kind: string) => {
  const name = readdirSync(dir).find((n) => n.startsWith(`${kind}-usage-`));
  return name ? JSON.parse(readFileSync(join(dir, name), "utf8")) : undefined;
};

describe("session usage", () => {
  test("captures both rate-limit windows from Claude's normal SDK event without modifying the stream", () => {
    const r = rewriter({ cwd: "/work", hostDir: ".cc-remote/ws/h/work", mode: "default", host: "host-a" });
    const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
      five_hour: { utilization: 0.24, resetsAt: 1795114800 },
      seven_day: { utilization: 0.13, resetsAt: 1795701600 },
    } } };
    expect(JSON.parse(r.outbound(JSON.stringify(event), () => {})!)).toEqual(event);
    const account = usage.lastAccountUsage("host-a");
    expect(account?.fiveHour?.usedPercent).toBe(24);
    expect(account?.sevenDay?.usedPercent).toBe(13);
    expect(account?.fiveHour?.resetsAt).toBe(1795114800000);
    expect(usage.lastAccountUsage("host-b")).toBeUndefined();
  });

  test("an explicit quota refresh saves its percentage windows for the status bar", () => {
    usage.rememberFetchedUsage("host-a", { five_hour: { utilization: 32.5, resets_at: "2026-11-20T00:00:00Z" }, seven_day: { utilization: 71, resets_at: null } });
    const account = usage.lastAccountUsage("host-a");
    expect(account?.fiveHour?.usedPercent).toBe(32.5);
    expect(account?.fiveHour?.resetsAt).toBe(Date.parse("2026-11-20T00:00:00Z"));
    expect(account?.sevenDay?.usedPercent).toBe(71);
  });

  test("saves the fetched Fable window separately so later session events cannot erase it", () => {
    const limits = {
      five_hour: { utilization: 15, resets_at: "2026-11-20T00:00:00Z" },
      model_scoped: [{ display_name: "Fable", utilization: 42, resets_at: "2026-11-26T14:00:00Z" }],
    };
    const fetched = usage.rememberFetchedUsage("host-a", limits);
    usage.rememberAccountUsage("host-a", { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.2 } });
    expect(saved("model")).toMatchObject({ host: "host-a", models: [{ name: "Fable", usedPercent: 42, resetsAt: Date.parse("2026-11-26T14:00:00Z") }] });
    expect(usage.renderUsage("host-a", fetched, undefined)).toContain("Fable: 42% used");
    usage.rememberFetchedUsage("host-a", { model_scoped: [] });
    expect(saved("model").models).toEqual([]);
  });

  test("a partial rate event preserves the other window and ignores invalid fractions", () => {
    usage.rememberFetchedUsage("host-a", { seven_day: { utilization: 71, resets_at: null } });
    usage.rememberAccountUsage("host-a", { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5 } });
    usage.rememberAccountUsage("host-a", { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 9 } });
    expect(usage.lastAccountUsage("host-a")?.fiveHour?.usedPercent).toBe(50);
    expect(usage.lastAccountUsage("host-a")?.sevenDay?.usedPercent).toBe(71);
  });

  test("saves cumulative totals privately per host without recording conversation text", () => {
    const r = rewriter({ cwd: "/work", hostDir: ".cc-remote/ws/h/work", mode: "default", host: "host-a" });
    const frame = { type: "result", session_id: "session-1", result: "private conversation text", modelUsage: {
      one: { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6 },
      two: { inputTokens: 7, outputTokens: 8, cacheReadInputTokens: 9, cacheCreationInputTokens: 10 },
    } };
    expect(JSON.parse(r.outbound(JSON.stringify(frame), () => {})!)).toEqual(frame);
    expect(usage.lastSessionUsage("host-a")?.totals).toEqual({ input: 10, output: 12, cacheRead: 14, cacheWrite: 16 });
    expect(usage.lastSessionUsage("host-b")).toBeUndefined();
    const file = join(dir, readdirSync(dir).find((n) => n.startsWith("session-usage-"))!);
    expect(readFileSync(file, "utf8")).not.toContain("private conversation text");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });

  test("does not save incomplete token totals or replace a good snapshot with malformed data", () => {
    const r = rewriter({ cwd: "/work", hostDir: ".cc-remote/ws/h/work", mode: "default", host: "host-a" });
    const good = { type: "result", session_id: "a", modelUsage: { model: { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 8 } } };
    r.outbound(JSON.stringify(good), () => {});
    r.outbound(JSON.stringify({ ...good, modelUsage: { model: { inputTokens: 99 } } }), () => {});
    expect(usage.lastSessionUsage("host-a")?.totals.input).toBe(2);
  });

  test("names cache files by the host's sha256 alone, as the Orca plugin computes them", () => {
    const previous = Bun.env.CC_REMOTE_SSH;
    try {
      for (const ssh of ["ssh -J jump", undefined]) {
        if (ssh === undefined) delete Bun.env.CC_REMOTE_SSH; else Bun.env.CC_REMOTE_SSH = ssh;
        usage.rememberFetchedUsage("host-a", { five_hour: { utilization: 10, resets_at: null } });
      }
    } finally {
      if (previous === undefined) delete Bun.env.CC_REMOTE_SSH; else Bun.env.CC_REMOTE_SSH = previous;
    }
    const key = new Bun.CryptoHasher("sha256").update("host-a").digest("hex").slice(0, 24);
    expect(readdirSync(dir)).toEqual([`account-usage-v1-${key}.json`]);
  });

  test("a failed query shows the saved windows, each with when it was observed", () => {
    usage.rememberFetchedUsage("host-a", {
      five_hour: { utilization: 15, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 42, resets_at: null }],
    });
    const fromCache = usage.savedUsage("host-a");
    expect(fromCache?.fiveHour?.usedPercent).toBe(15);
    expect(fromCache?.models?.map((m) => [m.name, m.usedPercent])).toEqual([["Fable", 42]]);
    const view = usage.renderUsage("host-a", fromCache, undefined, true);
    expect(view).toContain("saved values");
    expect(view).toMatch(/5-hour: 15% used, observed \d{4}-/);
    expect(view).toMatch(/Fable: 42% used, observed \d{4}-/);
    expect(view).toContain("7-day: unavailable");
    expect(usage.savedUsage("host-b")).toBeUndefined();
  });

  test("a login with no plan limits is a failed query, not an empty answer", () => {
    expect(() => planLimits({ rate_limits_available: false, rate_limits: null })).toThrow(/no plan limits/);
    expect(planLimits({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } })).toEqual({ five_hour: { utilization: 1 } });
  });

  test("renders quota and the last completed session separately", () => {
    const fetched = usage.rememberFetchedUsage("central", { five_hour: { utilization: 20, resets_at: "2026-11-20T00:00:00Z" }, seven_day: { utilization: 60, resets_at: null } });
    const view = usage.renderUsage("central", fetched, {
      sessionId: "session-a", observedAt: "2026-11-19T10:00:00Z", totals: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(view).toContain("20% used, resets 2026-11-20T00:00:00.000Z");
    expect(view).toContain("60% used");
    expect(view).toContain("session-a");
    expect(view).toContain("2026-11-19T10:00:00Z");
    expect(view).toContain("Cache write: 4");
    expect(usage.renderUsage("central", undefined, undefined)).toContain("unavailable");
    expect(usage.renderUsage("central", undefined, undefined)).toContain("No completed session");
  });
});
