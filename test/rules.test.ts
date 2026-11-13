import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ShellSyntaxError, simpleCommands } from "../src/lexer";
import { globalExcludesFile, IGNORE_PATTERN, localSettingsDir, resetLocalSettings } from "../src/local-settings";
import { broad, decide, evaluate, persistAllowRule, refusal, rulePattern, type Rules, rulesFor, rulesHook, settingsLocations, TrackedSettingsError } from "../src/rules";

const base = mkdtempSync(join(tmpdir(), "cc-remote-rules-"));
const config = join(base, "config");
const managed = join(base, "managed");
const saved = { config: process.env.CLAUDE_CONFIG_DIR, managed: settingsLocations.managed };
process.env.CLAUDE_CONFIG_DIR = config;
settingsLocations.managed = managed;
afterAll(() => {
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.config;
  settingsLocations.managed = saved.managed;
  rmSync(base, { recursive: true, force: true });
});

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

let n = 0;
let project = "";
beforeEach(() => {
  rmSync(config, { recursive: true, force: true });
  rmSync(managed, { recursive: true, force: true });
  project = join(base, `project-${++n}`);
  put(join(config, "settings.json"), { permissions: { allow: ["Bash(npm test:*)", "Bash(git status)", "Read(*)"], deny: ["Bash(rm:*)"] } });
  put(join(project, ".claude", "settings.local.json"), { permissions: { ask: ["Bash(git push *)"] } });
});

const claude = (command: string, mode: string | undefined = "default") => {
  const v = evaluate(command, mode, rulesFor(project, "Bash"));
  return [v.decision, v.reason ?? ""];
};

describe("lexer", () => {
  test("lists each simple command from its command word, inner substitutions first", () => {
    const command = 'cd a && sudo -u root rm -rf "x\ty"; echo $(git push) `ls`\ncat <<\'EOF\'\nrm body\nEOF\n';
    expect(simpleCommands(command).map((c) => c.words)).toEqual([["cd", "a"], ["rm", "-rf", "x\ty"], ["git", "push"], ["ls"], ["echo", "$()", "$()"], ["cat"]]);
    expect(simpleCommands("sudo -u root rm x")[0]!.wrappers).toEqual(["sudo", "-u", "root"]);
  });

  test("skips Claude Code's wrappers and their option values", () => {
    const words = (command: string) => simpleCommands(command).map((c) => c.words);
    for (const command of ["timeout 30 rm x", "timeout -s KILL 5 rm x", "nice -n 5 rm x", "nohup rm x", "stdbuf -oL rm x", "builtin rm x", "noglob rm x",
      "xargs rm x", "xargs -I {} rm x", "time -p rm x", "env -u HOME FOO=1 rm x", "exec -a name rm x", "command -- rm x", "FOO=1 rm x", "2>/dev/null rm x"]) {
      expect(words(command)).toEqual([["rm", "x"]]);
    }
    // `command -v` looks a command up instead of running it.
    expect(words("command -v rm")).toEqual([["command", "-v", "rm"]]);
    // A wrapper with no command after it is a command too.
    expect(words("exec >log 2>&1")).toEqual([["exec"]]);
    expect(words("make &>build.log; ls")).toEqual([["make"], ["ls"]]);
  });

  test("rejects what it can't split", () => {
    for (const command of ['printf "unterminated', "printf $'unterminated", "printf $'escaped\\'", "cat <<'EOF'\ntext\n", "printf x \\",
      "$'\\x63odex'", "cat <<$'\\x45OF'\ntext\nEOF\n", "echo $(ls", "echo $((1 + 2)"]) {
      expect(() => simpleCommands(command)).toThrow(ShellSyntaxError);
    }
  });
});

