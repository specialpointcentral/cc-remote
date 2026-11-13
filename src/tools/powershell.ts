import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Launch, MAX_OUTPUT, shellTool, TMP } from "./shell";

/** PowerShell 7 when it's installed, else the Windows PowerShell 5.1 every Windows has. */
const pwsh = Bun.which("pwsh");
const exe = pwsh ?? "powershell.exe";
let scripts = 0;

/**
 * The command goes in a script file, which sidesteps command-line quoting and length limits; the
 * script deletes itself once PowerShell has read it. UTF-8 output, so native commands decode
 * cleanly. The finally block records where the command left us, as long as that's a directory.
 */
const script = (command: string) => `Remove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding } catch {}
$global:LASTEXITCODE = 0
try {
${command}
} finally {
  if ($env:__CC_REMOTE_PWD -and (Get-Location).Provider.Name -eq 'FileSystem') {
    [IO.File]::WriteAllText($env:__CC_REMOTE_PWD, (Get-Location).ProviderPath)
  }
}
exit $LASTEXITCODE
`;

/** PowerShell parses the whole file before running it, so a syntax error keeps it from deleting itself; done removes it then. */
function launch(command: string): Launch {
  const file = join(TMP, `cc-remote-ps-${process.pid}-${++scripts}.ps1`);
  // Windows PowerShell reads a script without a BOM as the ANSI code page.
  writeFileSync(file, `﻿${script(command)}`);
  return {
    argv: [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    done: () => { try { rmSync(file, { force: true }); } catch {} },
  };
}

const chaining = pwsh
  ? "Chain dependent commands with && (PowerShell 7); make independent calls in parallel in one response"
  : "This is Windows PowerShell 5.1: there is no && or ||. Chain dependent commands with `; if ($?) { ... }`; make independent calls in parallel in one response";

export const powershell = shellTool({
  name: "PowerShell",
  description: `Executes a PowerShell command on the user's local Windows machine (${pwsh ? "PowerShell 7, pwsh" : "Windows PowerShell 5.1"}) and returns its combined output.

- The working directory persists between commands (Set-Location carries over); variables and functions do not
- Prefer absolute paths so you don't depend on the current directory
- Default timeout is 120000ms (2 minutes); max is 600000ms (10 minutes)
- Output over ${MAX_OUTPUT} characters is truncated
- The command gets no stdin; avoid interactive commands and prompts
- Set run_in_background for long-running processes such as dev servers. You get back an ID and an output file to Read; the process stops when the session ends
- Prefer Read, Edit, Write, Glob and Grep over Get-Content, Set-Content, Get-ChildItem and Select-String for file work
- ${chaining}`,
  launch,
  stopHint: (pid) => `taskkill /PID ${pid} /T /F`,
});
