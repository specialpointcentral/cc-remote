import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKey, kindOf, Lines, loadRedactor, machineValues, nameProblem, readConfig, Redactor, RedactionError, resetRedaction, type Value } from "../src/redact";
import { launch, remoteCommand, spawner } from "../src/ssh";
import { hostLaunch } from "../src/args";
import { workspace } from "../src/tools/util";
import { fakeHost } from "./fakehost";
import { isolate } from "./fixture";

const dir = mkdtempSync(join(tmpdir(), "cc-remote-redact-"));
afterAll(() => {
  resetRedaction();
  rmSync(dir, { recursive: true, force: true });
});

const KEY = new Uint8Array(32).fill(7);
const VALUES: Value[] = [
  { kind: "host", text: "devbox-7.lab.example.net" },
  { kind: "host", text: "devbox-7" },
  { kind: "ip", text: "10.20.30.40" },
  { kind: "ip6", text: "fd00::1:2" },
  { kind: "user", text: "alice" },
  { kind: "mid", text: "0123456789abcdef0123456789abcdef" },
  { kind: "dom", text: "corp.example.com" },
  { kind: "name", text: "Project Falcon" },
];
const REAL = /devbox-7|10\.20\.30\.40|fd00::1:2|alice|0123456789abcdef0123456789abcdef|corp\.example\.com|project falcon/i;
const make = (o: Partial<ConstructorParameters<typeof Redactor>[2]> = {}) => new Redactor(KEY, VALUES, { on: true, ...o });