describe("rule patterns", () => {
  // The rows of Claude Code's "Wildcard patterns" table.
  const cases: [string, string[], string[]][] = [
    ["Bash(npm run build)", ["npm run build"], ["npm run build --watch"]],
    ["Bash(npm run *)", ["npm run build", "npm run test --watch", "npm run"], ["npm install", "npm runner"]],
    ["Bash(git log * main)", ["git log --oneline main", "git log -5 main"], ["git log main", "git push origin main"]],
    ["Bash(git * main)", ["git merge main", "git push origin main"], ["git log"]],
    ["Bash(* --version)", ["node --version"], ["node -v"]],
    ["Bash(ls *)", ["ls -la", "ls"], ["lsof"]],
    ["Bash(ls:*)", ["ls -la", "ls"], ["lsof"]],
    ["Bash(ls*)", ["ls -la", "lsof"], []],
    ["Bash(* --help *)", ["npm --help x"], ["npm --help"]],
    ["Bash(git:* push)", ["git:x push"], ["git push"]],
    ["Bash('my tool' --flag:*)", ["my tool --flag", "my tool --flag x"], ["my tool"]],
    ["Bash", ["anything at all"], []],
    ["Bash(*)", ["anything at all"], []],
  ];
  for (const [rule, yes, no] of cases) {
    test(rule, () => {
      const pattern = rulePattern(rule, "Bash");
      for (const c of yes) expect(pattern.test(c)).toBe(true);
      for (const c of no) expect(pattern.test(c)).toBe(false);
    });
  }
});

