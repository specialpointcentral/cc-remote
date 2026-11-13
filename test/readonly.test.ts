import { describe, expect, test } from "bun:test";
import { evaluate, type Rules } from "../src/rules";
import { type Place, plainCommands, readOnly } from "../src/readonly";

const place: Place = { root: "/work/app", dirs: ["/work/lib"] };
const ro = (command: string, where = place) => readOnly(command, where);

describe("read-only commands", () => {
  test("plain reads, pipelines and lists of them", () => {
    for (const command of [
      "ls", "ls -la src", "ls *.ts", "cat package.json", "head -n 20 src/main.ts", "tail -f log.txt", "wc -l src/*.ts", "pwd", "echo hello world",
      "which -a node", "file README.md", "stat -c %s a", "du -sh .", "df -h", "tree -L 2 src", "rg -n 'useState(' src", "grep -rn \"a|b\" .",
      "find . -name '*.ts' -type f", "realpath ../x", "git status", "git status --short", "git log --oneline -5", "git diff HEAD~1 -- src",
      "git show HEAD:package.json", "git rev-parse --show-toplevel", "git branch", "git branch -a -vv", "git branch --show-current",
      "git branch --list 'feat/*'", "git branch --contains HEAD", "git remote -v", "git remote get-url origin", "git ls-files src",
      "git blame -L 1,5 a.ts", "git config --get user.name", "git config list", "git stash list", "git worktree list", "git -P log -1",
      "cat a | grep b | wc -l", "git status && git log -1", "ls; pwd", "ls x || ls", "sort a | uniq -c | sort -rn", "cut -d, -f1 a.csv",
      "ls 2>/dev/null", "rg x . 2>&1 | head", "cat < input.txt", "grep x a >/dev/null", "uniq a.txt",
      "git grep -n x", "git log --oneline --stat", "git diff --output-indicator-new=+", "sort -rn a", "rg --pre-glob '*.gz' x", "tree -a",
    ]) {
      expect([command, ro(command)]).toEqual([command, true]);
    }
  });

  test("anything that may write, run something else, or hide a command", () => {
    for (const command of [
      "ls > out.txt", "cat a >> b", "echo x | tee out", "ls &>log", "cat a >| b", "grep x a 2>err.log", "cat <<EOF\nx\nEOF", "diff <(ls a) <(ls b)",
      "echo $HOME", "echo \"$(rm -rf x)\"", "echo `id`", "ls $(pwd)", "(ls)", "{ ls; }", "ls &", "ls # comment", "! ls", "ls\nrm x",
      "find . -delete", "find . -name x -exec rm {} \\;", "find . -fprint out", "find . -execdir ls \\;", "find *.ts", "sort -o out a", "sort --output=out a",
      "uniq a out", "tree -o out.txt", "file -C -m magic", "rg --pre ./script x", "which --read-alias ls", "git log --output=log.txt", "git diff --ext-diff",
      "sort --o=out a", "sort --outp=out a", "sort -ro out a", "sort --comp=sh a", "git grep -O x", "git grep -iOsh x", "git grep -nOtouch x",
      "git grep --open=sh x", "git grep --open-files-in-pager x", "git log --outp=f", "git diff --ext", "git show --ext-d", "tree --out=f", "file --comp",
      "file -zC", "rg --pre=sh x", "cat < /dev/tcp/example.com/80", "wc -l </dev/udp/1.2.3.4/53",
      "git -c core.pager=sh log", "git -C /tmp status", "git branch new-feature", "git branch -d old", "git branch -m a b", "git remote add o url",
      "git remote show origin", "git config user.name x", "git config --unset user.name", "git stash", "git stash pop", "git reflog expire --all",
      "git grep -O x", "git commit -m x", "git push", "git checkout main", "FOO=1 ls", "sudo cat /etc/shadow", "env ls", "xargs cat",
      "rm -rf x", "mv a b", "npm test", "sed -n 1p a", "ls &&", "&& ls", "ls ;;", "ls | ", "", "cat 'unclosed", "echo \"unclosed",
      "/bin/ls", "./ls", "l* -la",
    ]) {
      expect([command, ro(command)]).toEqual([command, false]);
    }
  });

  test("cd only into the working directories, and no git after it changes directory", () => {
    expect(ro("cd src && ls")).toBe(true);
    expect(ro("cd /work/lib && cat x")).toBe(true);
    expect(ro("cd /work/app && git status")).toBe(true);
    expect(ro("cd src && git status")).toBe(false);
    expect(ro("cd /tmp && ls")).toBe(false);
    expect(ro("cd .. && ls")).toBe(false);
    expect(ro("cd && ls")).toBe(false);
    expect(ro("cd - && ls")).toBe(false);
    // From where the shell is now.
    expect(ro("cd .. && ls", { ...place, cwd: "/work/app/src" })).toBe(true);
    expect(ro("cd sub && ls", { ...place, cwd: "/tmp" })).toBe(false);
  });

  test("splits on operators outside quotes only, and keeps quoted text whole", () => {
    expect(plainCommands("grep 'a | b; c' x | wc -l")?.map((c) => c.map((w) => w.text))).toEqual([["grep", "a | b; c", "x"], ["wc", "-l"]]);
    expect(plainCommands("ls \"*.ts\"")?.[0]?.[1]).toEqual({ text: "*.ts", glob: false });
    expect(plainCommands("ls *.ts")?.[0]?.[1]).toEqual({ text: "*.ts", glob: true });
    expect(plainCommands("echo a\\ b")?.[0]?.[1]?.text).toBe("a b");
  });

  test("approved in the default, acceptEdits, plan and dontAsk modes, after deny, ask and critical-path checks", () => {
    const rules: Rules = { allow: [], ask: ["Bash(git log *)"], deny: ["Bash(cat .env*)"] };
    const decide = (command: string, mode: string) => evaluate(command, mode, rules, "Bash", place);
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk"]) {
      expect(decide("ls -la", mode)).toEqual({ decision: "allow", reason: "a read-only command, which Claude Code runs without asking" });
    }
    // Auto mode leaves them to the classifier; bypass runs everything anyway.
    expect(decide("ls -la", "auto").decision).toBe("none");
    expect(decide("ls -la", "bypassPermissions").decision).toBe("none");
    expect(decide("git log -1", "default").decision).toBe("ask");
    expect(decide("cat .env.local", "plan").decision).toBe("deny");
    // Only with a place to read cd against, and never for PowerShell.
    expect(evaluate("ls", "default", rules, "Bash").decision).toBe("none");
    expect(evaluate("ls", "default", rules, "PowerShell", place).decision).toBe("none");
  });
});