describe("Redactor", () => {
  test("replaces each value at word edges, and restores exactly what was there", () => {
    const r = make();
    const text = [
      "ssh alice@devbox-7.lab.example.net -p 22; ping 10.20.30.40; curl http://[fd00::1:2]:8080/",
      "cd /home/alice/src && git clone git@git.corp.example.com:team/app.git",
      "machine 0123456789abcdef0123456789abcdef, DEVBOX-7 and devbox-7, Project Falcon ships",
    ].join("\n");
    const out = r.text(text);
    expect(out).not.toMatch(REAL);
    expect(out).toMatch(/^ssh ccr-user-[0-9a-f]{8}@ccr-host-[0-9a-f]{8} -p 22; ping ccr-ip-[0-9a-f]{8}; curl http:\/\/\[ccr-ip6-[0-9a-f]{8}\]:8080\//);
    // A subdomain keeps its own labels; the domain is a name under .invalid.
    expect(out).toMatch(/git@git\.ccr-dom-[0-9a-f]{8}\.invalid:team/);
    // Each spelling has its own placeholder, so restoring is exact.
    const [upper, lower] = /machine ccr-mid-[0-9a-f]{8}, (ccr-host-[0-9a-f]{8}) and (ccr-host-[0-9a-f]{8})/.exec(out)!.slice(1);
    expect(upper).not.toBe(lower);
    expect(r.restore(out)).toBe(text);
  });

  test("leaves longer words, numbers, addresses and names alone", () => {
    const r = make();
    for (const s of ["devbox-70", "xdevbox-7", "devbox-7_old", "10.20.30.401", "110.20.30.40", "10.20.30.40.5", "fd00::1:23", "malice", "alices",
      "mycorp.example.com", "corp.example.com.cn", "corp.example.community", "Project Falcons"]) {
      expect(r.text(s)).toBe(s);
    }
    // At other edges they are found: a dash, a dot at the end of a sentence, a path, a subdomain.
    expect(r.text("devbox-7-docker")).toMatch(/^ccr-host-[0-9a-f]{8}-docker$/);
    expect(r.text("ping 10.20.30.40.")).toMatch(/^ping ccr-ip-[0-9a-f]{8}\.$/);
    expect(r.text("a.b.corp.example.com")).toMatch(/^a\.b\.ccr-dom-[0-9a-f]{8}\.invalid$/);
  });

  test("restores only placeholders at the same edges, so whatever comes back is found again", () => {
    const r = make();
    const host = r.text("devbox-7");
    const ip = r.text("10.20.30.40");
    const dom = r.text("corp.example.com");
    // Written next to a word character, a placeholder stays one: restoring it would put back a
    // value that the next replacement would miss.
    for (const s of [`${host}_x`, `x${host}`, `1.${ip}`, `${ip}.5`, `${dom}.foo`, `${host}0`]) {
      expect(r.restore(s)).toBe(s);
    }
    for (const s of [`(${host})`, `${host}-x`, `${ip}/24`, `x.${dom}`, `${dom}.`]) {
      const back = r.restore(s);
      expect(back).toMatch(REAL);
      expect(r.text(back)).toBe(s);
    }
    // Unknown placeholders pass.
    expect(r.restore("ccr-host-00000000")).toBe("ccr-host-00000000");
  });

  test("is the same for the same key, and differs for another", () => {
    expect(make().text("devbox-7")).toBe(make().text("devbox-7"));
    expect(new Redactor(new Uint8Array(32).fill(8), VALUES, { on: true }).text("devbox-7")).not.toBe(make().text("devbox-7"));
  });

  test("a new spelling is kept, so another process restores it", () => {
    const kept: Record<string, string> = {};
    const r = make({ persist: (e) => Object.assign(kept, e) });
    const known = Object.keys(kept).length;
    const out = r.text("DevBox-7 alice");
    expect(Object.values(kept).slice(known)).toEqual(["DevBox-7"]);
    const later = new Redactor(KEY, VALUES, { on: true, table: kept });
    expect(later.restore(out)).toBe("DevBox-7 alice");
  });

  test("its values are kept from the start: an address that changed, or a name no longer listed, still reads back", () => {
    const kept: Record<string, string> = {};
    const first = new Redactor(KEY, [{ kind: "ip", text: "10.0.0.5" }, { kind: "name", text: "falcon" }], { on: true, persist: (e) => Object.assign(kept, e) });
    const out = first.text("from 10.0.0.5 on falcon");
    // Started again on another network, the name no longer listed.
    const later = new Redactor(KEY, [{ kind: "ip", text: "10.9.9.9" }], { on: true, table: { ...kept }, persist: (e) => Object.assign(kept, e) });
    expect(later.restore(out)).toBe("from 10.0.0.5 on falcon");
    // Once they are all in the table, a start writes nothing.
    let writes = 0;
    new Redactor(KEY, [{ kind: "ip", text: "10.9.9.9" }], { on: true, table: { ...kept }, persist: () => writes++ });
    expect(writes).toBe(0);
  });

  test("off, it replaces nothing but still restores", () => {
    const placeholder = make().text("devbox-7");
    const off = new Redactor(KEY, VALUES, { on: false });
    expect(off.text("devbox-7")).toBe("devbox-7");
    expect(off.jsonLine('{"a":"devbox-7"}')).toBe('{"a":"devbox-7"}');
    expect(off.restore(placeholder)).toBe("devbox-7");
    expect(off.active).toBe(true);
    expect(new Redactor(KEY, [], { on: false }).active).toBe(false);
  });

  test("a JSON line keeps its base64 data and its structure", () => {
    const r = make();
    const data = "AAAA+alice/devbox-7+BBBB";
    const line = JSON.stringify({ type: "user", message: { content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: "on devbox-7" },
    ] }, "devbox-7": 1 });
    const m = JSON.parse(r.jsonLine(line));
    expect(m.message.content[0].source.data).toBe(data);
    expect(m.message.content[1].data).toBe(data);
    expect(m.message.content[2].text).toMatch(/^on ccr-host-[0-9a-f]{8}$/);
    expect(Object.keys(m)).toEqual(["type", "message", r.text("devbox-7")]);
    expect(JSON.parse(r.jsonLine('{"a": "devbox-7",  "b":1}'))).toEqual({ a: r.text("devbox-7"), b: 1 });
    // Not JSON, it is text.
    expect(r.jsonLine("devbox-7 {")).toBe(`${r.text("devbox-7")} {`);
  });

  test("JSON keeps its format whatever the names: field names, protocol words, numbers and booleans", () => {
    const names = ["user", "true", "text", "model", "type"].map((text) => ({ kind: "name" as const, text }));
    const r = new Redactor(KEY, names, { on: true });
    const line = JSON.stringify({
      type: "user", message: { role: "user", model: "model", content: [{ type: "text", text: "a user said true" }] },
      isSidechain: true, n: 1, "/home/user/x": "y",
    });
    const sent = JSON.parse(r.jsonLine(line));
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    expect(sent.message.model).toBe("model");
    expect(sent.message.content[0].type).toBe("text");
    expect(sent.message.content[0].text).toMatch(/^a ccr-name-[0-9a-f]{8} said ccr-name-[0-9a-f]{8}$/);
    expect(sent.isSidechain).toBe(true);
    expect(sent.n).toBe(1);
    // A key that isn't a field's name is data.
    expect(Object.keys(sent)).toContain(`/home/${r.text("user")}/x`);
    // So is a JSON file, and a JSON value.
    const file = new TextDecoder().decode(r.file("a/plugin.json", new TextEncoder().encode('{"name": "user", "strict": true}\n')));
    expect(JSON.parse(file)).toEqual({ name: r.text("user"), strict: true });
    expect(JSON.parse(r.value('{"fastMode":true,"note":"user"}'))).toEqual({ fastMode: true, note: r.text("user") });
    expect(r.value("user")).toBe(r.text("user"));
  });

  test("protocol words stay only in the envelope; inside data they are data; numbers stay as written", () => {
    const names = ["initialize", "falcon"].map((text) => ({ kind: "name" as const, text }));
    const r = new Redactor(KEY, names, { on: true });
    // A JSON-RPC call to an MCP server, as claude's stream carries one.
    const rpc = JSON.stringify({ type: "control_request", request_id: "1", request: { subtype: "mcp_message", server_name: "x", message: { jsonrpc: "2.0", id: 1, method: "initialize", params: { method: "initialize", clientInfo: { name: "falcon" } } } } });
    const sent = JSON.parse(r.jsonLine(rpc));
    expect(sent.request.message.method).toBe("initialize");
    expect(sent.request.message.params).toEqual({ method: r.text("initialize"), clientInfo: { name: r.text("falcon") } });
    // A tool's input and a plugin's metadata are data, whatever their fields are called.
    const tool = JSON.parse(r.jsonLine(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x", input: { type: "falcon", model: "falcon" } }] } })));
    expect(tool.message.content[0].input).toEqual({ type: r.text("falcon"), model: r.text("falcon") });
    const plugin = new TextDecoder().decode(r.file("p/plugin.json", new TextEncoder().encode('{"name":"p","metadata":{"role":"falcon","model":"falcon"}}')));
    expect(JSON.parse(plugin).metadata).toEqual({ role: r.text("falcon"), model: r.text("falcon") });
    // Only the strings change: a 64-bit integer, spacing and escapes elsewhere stay byte for byte.
    const line = '{"node_id": 9007199254740993, "title": "falcon",\t"x": "\\u00e9", "n": -1.5e300}';
    expect(r.jsonLine(line)).toBe(`{"node_id": 9007199254740993, "title": "${r.text("falcon")}",\t"x": "\\u00e9", "n": -1.5e300}`);
  });

  test("a file is all data; a hook's and a permission answer's protocol words stay; a string cc-remote keeps goes as it is", () => {
    const names = ["falcon", "allow", "approve", "PreToolUse", "session", "plugins"].map((text) => ({ kind: "name" as const, text }));
    const r = new Redactor(KEY, names, { on: true });
    const f = r.text("falcon");
    // A project's or a plugin's JSON file has no envelope: no field keeps its value, and keys are data too.
    const file = new TextDecoder().decode(r.file("deploy.json", new TextEncoder().encode('{"deployment": {"model": "falcon", "type": "falcon"}, "falcon": true}')));
    expect(file).toBe(`{"deployment": {"model": "${f}", "type": "${f}"}, "${f}": true}`);
    // The SDK's answers to a hook and to a permission request.
    const hook = JSON.parse(r.jsonLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "cb1", response: {
      decision: "approve", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allow falcon" },
    } } })));
    expect(hook.response.response).toEqual({
      decision: "approve", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `${r.text("allow")} ${f}` },
    });
    const permission = JSON.parse(r.jsonLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "p1", response: {
      behavior: "allow", updatedInput: { note: "allow" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "allow falcon" }], behavior: "allow", destination: "session" }],
    } } })));
    expect(permission.response.response).toEqual({
      behavior: "allow", updatedInput: { note: r.text("allow") },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: `${r.text("allow")} ${f}` }], behavior: "allow", destination: "session" }],
    });
    // A plugin's path on the host, as cc-remote makes it and names it in claude's initialize request.
    const path = "../../.cc-remote/plugins/ccr-name-0123abcd-kit-1x2y";
    expect(r.text(path)).not.toBe(path);
    r.keep(path);
    const init = JSON.parse(r.jsonLine(JSON.stringify({ type: "control_request", request_id: "i", request: { subtype: "initialize", plugins: [{ type: "local", path }], appendSystemPrompt: "see .cc-remote/plugins" } })));
    expect(init.request.plugins).toEqual([{ type: "local", path }]);
    expect(init.request.appendSystemPrompt).toBe(`see .cc-remote/${r.text("plugins")}`);
  });

  test("claude's arguments: flags and their words stay, values are filtered, JSON as JSON", () => {
    const names = ["sonnet", "false", "falcon"].map((text) => ({ kind: "name" as const, text }));
    const r = new Redactor(KEY, names, { on: true });
    const args = r.args(["--model", "sonnet", "--settings", '{"fastMode":false,"x":"falcon"}', "--append-system-prompt=work on falcon", "--output-format=sonnet", "-p", "falcon"]);
    expect(args.slice(0, 3)).toEqual(["--model", "sonnet", "--settings"]);
    expect(JSON.parse(args[3]!)).toEqual({ fastMode: false, x: r.text("falcon") });
    expect(args.slice(4)).toEqual([`--append-system-prompt=work on ${r.text("falcon")}`, "--output-format=sonnet", "-p", r.text("falcon")]);
  });

  test("bytes: text is filtered, binary data passes", () => {
    const r = make();
    const bin = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode("devbox-7")]);
    expect(r.bytes(bin)).toBe(bin);
    const text = new TextEncoder().encode("﻿host devbox-7\n");
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(r.bytes(text))).toBe(`﻿host ${r.text("devbox-7")}\n`);
    expect(new TextDecoder().decode(r.restoreBytes(r.bytes(text)))).toBe("host devbox-7\n");
  });

  test("Lines never splits a value between chunks", () => {
    const r = make();
    const lines = r.lines("redact");
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    let out = dec(lines.push(enc("one devb")));
    expect(out).toBe("");
    out += dec(lines.push(enc("ox-7\ntwo ali")));
    out += dec(lines.push(enc("ce")));
    out += dec(lines.flush());
    expect(out).toBe(`one ${r.text("devbox-7")}\ntwo ${r.text("alice")}`);
    // A line longer than the limit goes in pieces.
    const small = new Lines((b) => b, 4);
    expect(dec(small.push(enc("abcdef")))).toBe("abcdef");
  });

  test("a long line in parts reads as the whole line: escapes, longer words and longer values at every cut", () => {
    const r = make();
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
    const run = (lines: Lines, text: string, size: number) => {
      const bytes = enc(text);
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(lines.push(bytes.subarray(i, i + size)));
      out.push(lines.flush());
      return dec(Buffer.concat(out));
    };
    // Edges decided by what is around a value: an escaped line break or tab, escaped backslashes
    // before a letter, a longer word, the longer value that holds a shorter one.
    const unit = String.raw`\nalice x\\nalice xalice alicex devbox-7.lab.example.net devbox-7 \talice `;
    // Every place in it lands on the first cut once.
    for (let shift = 0; shift < unit.length; shift++) {
      const text = "-".repeat(shift) + unit.repeat(Math.ceil(70_000 / unit.length));
      const whole = r.text(text);
      expect(run(r.lines("redact"), text, 65_537)).toBe(whole);
      expect(run(r.lines("restore"), whole, 65_537)).toBe(text);
    }
    const text = unit.repeat(Math.ceil(140_000 / unit.length));
    for (const size of [7, 4_093]) expect(run(r.lines("redact"), text, size)).toBe(r.text(text));
  });

  test("a long line goes in pieces that split neither a value nor a character, either way", () => {
    const r = make();
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
    const run = (lines: Lines, text: string, size: number) => {
      const bytes = enc(text);
      const out: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(lines.push(bytes.subarray(i, i + size)));
      out.push(lines.flush());
      return dec(Buffer.concat(out));
    };
    // Values at many places around the first cut, in two-byte characters that a byte count splits.
    for (const pad of [32_700, 32_760, 32_764, 32_766, 32_770]) {
      const text = `${"é".repeat(pad)} devbox-7 alice 10.20.30.40 ${"é".repeat(40_000)}`;
      for (const size of [4_093, 65_537]) {
        const sent = run(r.lines("redact"), text, size);
        expect(sent).not.toMatch(REAL);
        expect(sent).toBe(r.text(text));
        expect(run(r.lines("restore"), sent, size)).toBe(text);
      }
    }
  });

  test("streamed deltas: a placeholder split between deltas is restored whole, and the rest goes at the block's stop", () => {
    const r = make();
    const host = r.text("devbox-7");
    const ip = r.text("10.20.30.40");
    const delta = (text: string, index = 0) => JSON.stringify({ type: "stream_event", uuid: "u", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
    const stop = (index = 0) => JSON.stringify({ type: "stream_event", uuid: "u2", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_stop", index } });
    const restore = r.stream();
    const full = `on ${host}, at ${ip}`;
    const out: string[] = [];
    // Split everywhere, two characters at a time.
    for (let i = 0; i < full.length; i += 2) out.push(...restore(delta(full.slice(i, i + 2))));
    out.push(...restore(stop()));
    const events = out.map((l) => JSON.parse(l));
    const text = events.filter((e) => e.event.type === "content_block_delta").map((e) => e.event.delta.text).join("");
    expect(text).toBe("on devbox-7, at 10.20.30.40");
    expect(events.at(-1).event.type).toBe("content_block_stop");
    // Nothing that went out held a piece of a placeholder.
    expect(out.some((l) => l.includes("ccr-"))).toBe(false);
    // A complete message is restored as a whole.
    expect(JSON.parse(restore(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: full }] } }))[0]!).message.content[0].text).toBe("on devbox-7, at 10.20.30.40");
    // A placeholder followed by a word character, split across deltas, stays as it is.
    const kept: string[] = [];
    for (const piece of [host.slice(0, 5), host.slice(5), "x"]) kept.push(...restore(delta(piece, 1)));
    kept.push(...restore(stop(1)));
    expect(kept.map((l) => JSON.parse(l)).filter((e) => e.event.type === "content_block_delta").map((e) => e.event.delta.text).join("")).toBe(`${host}x`);
  });
});

