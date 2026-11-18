import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKey, kindOf, Lines, loadRedactor, machineValues, nameProblem, readConfig, Redactor, RedactionError, resetRedaction, type Value } from "../src/redact";
import { remoteCommand, spawner } from "../src/ssh";
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
    const out = r.text("DevBox-7 alice");
    expect(Object.values(kept)).toEqual(["DevBox-7"]);
    const later = new Redactor(KEY, VALUES, { on: true, table: kept });
    expect(later.restore(out)).toBe("DevBox-7 alice");
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
    // Without base64 the line is replaced as text, which keeps it byte for byte otherwise.
    expect(r.jsonLine('{"a": "devbox-7",  "b":1}')).toBe(`{"a": "${r.text("devbox-7")}",  "b":1}`);
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
    const command = remoteCommand(["--model", "falcon-1"], {}, "/work/falcon");
    expect(command).toStartWith("unset SSH_CONNECTION SSH_CLIENT SSH_TTY; ");
    expect(command).not.toMatch(real);
  });

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