describe("Claude rules", () => {
  test("deny and ask rules match any simple command, in every mode", () => {
    for (const mode of ["default", "auto", "bypassPermissions"]) {
      for (const command of ["npm test && rm -rf x", "echo $(rm -f a)", "sudo -u root /bin/rm -rf b", "timeout 5 rm x", "xargs -n1 rm"]) {
        expect(claude(command, mode)).toEqual(["deny", "the permission rule Bash(rm:*) denies this command"]);
      }
      expect(claude("git push origin main", mode)).toEqual(["ask", "the permission rule Bash(git push *) asks first"]);
    }
    // dontAsk mode refuses what an ask rule covers, as Claude Code does.
    expect(claude("git push origin main", "dontAsk")).toEqual(["deny", "the permission rule Bash(git push *) asks first, and dontAsk mode doesn't ask"]);
    // Data is not a command: a literal here-document body or an argument never matches.
    expect(claude("cat <<'EOF'\nrm -rf x\nEOF")).toEqual(["none", ""]);
    expect(claude("echo rm -rf x")).toEqual(["none", ""]);
  });

  test("allow rules approve only a plain single command, in modes where Claude's would", () => {
    const allowed = ["allow", "allowed by the permission rule Bash(npm test:*)"];
    for (const mode of ["default", "acceptEdits", "dontAsk", "auto"]) expect(claude("npm test -- --watch", mode)).toEqual(allowed);
    expect(claude("git status")[0]).toBe("allow");
    for (const mode of ["plan", "bypassPermissions"]) expect(claude("npm test", mode)).toEqual(["none", ""]);
    expect(evaluate("npm test", undefined, rulesFor(project, "Bash")).decision).toBe("none");
    for (const command of ["npm testing", "git status -s", "npm test > out", "npm test | tee log", "npm test $HOME", "npm test '$HOME'",
      "npm test *.js", "/tmp/x/npm test", "FOO=1 npm test", "sudo npm test", "npm test\nnpm test"]) {
      expect(claude(command)).toEqual(["none", ""]);
    }
  });

  test("auto mode keeps only narrow allow rules, as Claude Code does", () => {
    const rules: Rules = { allow: ["Bash(*)", "Bash(python3:*)", "Bash(npm run:*)", "Bash(ls*)", "Bash(sudo *)", "Bash(make:*)", "Bash(npm run build)", "Bash(git log:*)", "Bash(python3 manage.py check)"], ask: [], deny: [] };
    for (const command of ["python3 -c x", "npm run anything", "lsof", "sudo ls", "make all", "rm x"]) {
      expect(decide(command, "default", rules)).toBe("allow");
      expect(decide(command, "auto", rules)).toBe("none");
    }
    for (const command of ["npm run build", "git log -5", "python3 manage.py check"]) expect(decide(command, "auto", rules)).toBe("allow");
    expect(broad("Bash", "Bash")).toBe(true);
    expect(broad("Bash(npm test)", "Bash")).toBe(false);
    expect(broad("Bash(git * main)", "Bash")).toBe(true);
  });

  test("removing a critical path asks where it can and is refused where it can't, whatever allows it", () => {
    const rules: Rules = { allow: ["Bash(rm:*)"], ask: [], deny: [] };
    const cwd = join(base, "work", "app");
    const verdict = (command: string, mode: string) => evaluate(command, mode, rules, "Bash", cwd).decision;
    for (const command of ["rm -rf /", "rm -rf /usr", "rm -rf ~", "rm -rf $HOME/", "rm -rf ~/$(echo x)", `rm -rf ${cwd}`, `rm -rf ${dirname(cwd)}`, "rm -rf .", "rm -rf ./*",
      "rm -rf *", "rm -rf ..", 'rm -rf "$DIR"/*', 'rm -rf "$(pwd)"', "cd x && sudo rm -r /etc", "bash -c 'rm -rf ~'", "echo $(rm -rf /)"]) {
      expect([command, verdict(command, "default")]).toEqual([command, "ask"]);
      expect(verdict(command, "bypassPermissions")).toBe("ask");
      expect(verdict(command, "auto")).toBe("deny");
      expect(verdict(command, "dontAsk")).toBe("deny");
    }
    for (const command of ["rm -rf build", "rm x", "rm -rf /tmp/scratch"]) expect([command, verdict(command, "auto")]).toEqual([command, "allow"]);
    // Not critical, and not plain enough for an allow rule: left to claude.
    for (const command of ["rm -rf ./dist/*", 'rm -rf "${DIR:?}"/*', "echo rm -rf /"]) expect([command, verdict(command, "auto")]).toEqual([command, "none"]);
    // An explicit ask rule asks, also in auto mode.
    expect(evaluate("rm -rf ~", "auto", { ...rules, ask: ["Bash(rm:*)"] }, "Bash", cwd).decision).toBe("ask");
  });

  test("relative removals resolve where the shell is now, and wherever the command's own cd may take it", () => {
    const rules: Rules = { allow: ["Bash(rm:*)"], ask: [], deny: [] };
    const root = join(base, "work", "app");
    const verdict = (command: string, cwd = root) => evaluate(command, "auto", rules, "Bash", { root, cwd }).decision;
    for (const command of ["cd / && rm -rf usr", "cd /; rm -rf etc", "cd / && rm -rf *", "(cd / && rm -rf usr)", "cd -P / && rm -rf usr", "pushd / && rm -rf usr",
      "cd ~ && rm -rf .", "cd && rm -rf .", "cd .. && rm -rf app", "cd /usr && rm -rf ../etc", "bash -c 'cd / && rm -rf usr'", "cd / && bash -c 'rm -rf usr'",
      "env -C / rm -rf usr", "sudo -D / rm -rf usr", "false && cd / ; rm -rf usr", "cd $HOME && rm -rf ."]) {
      expect([command, verdict(command)]).toEqual([command, "deny"]);
    }
    // Somewhere not written out: any relative target may be critical there.
    for (const command of ['cd "$DIR" && rm -rf build', "cd - && rm -rf build", "cd $(mktemp -d) && rm -rf x", "popd && rm -rf build", "cd ~other && rm -rf x", "cd * && rm -rf x"]) {
      expect([command, verdict(command)]).toEqual([command, "deny"]);
    }
    expect(evaluate('cd "$DIR" && rm -rf build', "default", rules, "Bash", { root, cwd: root }).decision).toBe("ask");
    // Absolute targets don't depend on it, and a cd that stays clear of critical paths is fine.
    for (const command of ['cd "$DIR" && rm -rf /tmp/x/build', "cd build && rm -rf out", "cd /tmp/x && rm -rf build", "rm -rf build && cd /"]) {
      expect([command, verdict(command)]).toEqual([command, "none"]);
    }
    // The shell's own directory: relative to it, and it and its parents are critical too.
    expect(verdict("rm -rf usr", "/")).toBe("deny");
    expect(verdict("rm -rf .", "/tmp/x/y")).toBe("deny");
    expect(verdict("rm -rf ..", join(root, "src"))).toBe("deny");
    expect(verdict("rm -rf build", "/tmp/x/y")).toBe("allow");
  });

  test("deny rules can name a wrapper", () => {
    put(join(project, ".claude", "settings.json"), { permissions: { deny: ["Bash(sudo:*)", "Bash(command -v *)"] } });
    expect(claude("sudo -u root ls")[0]).toBe("deny");
    expect(claude("command -v ls")[0]).toBe("deny");
    expect(claude("command ls")[0]).toBe("none");
  });

  test("a command the lexer can't split is denied while deny rules exist, else asked about", () => {
    expect(claude("$'\\x72m' -rf x")).toEqual(["deny", "cc-remote could not split this command into simple commands to check it against your deny rules"]);
    const lenient: Rules = { allow: [], ask: ["Bash(git push *)"], deny: [] };
    expect(decide("printf 'unterminated", "default", lenient)).toBe("ask");
    expect(decide("printf 'unterminated", "default", { allow: ["Bash(printf:*)"], ask: [], deny: [] })).toBe("none");
  });

  test("rule changes apply as soon as a file changes, and unchanged files are not read again", () => {
    expect(claude("make lint")[0]).toBe("none");
    const before = rulesFor(project, "Bash");
    expect(rulesFor(project, "Bash")).toBe(before);
    put(join(project, ".claude", "settings.local.json"), { permissions: { allow: ["Bash(make lint)"] } });
    expect(claude("make lint")[0]).toBe("allow");
    expect(rulesFor(project, "Bash")).not.toBe(before);
  });

  test("managed settings come first, with drop-ins in name order, and can allow only their own rules", () => {
    put(join(managed, "managed-settings.json"), { permissions: { deny: ["Bash(curl:*)"] } });
    put(join(managed, "managed-settings.d", "20-b.json"), { permissions: { ask: ["Bash(wget:*)"] } });
    put(join(managed, "managed-settings.d", "10-a.json"), { permissions: { deny: ["Bash(scp:*)"] } });
    put(join(managed, "managed-settings.d", ".hidden.json"), { permissions: { deny: ["Bash(ls:*)"] } });
    put(join(managed, "managed-settings.d", "notes.txt"), { permissions: { deny: ["Bash(ls:*)"] } });
    expect(rulesFor(project, "Bash")).toEqual({ allow: ["Bash(npm test:*)", "Bash(git status)"], ask: ["Bash(wget:*)", "Bash(git push *)"], deny: ["Bash(curl:*)", "Bash(scp:*)", "Bash(rm:*)"] });
    put(join(managed, "managed-settings.json"), { allowManagedPermissionRulesOnly: true, permissions: { allow: ["Bash(make:*)"] } });
    // The others' deny rules are kept: stricter than Claude, never looser.
    expect(rulesFor(project, "Bash")).toEqual({ allow: ["Bash(make:*)"], ask: ["Bash(wget:*)"], deny: ["Bash(scp:*)", "Bash(rm:*)"] });
  });

  test("broken settings files are skipped, and tool-name globs in deny rules cover Bash", () => {
    put(join(project, ".claude", "settings.json"), "{ not json");
    expect(claude("rm x")[0]).toBe("deny");
    put(join(config, "settings.json"), { permissions: { deny: ["*"], allow: ["*"] } });
    expect(claude("ls")[0]).toBe("deny");
    expect(rulesFor(project, "Bash").allow).toEqual([]);
  });

  test("PowerShell rules ignore case and apply only to commands they can read", () => {
    const rules: Rules = { allow: ["PowerShell(Get-ChildItem *)"], ask: [], deny: ["PowerShell(Remove-Item *)"] };
    expect(decide("remove-item C:\\work\\x", "default", rules, "PowerShell")).toBe("deny");
    expect(decide("C:\\tools\\Remove-Item x", "default", rules, "PowerShell")).toBe("deny");
    expect(decide("get-childitem C:\\work", "default", rules, "PowerShell")).toBe("allow");
    // Not plain: left to the user, who sees the command.
    expect(decide("Get-ChildItem | Remove-Item", "bypassPermissions", rules, "PowerShell")).toBe("ask");
    expect(decide("Get-ChildItem | Select-Object Name", "default", { ...rules, deny: [] }, "PowerShell")).toBe("none");
  });
});