describe("settings", () => {
  let iso: ReturnType<typeof isolate>;
  beforeAll(() => { iso = isolate(); });
  afterAll(() => iso.restore());
  const cfg = () => join(iso.home, ".config", "cc-remote");
  const write = (name: string, content: string, mode = 0o600) => {
    mkdirSync(cfg(), { recursive: true });
    writeFileSync(join(cfg(), name), content);
    chmodSync(join(cfg(), name), mode);
  };

  test("names: what they may be, and what kind each is", () => {
    expect(nameProblem("corp.example.com")).toBeUndefined();
    expect(nameProblem("Project Falcon")).toBeUndefined();
    expect(nameProblem("项目甲")).toBeUndefined();
    for (const bad of ["ab", "-lead", "trail-", "it's", "a/b", "$HOME", "x\ny", 7]) expect(nameProblem(bad)).toBeDefined();
    expect([kindOf("10.0.0.1"), kindOf("fd00::1"), kindOf("corp.example.com"), kindOf("Falcon"), kindOf("1.2.3")]).toEqual(["ip", "ip6", "dom", "name", "name"]);
  });

  test("no file is off; a broken one stops sessions; the key is made once, private", () => {
    expect(readConfig(cfg())).toBeUndefined();
    expect(loadRedactor(cfg()).active).toBe(false);
    write("redact.json", "{nope");
    expect(() => readConfig(cfg())).toThrow(RedactionError);
    write("redact.json", JSON.stringify({ enabled: true, names: ["ok-name", "x"] }));
    expect(() => readConfig(cfg())).toThrow(/"x"/);
    write("redact.json", JSON.stringify({ enabled: true, names: ["Project Falcon"] }), 0o644);
    expect(() => readConfig(cfg())).toThrow(/chmod 600/);
    write("redact.json", JSON.stringify({ enabled: true, names: ["Project Falcon"] }));
    const r = loadRedactor(cfg());
    expect(r.on).toBe(true);
    expect(r.text("Project Falcon")).toMatch(/^ccr-name-[0-9a-f]{8}$/);
    expect(r.text(hostname())).not.toBe(hostname());
    const key = join(cfg(), "redact.key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(ensureKey(cfg())).toEqual(ensureKey(cfg()));
    // Turned off, earlier placeholders still read back.
    const placeholder = r.text("Project Falcon");
    write("redact.json", JSON.stringify({ enabled: false, names: ["Project Falcon"] }));
    const off = loadRedactor(cfg());
    expect(off.on).toBe(false);
    expect(off.restore(placeholder)).toBe("Project Falcon");
    rmSync(cfg(), { recursive: true, force: true });
  });
});

test("a value starting a line inside JSON, after its \\n or \\t, is replaced, and its placeholder restored there", () => {
  const r = make();
  const output = "devbox-7.lab.example.net\nalice\t10.20.30.40\nfd00::1:2\ncorp.example.com\n0123456789abcdef0123456789abcdef\nProject Falcon";
  const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: output }] } });
  const sent = r.jsonLine(line);
  expect(sent).not.toMatch(REAL);
  // The model's reply puts a placeholder first on a line too.
  const placeholders = JSON.parse(sent).message.content[0].content as string;
  const reply = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "```\n" + placeholders + "\n```" }] } });
  expect(r.restore(reply)).toBe(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "```\n" + output + "\n```" }] } }));
  expect(r.restore(sent)).toBe(line);
  // Backslashes in pairs are backslashes: the letter after them starts a word.
  expect(r.text(String.raw`a\\nalice`)).toBe(String.raw`a\\nalice`);
  expect(r.text(String.raw`a\\\nalice`)).toMatch(/^a\\\\\\nccr-user-[0-9a-f]{8}$/);
});

