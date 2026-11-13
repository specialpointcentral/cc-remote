# cc-remote

English | [简体中文](README.zh-CN.md)

**Use Claude Code on your laptop without installing or logging into it there.**

cc-remote runs Claude Code on a server you can reach over ssh, and runs every tool it calls
on your own machine. The model, your login and your subscription stay on the server. Your
code, your shell, your toolchain and your editor stay with you.

It's an [ACP](https://agentclientprotocol.com) agent, so it plugs straight into
[acpc](https://github.com/AkaraChen/acpc) in the terminal, Zed, paseo and any other ACP client. To your editor it looks exactly like Claude Code.

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

### Commands

```
cc-remote [--host <host>]                  speak ACP on stdio (what your client runs)
cc-remote [--host <host>] doctor           check ssh and the remote claude version
cc-remote [--host <host>] --cli <args...>  run `claude <args...>` on the server
cc-remote --version | --help
```

## Behavior

**Permissions.** Permission requests go to your client, the same as with any ACP agent. Read, Glob
and Grep never ask. "Accept edits" approves Write, Edit and NotebookEdit inside the session's
directory. When a Bash command asks, the approval it offers is for a command prefix (such as
`npm test:*`) rather than all of Bash. PowerShell commands on Windows work the same way. A command with `;`, `&`, `|`, redirects, `$(…)`, backticks
or newlines is never approved automatically. Prefix approvals last until cc-remote exits.

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
on the server without your machine's tools.

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

## Develop

```sh
bun install
bun test
bun src/main.ts --host <your-server>     # speaks ACP on stdio
bun run compile                   # dist/cc-remote, for this machine
bun run build                     # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64,windows-x64,windows-arm64}
```

`test/e2e/` has a minimal ACP client and a fake ssh, which runs the "remote" side on this machine
under a separate `HOME`. See the header of `test/e2e/client.ts` for usage.