describe("shell policy", () => {
  // remote-harness's lexical cases, against a deny rule for the command `codex`.
  const rules: Rules = { allow: [], ask: [], deny: ["Bash(codex:*)"] };
  const agent = "/opt/agents/codex";
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const verdict = (command: string) => decide(command, "default", rules);

  test("quoted arguments, comments and ANSI-C data are not commands", () => {
    for (const command of [
      "printf '%s\\n' 'claude --help' \"codex exec demo\" 'text; opencode run' # codex\n",
      String.raw`printf '%s\n' $'it\'s' $'back\\slash' $'\"quote\"' $'$(codex); ` + "`opencode`' " + String.raw`$'line\nnext\tend'`,
      String.raw`printf $'\033[1mbold\033[0m'`, String.raw`echo $'\x1b[31m'`, String.raw`sort -t $'\0'`,
      String.raw`value=$'\u00e9\0ignored'; printf '%s' "$value"`, String.raw`printf value >$'\x64ata'; cat data`,
      String.raw`printf '%s' $'\x1b'$(printf nested)$'\033[0m'`, String.raw`printf '%s' "$(printf '%s' $'\033nested')"`,
      String.raw`env -u $'\x58' printf '%s' $'\x1b'`, String.raw`exec -a $'\x6eame' printf '%s' $'\x1b'`,
      String.raw`$(printf '%s' $'\x70')rintf '%s' nested`, String.raw`printf '%s' $'\q; $(codex)'`,
      "sh -c 'codex exec example'",
    ]) expect(verdict(command)).toBe("none");
  });

  test("ANSI-C quoted names and encoded command words are denied", () => {
    for (const command of ["$'codex'", "co$'dex'", "command $'co'dex", `$'${agent}'`]) expect(verdict(command)).toBe("deny");
    for (const command of [String.raw`$'\x63odex'`, String.raw`$'\143odex'`, String.raw`$'co\u0064ex'`, String.raw`$'co\U00000064ex'`,
      String.raw`$'co\cDex'`, String.raw`co$'\0X='dex`, String.raw`$'\x63'$(printf '')odex`, String.raw`env $'\055u' X true`,
      String.raw`exec $'\x63odex'`, String.raw`sudo -u user $'\x63odex'`, String.raw`exec -a name $'\x63odex'`,
      String.raw`sudo --user user $'\x63odex'`, String.raw`env -u $'\x58' $'\x63odex'`]) {
      expect(evaluate(command, "default", rules).reason).toContain("could not split");
    }
  });

  test("ANSI-C data does not hide the commands after it", () => {
    for (const prefix of [String.raw`printf '%s' $'\033[0m'; `, String.raw`value=$'\0ignored' `, String.raw`printf value >$'\x64ata'; `,
      String.raw`sudo -u $'env' `, String.raw`env -u $'\x58' `]) {
      expect(verdict(prefix + q(agent))).toBe("deny");
    }
    expect(verdict(String.raw`printf '%s' $'\033'"$(` + q(agent) + ')"')).toBe("deny");
  });

  test("here-documents: text is data, substitutions in unquoted ones are commands", () => {
    const body = "can't do this\nclaude -p example\ncodex exec example\nopencode run\n";
    expect(verdict(`cat <<'EOF'\n${body}EOF\n`)).toBe("none");
    expect(verdict(`cat <<'EOF'\ncan't run this\nEOF\n${q(agent)}`)).toBe("deny");
    expect(verdict("cat <<'ONE' <<-\"TWO\"; printf suffix\nfirst document's text\nONE\n\tcan't run codex\n\tTWO\n")).toBe("none");
    expect(verdict("cat <<EOF\ncodex exec example\nEOF\n")).toBe("none");
    expect(verdict(`cat <<EOF\n$(${q(agent)})\nEOF\n`)).toBe("deny");
    expect(verdict(`cat <<\\EOF\n$(${agent})\nEOF\n`)).toBe("none");
    expect(verdict(`x=$(cat <<EOF\ncodex exec example\nEOF\n)`)).toBe("none");
    expect(simpleCommands(`cat <<EOF\n$(ls)\nEOF\n`).map((c) => c.words)).toEqual([["cat"], ["ls"]]);
  });

  test("direct, quoted, by path, wrapped and separated commands are denied", () => {
    for (const command of ["codex -p example", "env TEST=1 codex run", `${q(agent)} exec example`, `"${agent}" exec example`,
      `command -- ${q(agent)}`, `sudo -u someone ${q(agent)}`, `printf safe; ${q(agent)}`, `printf safe\n${q(agent)}`,
      `2>/dev/null ${q(agent)}`, `printf "%s" "$(${q(agent)})"`, `printf "%s" \`${q(agent)}\``, `cat <(${q(agent)})`,
      `(cd /tmp && codex)`, `if true; then codex; fi`, `for f in a; do codex "$f"; done`, `true || { codex; }`]) {
      expect(verdict(command)).toBe("deny");
    }
  });

  test("arithmetic is data, but the commands nested in it are not", () => {
    expect(verdict('codex=2; printf "%s|%s" "$((1 + 2))" "$((codex + 1))"')).toBe("none");
    expect(verdict("codex=2; cat <<EOF\n$((codex + 1))\nEOF\n")).toBe("none");
    expect(verdict(`printf "%s" "$((1 + $(${q(agent)})))"`)).toBe("deny");
  });
});