test("this machine's fully qualified name is one of its identifiers, replaced whole", () => {
  if (process.platform === "linux" || process.platform === "darwin") {
    const full = spawnSync("hostname", ["-f"], { encoding: "utf8" }).stdout?.trim() ?? "";
    if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(full) && full.toLowerCase() !== hostname().toLowerCase()) {
      expect(machineValues().values).toContainEqual({ kind: "host", text: full });
    }
  }
  // Not its first label and the domain left after it.
  expect(make().text("ssh devbox-7.lab.example.net now")).toMatch(/^ssh ccr-host-[0-9a-f]{8} now$/);
});

describe("the wire", () => {
  const work = join(dir, "wire");
  const host = fakeHost(work);
  const tee = join(work, "claude-stdin");
  const KEYS = ["CC_REMOTE_SSH", "FAKE_SSH_LOG", "FAKE_HOST_HOME", "FAKE_CLAUDE_TEE"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, Bun.env[k]]));
  let iso: ReturnType<typeof isolate>;
  // The project's folder carries a code name, and the machine's name goes into the host folder's.
  const values: Value[] = [{ kind: "host", text: hostname() }, { kind: "name", text: "falcon" }];
  beforeAll(() => {
    iso = isolate();
    Object.assign(Bun.env, host.env, { FAKE_CLAUDE_TEE: tee });
    resetRedaction(new Redactor(KEY, values, { on: true }));
  });
  afterAll(() => {
    resetRedaction();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete Bun.env[k];
      else Bun.env[k] = saved[k];
    }
    iso.restore();
  });
  const real = new RegExp(`falcon|${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

  /** Every path below a folder. */
  const tree = (root: string): string[] => existsSync(root) ? readdirSync(root, { recursive: true }).map(String) : [];

  test("the remote command has placeholders and drops the ssh session's address", () => {
    const command = remoteCommand(["--append-system-prompt", "work on falcon-1"], { NOTE: "falcon" }, "/work/falcon");
    expect(command).toStartWith("unset SSH_CONNECTION SSH_CLIENT SSH_TTY; ");
    expect(command).not.toMatch(real);
    // Without a folder too, as for the usage query.
    expect(remoteCommand(["--append-system-prompt", "work on falcon-1"], {}, undefined)).toStartWith("unset SSH_CONNECTION SSH_CLIENT SSH_TTY; ");
  });

  test("only the data in the remote command is replaced: its own words, flags, a model and JSON booleans stay", () => {
    const words = ["exec", "env", "claude", "false", "sonnet", "mkdir"].map((text) => ({ kind: "name" as const, text }));
    resetRedaction(new Redactor(KEY, [...values, ...words], { on: true }));
    try {
      const command = remoteCommand(["--model", "sonnet", "--settings", '{"fastMode":false}', "--append-system-prompt", "claude, run env"], {}, "/work");
      expect(command).toContain(`mkdir -p "$HOME"/`);
      expect(command).toContain(`exec env  claude '--model' 'sonnet' '--settings' '{"fastMode":false}' '--append-system-prompt' 'ccr-name-`);
      expect(command).not.toContain("claude, run env");
    } finally {
      resetRedaction(new Redactor(KEY, values, { on: true }));
    }
  });

  test("a plugin's name on the host follows what is replaced, and claude is given the path it was uploaded to", () => {
    const plugin = join(realpathSync(iso.home), "named-tools");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "x.md"), "Uses bluefalcon.\n");
    const before = hostLaunch(["--plugin-dir", plugin], "/work", true).uploads[0]!.remote;
    // A name only its contents hold, and one in the path cc-remote makes for it.
    resetRedaction(new Redactor(KEY, [...values, { kind: "name", text: "bluefalcon" }, { kind: "name", text: "plugins" }], { on: true }));
    try {
      const plan = hostLaunch(["--plugin-dir", plugin], "/work", true);
      const remote = plan.uploads[0]!.remote;
      expect(remote).not.toBe(before);
      expect(remote).toStartWith(".cc-remote/plugins/");
      expect(remoteCommand(plan.args, {}, "/work")).toContain(remote);
    } finally {
      resetRedaction(new Redactor(KEY, values, { on: true }));
    }
  });

  test("a plugin goes over filtered: its folder's name, its files' names and contents, JSON as JSON", async () => {
    const project = join(realpathSync(iso.home), "plugin-app");
    const plugin = join(realpathSync(iso.home), "falcon-tools");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "falcon-tools", strict: false }, null, 2));
    writeFileSync(join(plugin, "commands", "falcon.md"), "Ship falcon.\n");
    // As `cc-remote claude` starts it, for Orca: its --plugin-dir goes to the host.
    const abort = new AbortController();
    const plan = hostLaunch(["--input-format", "stream-json", "--plugin-dir", plugin], project, true);
    expect(plan.uploads[0]!.remote).not.toMatch(real);
    const child = launch("box", project, plan.args, {}, plan.uploads, abort.signal);
    const plugins = join(host.home, ".cc-remote", "plugins");
    for (let i = 0; i < 400 && !tree(plugins).some((f) => f.endsWith(".md")); i++) await Bun.sleep(25);
    const files = tree(plugins);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    for (const f of files) {
      expect(f).not.toMatch(real);
      if (statSync(join(plugins, f)).isFile()) expect(readFileSync(join(plugins, f), "utf8")).not.toMatch(real);
    }
    const manifest = JSON.parse(readFileSync(join(plugins, files.find((f) => f.endsWith("plugin.json"))!), "utf8"));
    expect(manifest).toEqual({ name: expect.stringMatching(/^ccr-name-[0-9a-f]{8}-tools$/), strict: false });
    for (const call of host.calls()) expect(call).not.toMatch(real);
    const exited = new Promise((done) => child.once("exit", done));
    abort.abort();
    await exited;
  }, 30_000);

  test("a stream session: claude, its folder and the commands see placeholders; the SDK sees the real values", async () => {
    const project = join(realpathSync(iso.home), "falcon-app");
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    writeFileSync(join(project, ".claude", "commands", "falcon.md"), "Deploy falcon to its cluster.\n");
    const abort = new AbortController();
    const ws = workspace(project);
    const sdk = spawner("box", project, {}, ws)({ command: "claude", args: ["--input-format", "stream-json"], env: { ...process.env }, signal: abort.signal });
    const lines: string[] = [];
    let buffer = "";
    sdk.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    const message = { type: "user", message: { role: "user", content: `Build falcon in ${project} on ${hostname()}` } };
    sdk.stdin.write(`${JSON.stringify(message)}\n`);
    for (let i = 0; i < 400 && !lines.some((l) => l.includes('"type":"user"')); i++) await Bun.sleep(25);
    // The fake claude echoes its stdin: what comes back is restored.
    const echoed = JSON.parse(lines.find((l) => l.includes('"type":"user"'))!);
    expect(echoed.message.content).toBe(message.message.content);
    const received = readFileSync(tee, "utf8");
    expect(received).toContain("ccr-name-");
    expect(received).not.toMatch(real);
    for (const call of host.calls()) expect(call).not.toMatch(real);
    const folders = tree(join(host.home, ".cc-remote", "ws"));
    expect(folders.length).toBeGreaterThan(0);
    for (const f of folders) expect(f).not.toMatch(real);
    // The project's commands went over, filtered, under a filtered name.
    const synced = folders.find((f) => f.endsWith(".md"));
    expect(synced).toMatch(/ccr-name-[0-9a-f]{8}\.md$/);
    expect(readFileSync(join(host.home, ".cc-remote", "ws", synced!), "utf8")).toMatch(/^Deploy ccr-name-[0-9a-f]{8} to its cluster\.\n$/);
    const exited = new Promise((done) => sdk.once("exit", done));
    abort.abort();
    await exited;
  }, 30_000);
});
