# cc-remote

English | [简体中文](README.zh-CN.md)

**Use Claude Code on your laptop without installing or logging into it there.**

cc-remote runs Claude Code on a server you can reach over ssh, and runs every tool it calls
on your own machine. The model, your login and your subscription stay on the server. Your
code, your shell, your toolchain and your editor stay with you.

It's an [ACP](https://agentclientprotocol.com) agent, so it plugs straight into
[acpc](https://github.com/AkaraChen/acpc) in the terminal, Zed, paseo and any other ACP client. To your editor it looks exactly like Claude Code.
It can also stand in for the `claude` executable of apps that embed the Claude Agent SDK, such as
[Orca](#orca).

```
  your machine                                   server
 ┌───────────────────────────────┐   ssh    ┌─────────────────────────┐
 │ Zed / paseo / any ACP client  │          │ claude (logged in)      │
 │        ⇅                      │ ───────► │  model, prompts,        │
 │ cc-remote                     │ ◄─────── │  web search, subagents, │
 │  Read · Write · Edit · Bash   │          │  skills, its own MCP    │
 │  Glob · Grep · your MCP       │          │                         │
 └───────────────────────────────┘          └─────────────────────────┘
```

## Why

- **Your Claude login lives somewhere else.** A dev box, a work server, a machine in a
  region where Claude is available. Log in once there and use it from every computer you own.
- **Your code stays local.** Unlike ssh-ing into the server and running `claude` there, the
  files being edited and the commands being run are the ones on your machine, with your
  dependencies, your git config and your build tools.
- **Your local MCP servers come along.** The ones your editor passes and the ones in your local
  Claude Code config run on your machine, OAuth logins included.
- **Nothing to set up on the server.** No daemon, no port, no agent to install. If `ssh <your-server>
  claude --version` works, cc-remote works.
- **One binary locally, on macOS, Linux and Windows.** No `claude` install and no Claude login
  on your machine.
- **It's real Claude Code.** cc-remote is
  [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), the ACP adapter
  for Claude Code, with one change: the `claude` it starts runs on the server. Sessions,
  permission prompts, modes, models, forks and diffs all work the way they do in
  claude-agent-acp.

## What runs where

| Runs on your machine | Runs on the server |
|---|---|
| Read, Write, Edit, NotebookEdit, Bash (PowerShell on Windows), Glob, Grep | The model, the system prompt, the session |
| The MCP servers your ACP client brings, and those in your local Claude Code config | Web search, subagents, skills |
| Your `CLAUDE.md` files, git status, environment | The server's own settings and MCP servers |

## Requirements

Throughout this README, `<your-server>` stands for your server: replace it with anything `ssh`
accepts, such as a hostname, `user@host`, or a `Host` alias from `~/.ssh/config`.

Before you start, have these two in place:

- **ssh to the server works.** `ssh <your-server>` logs you in without a password prompt (use a key, and
  put ports, users and jump hosts in `~/.ssh/config`).
- **`claude` on the server is logged in.** Claude Code 2.1.268 or later, with a POSIX login shell.
  Run `claude` there once and log in, or use `cc-remote --cli auth login` after installing.

On your machine you need [Bun](https://bun.sh) to build cc-remote. The binary it builds has no
dependencies. It runs on macOS, Linux and Windows; on Windows it also needs the OpenSSH client
that ships with Windows 10 and later.

## Install

```sh
git clone https://github.com/AkaraChen/cc-remote && cd cc-remote
bun install
bun run compile    # builds the binary for this machine into dist/cc-remote
bun link           # puts cc-remote on your PATH, in ~/.bun/bin
```

`bun run compile` picks the `build:<os>-<arch>` script for the machine you run it on. To build
every platform at once (linux-x64, linux-arm64, darwin-arm64, windows-x64, windows-arm64), run
`bun run build`; the binaries land in `dist/`.

Tell it which host to use, then check the connection:

```sh
mkdir -p ~/.config/cc-remote && echo <your-server> > ~/.config/cc-remote/host
cc-remote doctor
```

cc-remote looks for the host in this order: `--host`, then `$CC_REMOTE_HOST`, then
`~/.config/cc-remote/host`. The host can be anything `ssh` accepts. Ports, keys and jump hosts
go in `~/.ssh/config`.

If you need a different ssh command, set `CC_REMOTE_SSH`. It works like rsync's `RSYNC_RSH`:

```sh
export CC_REMOTE_SSH="ssh -p 2222 -i ~/.ssh/id_ed25519"
```

If the server isn't logged in yet, run `cc-remote --cli auth login`.

## Use

Once cc-remote is installed, it works with any client that speaks ACP. Add an agent whose command
is `cc-remote --host <your-server>` (or just `cc-remote`, if you wrote the host file above).

**acpc**, in the terminal. [acpc](https://github.com/AkaraChen/acpc) gives any ACP agent the
Codex terminal UI. Install it, add cc-remote as an agent, and start a session:

```sh
curl -fsSL https://raw.githubusercontent.com/AkaraChen/acpc/main/install.sh | sh
acpc add --slug cc-remote --name "Claude (remote)" cc-remote --host <your-server>
acpc -a cc-remote
```

Pass `--default` to `acpc add` to make it the agent plain `acpc` starts. In acpc, `/model` and
Shift+Tab switch Claude's models and modes, `/resume` reopens sessions, and `/agent` can move a
conversation between cc-remote and your other agents.

**Zed**, in `settings.json`:

```json
"agent_servers": {
  "Claude (remote)": { "command": "cc-remote", "args": ["--host", "<your-server>"] }
}
```

**paseo**, in `~/.paseo/config.json` under `agents.providers`:

```json
"claude-remote": {
  "extends": "acp",
  "label": "Claude (remote)",
  "command": ["cc-remote", "--host", "<your-server>"]
}
```

For paseo there is also a plugin in [`paseo-plugin/`](paseo-plugin). Install it instead of editing
the config: it adds a "Claude (remote)" provider and a settings screen for the host, the ssh
command and the executable path (Settings → Plugins → cc-remote). The "Check" button there runs
`cc-remote doctor`.

```sh
paseo plugin install github:AkaraChen/cc-remote:paseo-plugin
```

### Orca

[Orca](https://github.com/stablyai/orca) can't add ACP agents, but its Claude chats run whatever
executable its **Claude Command** names, and talk to it the way the Claude Agent SDK talks to
`claude`. `cc-remote claude` stands in for that executable: the model runs on your server, and
Read, Write, Edit, Bash, Glob and Grep run in the chat's folder on the machine where Orca Server
runs. With several project machines, each one runs Orca Server and cc-remote, and all of them share
one server with a logged-in `claude`.

On each project machine (where Orca Server runs and your files are):

1. Install cc-remote, write the host file and run `cc-remote doctor`, as in [Install](#install).
   Orca Server doesn't read your shell profile, so use the host file rather than `$CC_REMOTE_HOST`.
2. Set Orca's Claude Command (in the Claude agent's settings) to the full path of cc-remote,
   followed by `claude`:

   ```
   /home/me/.bun/bin/cc-remote claude
   ```

   `command -v cc-remote` prints the path. To pick the server here instead of in the host file,
   put `--host <your-server>` before `claude`. If you need `CC_REMOTE_SSH`, add it to the Claude
   agent's environment variables in Orca.
3. Open a new Claude chat. Approvals, tool cards and diffs look the same as with a local Claude.

Orca's default permission mode for new chats is full-access, where Bash runs on the project machine
without asking. Consider switching the default to auto in Orca's settings. Even in full-access,
deny rules from your settings still refuse and ask rules still show a card. Orca offers "Allow for
this session" but no "always allow"; put lasting approvals in `.claude/settings.local.json`. Orca
restarts claude when you change a chat's mode or model; the chat's session approvals carry over.

Each chat's transcript is mirrored to `~/.claude/projects/` on the project machine, where Orca reads
it, so history, follow-ups and resuming a chat after Orca Server restarts work. Orca's built-in
chat plugin (inline visuals) is copied to the server, under `~/.cc-remote/plugins/`, the first time a
chat needs it. For an app that only takes a path with no arguments, a link named `claude` that
points at the cc-remote binary works like `cc-remote claude`. Keep the link off your `PATH`, so it
doesn't shadow a local `claude`.

Limits with Orca, on top of the [general ones](#limits):

- Chats always use the server's Claude login. Orca's account switching doesn't change that, so use
  Orca's system account; with a managed account, transcripts go to that account's folder, but the
  login is still the server's.
- Orca's one-off `claude -p` calls, such as naming a chat, run on the server with no tools.
- Claude in Orca's terminal panes uses the same command, and cc-remote refuses it: an interactive
  `claude` would work on the server's folder, not your project. Use Orca's chats, or acpc in the
  terminal.
- Orca's agent status hooks are installed in the project machine's Claude settings, which the
  server's `claude` doesn't read.

### Commands

```
cc-remote [--host <host>]                    speak ACP on stdio (what your client runs)
cc-remote [--host <host>] doctor             check ssh and the remote claude version
cc-remote [--host <host>] --cli <args...>    run `claude <args...>` on the server
cc-remote [--host <host>] claude <args...>   stand in for `claude` under an Agent SDK app, such as Orca
cc-remote --version | --help
```

## Behavior

**Permissions.** Permission requests go to your client, the same as with any ACP agent. Read, Glob
and Grep never ask. "Accept edits" approves Write, Edit and NotebookEdit inside the session's
directories, except Claude Code's protected paths (`.git`, `.claude`, shell startup files,
`.mcp.json`, …) and paths that leave the project through a symlink. In auto mode those same edits go
ahead without a round trip to the classifier; everything else is judged by Claude's auto-mode
classifier on the server, which sees the real command or file.

Your machine's settings decide about local shell commands: the `Bash(...)` rules in the managed
settings, `~/.claude/settings.json`, the project's `.claude/settings.json`, and
`.claude/settings.local.json` (at the repository root, as Claude Code keeps it). The server's
rules don't apply to them. A deny rule refuses the command before it runs, in every mode, bypass
included; an ask rule always asks, even in bypass (Orca's full-access); an allow rule approves a
plain single command in the default, accept-edits and don't-ask modes, and a narrow one in auto. A
command is split the way a shell would, so a rule also catches it behind `&&`, `|`, `$(…)` or
wrappers such as `sudo` and `env`. Removing `/`, a top-level directory, your home or the project
folder's parents (`rm`, `rmdir`) always asks, and in auto mode is refused; no rule approves it.
A relative path counts from where the shell is, also after a `cd` in the same command; after a `cd`
cc-remote can't follow (`cd "$DIR"`), every relative path counts as critical.

Read-only commands run without asking in the default, accept-edits, plan and don't-ask modes, as
Claude Code's own Bash runs them: `ls`, `cat`, `head`, `tail`, `wc`, `grep`/`rg`, `find` without
`-exec`, `-delete` or `-fprint`, `git status`, `log`, `diff`, `show`, `branch` and the like, also in
a pipeline or behind `&&`, with output only to `/dev/null`, and a `cd` only into the session's
directories. The list is narrower than Claude Code's; anything else asks as before. In auto mode the
classifier judges them.

When a Bash command asks, the approval it offers is for a command prefix (such as `npm test:*`)
rather than all of Bash. PowerShell commands on Windows work the same way. A command with `;`, `&`,
`|`, redirects, `$(…)`, backticks or newlines is never approved by a prefix. "Don't ask again"
writes `Bash(<prefix>:*)` to `.claude/settings.local.json` and, as Claude Code does, adds that file
to your global git excludes the first time; if the file is tracked by git, the approval lasts for the
session only. Approvals for the session are kept with the session, in a private file under
`~/.cache/cc-remote/grants/`, so a new claude for the same session (such as the one Orca starts when
you change a chat's mode or model) still has them; a file unused for three days is removed.
Subagents can't use `isolation: worktree`, since the worktree would be on the server.

**The server's own files.** claude keeps some files on the server and has the model use them:
plan mode's plan file (`~/.claude/plans/` there), the session's folder under `~/.claude/projects/`
there (auto memory, a tool result too large for the context that claude saved to a file, subagent
transcripts), subagent memory (`~/.claude/agent-memory/`) and background tasks' output. Read,
Write, Edit and Glob open these on the server over the same ssh connection, so plan mode works as
usual: the plan is written where ExitPlanMode reads it, and the approval shows it. As in Claude
Code, writing the plan and memory files doesn't ask.

**Shell.** Bash runs in your login shell's environment, so tools set up by your profile (conda, nvm,
`module`, …) are found even when an app such as Orca starts cc-remote. With bash or zsh,
cc-remote captures that environment once and shares it between sessions, refreshing it after ten
minutes or when a startup file changes; `CC_REMOTE_SHELL_SNAPSHOT=off` runs every command as a login
shell instead. A command that times out or is stopped gets SIGTERM, and SIGKILL five seconds later.

**Search.** With ripgrep installed, Glob honours your ignore files, as Grep does. Grep returns up to
250 results by default (`head_limit: 0` for all of them) and stops searching once it has enough.

**Sessions.** Each session is mirrored to `~/.claude/projects/` on your machine, in the same place
a local Claude Code would keep it. Your client can list, replay, load and fork sessions from there.
If you resume a session the server has never seen, such as a fork, cc-remote copies it to the
server first. On the server, each local directory gets its own working folder at
`~/.cc-remote/ws/<your hostname>/<local path>/`.

**Starting a session.** Before claude starts, one check on the server looks for what the session
needs: the transcript of a session being resumed, plugins the client passes, and the project's
`.claude/commands`, `.claude/skills` and `.claude/agents` (see [Limits](#limits)). When they are all
there, which is the usual case, the session starts on a single ssh channel. Otherwise cc-remote
uploads only what is missing and starts again. Nothing your client sends is lost or repeated in
between.

**The server's claude.** Each session checks that the server's claude is at least the version in
[Requirements](#requirements) and refuses to start otherwise. The version is remembered for ten
minutes, so the version probes some apps make before every chat cost no ssh round trip;
`cc-remote doctor` always asks the server. Agent teams are turned off, because teammates would run
on the server without your machine's tools. cc-remote also puts that in the settings claude starts
with, so the server's own settings can't turn them on, and drops an `--agent-teams` flag.
`claude auth status`, which claude-agent-acp asks several times as each session starts, is
remembered per server for a minute; `cc-remote --cli auth login` or `logout` forgets it.

**MCP servers.** Besides the servers your client passes, cc-remote starts the ones your local
Claude Code would: user servers from `~/.claude.json`, the ones added for this directory, and the
project's `.mcp.json` servers that you have approved (in `~/.claude/settings.json`,
`.claude/settings.local.json`, or by approving them in a local `claude`). They run on your
machine and reach claude the same way as your client's. When names clash, your client's server
wins over your local config's, and either one wins over a server of the same name on the host.
An http or sse server that needs OAuth offers an `authenticate` tool until you log in. Calling it
opens the login page in your local browser, takes the redirect on `localhost`, and then the
server's real tools appear. The tokens are kept in `~/.config/cc-remote/mcp-auth/`, separately
from Claude Code's.

**ssh.** By default all sessions share one connection (`ControlMaster`), kept open for an hour after
the last session (`CC_REMOTE_CONTROL_PERSIST`, any `ControlPersist` value). The stream is
compressed (`Compression=yes`), which helps on slow links. Every connection sends
`ServerAliveInterval=15` and gives up after five minutes of silence (`CC_REMOTE_KEEPALIVE_TIMEOUT`,
in seconds), so a short network drop doesn't end a chat and a dead link still fails instead of
hanging. If an `-o` with the same name comes earlier in `CC_REMOTE_SSH`, that one is used instead.
When the server refuses another session on the shared connection (sshd's `MaxSessions`, 10 by
default), that session retries on a connection of its own. Windows' OpenSSH can't share
connections, so there each session opens its own.

**Windows.** The shell tool is PowerShell instead of Bash, as in Claude Code on Windows. cc-remote
uses PowerShell 7 (`pwsh`) when it's on PATH, otherwise Windows PowerShell 5.1. Grep needs
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on PATH. On the server, a local directory
like `C:\Users\me\app` gets the working folder `~/.cc-remote/ws/<your hostname>/C/Users/me/app/`.

### Limits

- Of your project's `.claude/` directory, only `commands/`, `skills/` and `agents/` go to the server
  (copied into its working folder when they change; up to 1000 files, 1 MiB each, 8 MiB in all).
  Settings and hooks stay on your machine. The server's user-level settings, skills and MCP servers
  still apply.
- File checkpoints and rewind are recorded on the server, so they can't see your local edits.
- Bridged MCP servers from your client expose their tools only, not resources or prompts.
- LSP, Monitor and the worktree tools are turned off.
- Files claude keeps on the server for itself are reached by Read, Write, Edit and Glob only; Bash
  and Grep can't see them. The server's skills and plugins aren't reached this way: a skill that
  points at a file beside it finds your machine's copy, if any. A `plansDirectory` set in the
  server's settings isn't supported.

## How it works

The Claude Agent SDK talks to `claude` over its stdin and stdout. claude-agent-acp runs the SDK on
your machine, and cc-remote starts `claude` through `ssh -T`, so that same stream crosses the
network.

The built-in file and shell tools are turned off on the server. cc-remote replaces them with
local versions that have the same names and inputs, and `claude` calls them through the SDK's tool
channel, the same way it calls any in-process MCP tool. Your client's MCP servers use that same
channel. A proxy on the stream renames the tools back to their built-in names, so your client
renders diffs and terminals as usual. It also maps the server's paths to your local ones.

claude-agent-acp is patched in one place (`patches/`): a hook that rewrites the `query()` options
for each session. See [`PLAN.md`](PLAN.md) for the full design.

Under Orca the SDK on the other end of the stream is Orca's, which knows nothing about cc-remote.
`cc-remote claude` adjusts claude's command line the same way the options hook does, adds the local
tools to the SDK's `initialize` request, and answers claude's requests for them itself, so they never
reach Orca. It also turns on claude's transcript mirror and writes the mirror locally. Everything
else on the stream, Orca's own tools and permission prompts included, passes through the same proxy.

## Develop

```sh
bun install
bun test
bun src/main.ts --host <your-server>     # speaks ACP on stdio
bun run compile                   # dist/cc-remote, for this machine
bun run build                     # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64,windows-x64,windows-arm64}
```

`test/e2e/` has a minimal ACP client and a fake ssh, which runs the "remote" side on this machine
under a separate `HOME`. With `FAKE_HOST_ISOLATED=1` (Linux, unprivileged user namespaces) the
fake server is a second machine as far as files go: its home, temp folder and claude's per-session
folders are private to it, while the Claude login is shared. See the headers of
`test/e2e/client.ts` and `test/e2e/fakessh`.