describe("guard and hook", () => {
  test("refuses only what a deny rule covers", () => {
    expect(refusal("rm -rf build", project, "Bash")).toContain("Bash(rm:*)");
    expect(refusal("git push origin main", project, "Bash")).toBeUndefined();
    expect(refusal("ls", project, "Bash")).toBeUndefined();
  });

  test("the PreToolUse hook answers with the rules' decision in the session's mode", async () => {
    const { matcher, hooks } = rulesHook(project, "Bash", "mcp__cc__Bash");
    expect(matcher).toBe("mcp__cc__Bash");
    const ask = (command: string, permission_mode?: string) => hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: "mcp__cc__Bash", tool_input: { command }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: project, permission_mode },
      "t", { signal: new AbortController().signal });
    const decision = async (command: string, mode?: string) => ((await ask(command, mode)) as { hookSpecificOutput?: { permissionDecision: string } }).hookSpecificOutput?.permissionDecision;
    expect(await decision("rm x", "bypassPermissions")).toBe("deny");
    expect(await decision("git push", "bypassPermissions")).toBe("ask");
    expect(await decision("npm test", "dontAsk")).toBe("allow");
    expect(await decision("npm test", "auto")).toBe("allow");
    expect(await decision("npm test", "plan")).toBeUndefined();
    expect(await ask("make", "default")).toEqual({});
    expect(await decision("git status", "plan")).toBe("allow");
  });
});

