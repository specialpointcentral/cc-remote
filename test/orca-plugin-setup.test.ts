import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { bundledPluginFiles, bundledPluginVersion, materializePlugin } from "../src/setup/orca-plugin-bundle";
import { checkAndInstallUsagePlugin, inspectUsagePlugin, installBundledPlugin, pluginCompatibility, updateInstalledPlugin } from "../src/setup/orca-plugin";
import { OrcaError } from "../src/setup/orca";
import { Ctx } from "../src/setup/context";
import { parseArgs } from "../src/setup/args";
import { installedDesktopApp, stepOrca } from "../src/setup/steps/orca";
import { setLang } from "../src/setup/ui/i18n";

const homes: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "ccr-plugin-setup-")); homes.push(path); return path; };
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
// The language is global: an earlier setup run in the same process may have left it Chinese.
beforeEach(() => setLang("en"));

const GRANTS = { execution: "trusted-worker", capabilities: [], contributions: [{ kind: "commands" }, { kind: "statusBarItems" }] };
/** Orca's approval request for the bundled plugin at `path`. */
const approval = (path: string, grants: object = GRANTS) => new OrcaError("approval", "approval_required", {
  pluginKey: "local.cc-remote-usage", version: bundledPluginVersion, approvalFingerprint: "ap1-0123456789abcdef0123456789abcdef",
  source: { kind: "local-path", path }, grants,
});
const ctxFor = (flags: string[], h: string, io: { stdin?: PassThrough; stdout?: PassThrough; env?: Record<string, string> } = {}) =>
  new Ctx(parseArgs(flags), { env: { HOME: h, PATH: "", ...io.env }, platform: "darwin", stdin: io.stdin ?? new PassThrough(), stdout: io.stdout ?? new PassThrough() }, 1);