describe("persistAllowRule", () => {
  const local = () => join(project, ".claude", "settings.local.json");

  test("adds the rule once, keeps the rest of the file, and the rules see it", () => {
    put(local(), { permissions: { ask: ["Bash(git push *)"], allow: ["WebFetch(domain:x)"] }, model: "opus", enabledMcpjsonServers: ["a"] });
    expect(claude("make build")[0]).toBe("none");
    expect(persistAllowRule(project, "make build:*", "Bash")).toBe("Bash(make build:*)");
    persistAllowRule(project, "make build:*", "Bash");
    expect(JSON.parse(readFileSync(local(), "utf8"))).toEqual({
      permissions: { ask: ["Bash(git push *)"], allow: ["WebFetch(domain:x)", "Bash(make build:*)"] }, model: "opus", enabledMcpjsonServers: ["a"],
    });
    expect(readdirSync(join(project, ".claude"))).toEqual(["settings.local.json"]);
    expect(claude("make build -j8")[0]).toBe("allow");
  });

  test("creates the file and its directory", () => {
    rmSync(join(project, ".claude"), { recursive: true });
    persistAllowRule(project, "npm run lint:*", "Bash");
    expect(JSON.parse(readFileSync(local(), "utf8"))).toEqual({ permissions: { allow: ["Bash(npm run lint:*)"] } });
  });

  test("leaves a file it can't understand alone", () => {
    for (const content of ["{ broken", "[1, 2]", '{"permissions": {"allow": "Bash"}}']) {
      put(local(), content);
      expect(() => persistAllowRule(project, "ls:*", "Bash")).toThrow();
      expect(readFileSync(local(), "utf8")).toBe(content);
    }
  });

  test("writes through a symlinked settings file", () => {
    const target = join(base, `dotfiles-${n}.json`);
    put(target, { permissions: {} });
    rmSync(local());
    symlinkSync(target, local());
    persistAllowRule(project, "ls:*", "Bash");
    expect(lstatSync(local()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

describe("local settings in a git repository", () => {
  // git reads only these temporary files: no real global config, excludes or system config.
  const GIT_ENV = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
  let savedGit: Record<string, string | undefined>;
  let home = "";
  let repo = "";
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env: process.env, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const allow = (file: string) => JSON.parse(readFileSync(file, "utf8")).permissions.allow;

  beforeEach(() => {
    savedGit = Object.fromEntries(GIT_ENV.map((k) => [k, process.env[k]]));
    home = join(base, `home-${n}`);
    mkdirSync(home, { recursive: true });
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
    delete process.env.XDG_CONFIG_HOME;
    repo = join(base, `repo-${n}`);
    mkdirSync(join(repo, "app", "src"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    resetLocalSettings();
  });
  afterEach(() => {
    for (const k of GIT_ENV) {
      if (savedGit[k] === undefined) delete process.env[k];
      else process.env[k] = savedGit[k];
    }
    resetLocalSettings();
  });

  test("a session in a subdirectory reads and writes the repository root's file, and still reads its own", () => {
    const root = join(repo, "app");
    put(join(root, ".claude", "settings.local.json"), { permissions: { deny: ["Bash(curl:*)"] } });
    put(join(repo, ".claude", "settings.local.json"), { permissions: { ask: ["Bash(git push *)"] } });
    expect(localSettingsDir(root)).toBe(realpathSync(repo));
    expect(rulesFor(root, "Bash").deny).toContain("Bash(curl:*)");
    expect(rulesFor(root, "Bash").ask).toContain("Bash(git push *)");
    persistAllowRule(root, "make:*", "Bash");
    expect(allow(join(repo, ".claude", "settings.local.json"))).toEqual(["Bash(make:*)"]);
    expect(JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")).permissions.allow).toBeUndefined();
    expect(evaluate("make all", "default", rulesFor(root, "Bash")).decision).toBe("allow");
    // The shared project settings stay the session root's.
    put(join(repo, ".claude", "settings.json"), { permissions: { deny: ["Bash(make:*)"] } });
    expect(evaluate("make all", "default", rulesFor(root, "Bash")).decision).toBe("allow");
  });

  test("a worktree uses the main checkout's root", () => {
    git(repo, "worktree", "add", "-q", join(base, `wt-${n}`));
    const root = join(base, `wt-${n}`, "app");
    mkdirSync(root, { recursive: true });
    persistAllowRule(root, "npm test:*", "Bash");
    expect(allow(join(repo, ".claude", "settings.local.json"))).toEqual(["Bash(npm test:*)"]);
  });

  test("outside a repository, or when the repository is the home directory, the file stays in the session root", () => {
    expect(localSettingsDir(project)).toBe(project);
    process.env.HOME = repo;
    resetLocalSettings();
    expect(localSettingsDir(join(repo, "app"))).toBe(join(repo, "app"));
  });

  test("the first write adds the global excludes entry once, to git's default file", () => {
    persistAllowRule(join(repo, "app"), "ls:*", "Bash");
    const excludes = join(home, ".config", "git", "ignore");
    expect(readFileSync(excludes, "utf8")).toBe(`${IGNORE_PATTERN}\n`);
    persistAllowRule(join(repo, "app"), "pwd:*", "Bash");
    expect(readFileSync(excludes, "utf8")).toBe(`${IGNORE_PATTERN}\n`);
    // git now ignores it.
    expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, env: process.env }).stdout.toString()).toBe("");
  });

  test("the excludes file is core.excludesFile when absolute or under ~, else XDG_CONFIG_HOME's", () => {
    writeFileSync(join(home, "gitconfig"), "[core]\n\texcludesFile = ~/my-ignore\n");
    expect(globalExcludesFile(repo)).toBe(join(home, "my-ignore"));
    writeFileSync(join(home, "my-ignore"), "*.log");
    persistAllowRule(join(repo, "app"), "ls:*", "Bash");
    expect(readFileSync(join(home, "my-ignore"), "utf8")).toBe(`*.log\n${IGNORE_PATTERN}\n`);
    writeFileSync(join(home, "gitconfig"), "[core]\n\texcludesFile = relative-ignore\n");
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    expect(globalExcludesFile(repo)).toBe(join(home, "xdg", "git", "ignore"));
  });

  test("a file the repository already ignores, or one outside a repository, leaves the excludes alone", () => {
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    persistAllowRule(repo, "ls:*", "Bash");
    persistAllowRule(project, "ls:*", "Bash");
    expect(existsSync(join(home, ".config", "git", "ignore"))).toBe(false);
  });

  test("a local file git tracks is not written: the grant stays with the session", () => {
    put(join(repo, ".claude", "settings.local.json"), { permissions: { allow: [] } });
    git(repo, "add", "-f", ".claude/settings.local.json");
    expect(() => persistAllowRule(join(repo, "app"), "ls:*", "Bash")).toThrow(TrackedSettingsError);
    expect(allow(join(repo, ".claude", "settings.local.json"))).toEqual([]);
  });

  test("project and user destinations write those files", () => {
    persistAllowRule(join(repo, "app"), "make:*", "Bash", "projectSettings");
    expect(allow(join(repo, "app", ".claude", "settings.json"))).toEqual(["Bash(make:*)"]);
    persistAllowRule(join(repo, "app"), "make:*", "Bash", "userSettings");
    expect(allow(join(config, "settings.json"))).toContain("Bash(make:*)");
  });
});