describe("bundled Orca usage plugin", () => {
  test("contains the exact runtime sources and materializes privately and idempotently", () => {
    const root = join(import.meta.dir, "..", "orca-usage-plugin");
    for (const path of ["src/worker.mjs", "src/popover.mjs", "src/usage-popover.swift"]) {
      expect(bundledPluginFiles[path]).toBe(readFileSync(join(root, path), "utf8"));
    }
    expect(JSON.parse(bundledPluginFiles["orca-plugin.json"]!).id).toBe("cc-remote-usage");
    const h = home();
    const target = materializePlugin(h);
    expect(materializePlugin(h)).toBe(target);
    expect(readFileSync(join(target, "src/usage-popover.swift"), "utf8")).toBe(bundledPluginFiles["src/usage-popover.swift"]);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o077).toBe(0);
    expect(existsSync(join(h, ".config", "cc-remote", "host"))).toBe(false);
  });

  test("does not use a symbolic-link bundle root", () => {
    const h = home();
    const outside = home();
    const dir = join(h, ".local", "share", "cc-remote");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "orca-plugin"));
    expect(() => materializePlugin(h)).toThrow();
    expect(existsSync(join(outside, "orca-plugin.json"))).toBe(false);
  });

  test("requires a supported desktop Orca before offering the macOS popover", () => {
    expect(pluginCompatibility("darwin", "1.4.259", "available")).toBe("ready");
    expect(pluginCompatibility("darwin", "1.4.247", "available")).toBe("old");
    expect(pluginCompatibility("darwin", "1.4.259", "blocked")).toBe("headless");
    expect(pluginCompatibility("darwin", undefined, "available")).toBe("unknown");
    expect(pluginCompatibility("linux", "1.4.259", "available")).toBe("platform");
  });

  test("distinguishes a stopped desktop app from an app not found in common locations", () => {
    const h = "/example/home";
    expect(installedDesktopApp(h, (path) => path === "/Applications/Orca.app/Contents/Info.plist")).toBe("/Applications/Orca.app");
    expect(installedDesktopApp(h, (path) => path === `${h}/Applications/Orca.app/Contents/Info.plist`)).toBe(`${h}/Applications/Orca.app`);
    expect(installedDesktopApp(h, () => false)).toBeUndefined();
  });

  test("checks an existing plugin without installing and does not query an old or headless Orca", async () => {
    const methods: string[] = [];
    const rpc = async (method: string) => { methods.push(method); return [{ pluginKey: "local.cc-remote-usage", version: bundledPluginVersion, status: "running" }]; };
    expect((await inspectUsagePlugin(rpc, "darwin", "1.4.259", "available")).kind).toBe("installed");
    expect(methods).toEqual(["plugins.list"]);
    methods.length = 0;
    expect((await inspectUsagePlugin(rpc, "darwin", "1.4.247", "available")).kind).toBe("old");
    expect((await inspectUsagePlugin(rpc, "darwin", "1.4.259", "blocked")).kind).toBe("headless");
    expect(methods).toEqual([]);
  });

  test("installs the bundled files only after Orca returns the matching limited approval", async () => {
    const h = home();
    const calls: any[] = [];
    const rpc = async (method: string, params: any) => {
      calls.push({ method, params });
      if (!params.approvalFingerprint) throw approval(params.source.path);
      return { pluginKey: "local.cc-remote-usage", version: bundledPluginVersion };
    };
    expect((await installBundledPlugin(h, rpc)).pluginKey).toBe("local.cc-remote-usage");
    expect(calls).toHaveLength(2);
    expect(calls[1].params.approvalFingerprint).toBe("ap1-0123456789abcdef0123456789abcdef");
    expect(calls[1].params.source.path).toStartWith(realpathSync(join(h, ".local", "share", "cc-remote", "orca-plugin")));
  });

  test("never approves an unexpected plugin capability or different source", async () => {
    const h = home();
    let count = 0;
    const rpc = async (_method: string, params: any) => {
      count++;
      throw approval(params.source.path, { execution: "trusted-worker", capabilities: [{ kind: "terminal:read" }], contributions: [] });
    };
    await expect(installBundledPlugin(h, rpc)).rejects.toThrow(/approval/i);
    expect(count).toBe(1);
  });

  test("explicit unattended installation reads back the enabled plugin after approval", async () => {
    const h = home();
    const methods: string[] = [];
    let installed = false;
    const rpc = async (method: string, params: any) => {
      methods.push(method);
      if (method === "plugins.list") return installed ? [{ pluginKey: "local.cc-remote-usage", version: bundledPluginVersion, status: "running" }] : [];
      if (!params.approvalFingerprint) throw approval(params.source.path);
      installed = true;
      return { pluginKey: "local.cc-remote-usage", version: bundledPluginVersion };
    };
    const ctx = ctxFor(["--yes", "--orca-plugin", "install"], h);
    const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available", "/test/profile");
    expect(result.status).toBe("pass");
    expect(methods).toEqual(["plugins.list", "plugins.install", "plugins.install", "plugins.list"]);
    expect(ctx.actions).toEqual([expect.objectContaining({ id: "orca.usage-plugin", profile: "/test/profile", ok: true })]);
  });

  test("check and unattended defaults report a missing plugin without writing or installing", async () => {
    for (const flags of [["--check"], ["--yes", "--install"]]) {
      const h = home();
      const methods: string[] = [];
      const rpc = async (method: string) => { methods.push(method); return []; };
      const ctx = ctxFor(flags, h);
      const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available");
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("not installed");
      expect(methods).toEqual(["plugins.list"]);
      expect(existsSync(join(h, ".local"))).toBe(false);
    }
  });

  test("the interactive offer defaults to no and shows the worker's access", async () => {
    const h = home();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; } });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
    let output = "";
    stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const methods: string[] = [];
    const rpc = async (method: string) => { methods.push(method); return []; };
    const ctx = ctxFor([], h, { stdin, stdout, env: { LANG: "en_US.UTF-8" } });
    const answer = setTimeout(() => stdin.write("\r"), 20);
    try {
      const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available");
      expect(result.status).toBe("info");
      expect(output).toContain("user's permissions");
      expect(output).toContain("[y/N]");
      expect(methods).toEqual(["plugins.list"]);
      expect(existsSync(join(h, ".local"))).toBe(false);
    } finally { clearTimeout(answer); }
  });

  test("an intentionally disabled plugin stays disabled by default", async () => {
    const h = home();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; } });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
    const methods: string[] = [];
    const rpc = async (method: string) => { methods.push(method); return [{ pluginKey: "local.cc-remote-usage", version: bundledPluginVersion, status: "disabled" }]; };
    const ctx = ctxFor([], h, { stdin, stdout });
    const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available");
    expect(result.status).toBe("warn");
    expect(methods).toEqual(["plugins.list"]);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });

  test("explicit installation still does nothing when the Orca desktop is unavailable", async () => {
    const h = home();
    const methods: string[] = [];
    const rpc = async (method: string) => { methods.push(method); return []; };
    const ctx = ctxFor(["--yes", "--orca-plugin", "install"], h);
    const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "blocked");
    expect(result.status).toBe("fail");
    expect(methods).toEqual([]);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });

  test("an older installed plugin is reported as outdated, with how to install this one", async () => {
    const rpc = async () => [{ pluginKey: "local.cc-remote-usage", version: "0.3.1", status: "running" }];
    const result = await checkAndInstallUsagePlugin(ctxFor(["--yes"], home()), rpc, "1.4.259", "available");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain(`0.3.1 is older than ${bundledPluginVersion}`);
    expect(result.remedy?.[0]).toContain("--orca-plugin install");
  });

  test("updating an installed plugin installs over an older one only, and nothing that isn't there", async () => {
    let installs = 0;
    let version = "0.3.1";
    let status = "running";
    const rpc = async (method: string, params: any) => {
      if (method === "plugins.list") return version ? [{ pluginKey: "local.cc-remote-usage", version, status }] : [];
      installs++;
      if (!params.approvalFingerprint) throw approval(params.source.path);
      version = bundledPluginVersion;
      return { pluginKey: "local.cc-remote-usage", version };
    };
    expect(await updateInstalledPlugin(rpc, home(), "darwin", "1.4.259", "available")).toEqual({ ok: true, detail: `updated 0.3.1 → ${bundledPluginVersion}` });
    expect(installs).toBe(2);
    expect((await updateInstalledPlugin(rpc, home(), "darwin", "1.4.259", "available")).detail).toContain("current");
    version = "0.3.1";
    status = "disabled";
    expect((await updateInstalledPlugin(rpc, home(), "darwin", "1.4.259", "available")).detail).toContain("left as it is");
    version = "";
    const h = home();
    expect((await updateInstalledPlugin(rpc, h, "darwin", "1.4.259", "available")).detail).toContain("not installed");
    expect(installs).toBe(2);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });

  test("an explicit install leaves a current, running plugin as it is, recording nothing", async () => {
    const h = home();
    const methods: string[] = [];
    const rpc = async (method: string) => { methods.push(method); return [{ pluginKey: "local.cc-remote-usage", version: bundledPluginVersion, status: "running" }]; };
    const ctx = ctxFor(["--yes", "--orca-plugin", "install"], h);
    const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available");
    expect(result.status).toBe("pass");
    expect(methods).toEqual(["plugins.list"]);
    expect(ctx.actions).toEqual([]);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });

  test("does not replace a newer installed plugin, even on an explicit install", async () => {
    const h = home();
    const methods: string[] = [];
    const rpc = async (method: string) => {
      methods.push(method);
      return [{ pluginKey: "local.cc-remote-usage", version: "999.0.0", status: "running" }];
    };
    const ctx = ctxFor(["--yes", "--orca-plugin", "install"], h);
    const result = await checkAndInstallUsagePlugin(ctx, rpc, "1.4.259", "available");
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("999.0.0");
    expect(methods).toEqual(["plugins.list"]);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });

  test("an explicit installation request fails clearly if Orca is not running", async () => {
    const h = home();
    const ctx = ctxFor(["--yes", "--orca-plugin", "install"], h);
    await stepOrca(ctx, undefined);
    expect(ctx.results.get("orca")?.some((c) => c.status === "fail")).toBe(true);
    expect(existsSync(join(h, ".local"))).toBe(false);
  });
});
