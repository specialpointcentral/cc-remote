# cc-remote

[English](README.md) | 简体中文

**在本机使用 Claude Code，而本机既不用安装，也不用登录。**

cc-remote 让 Claude Code 跑在一台你能 ssh 上去的服务器上，而它调用的每个工具都在你自己的机器上执行。
模型、登录状态和订阅都留在服务器；代码、shell、工具链和编辑器都留在你身边。

它是一个 [ACP](https://agentclientprotocol.com) agent，可以直接接入终端里的 [acpc](https://github.com/AkaraChen/acpc)、Zed、paseo 以及任何 ACP 客户端。
在编辑器看来，它就是 Claude Code。它还可以替代内嵌 Claude Agent SDK 的应用（例如 [Orca](#orca)）所调用的 `claude` 可执行文件。

```
  本机                                           服务器
 ┌───────────────────────────────┐   ssh    ┌─────────────────────────┐
 │ Zed / paseo / 任意 ACP 客户端 │          │ claude（已登录）        │
 │        ⇅                      │ ───────► │  模型、提示词、         │
 │ cc-remote                     │ ◄─────── │  网页搜索、子代理、     │
 │  Read · Write · Edit · Bash   │          │  skills、服务器端 MCP   │
 │  Glob · Grep · 你的 MCP       │          │                         │
 └───────────────────────────────┘          └─────────────────────────┘
```

## 为什么用它

- **Claude 登录在别的机器上。** 开发机、公司服务器、某个能用 Claude 的地区的主机。
  在那里登录一次，你所有的电脑都能用。
- **代码留在本地。** 和 ssh 上去直接跑 `claude` 不同，被编辑的文件、被执行的命令都在你本机，
  用的是你本机的依赖、git 配置和构建工具。
- **本地的 MCP 服务器照样能用。** 编辑器传来的、以及本地 Claude Code 配置里的 MCP 服务器都在本机运行，
  需要 OAuth 登录的也支持。
- **服务器上什么都不用装。** 不用安装服务，也不用开放端口：cc-remote 会自己把需要的东西复制到
  `~/.cc-remote/` 下。只要 `ssh <your-server> claude --version` 能跑通，cc-remote 就能用。
- **本机只需一个二进制，支持 macOS、Linux 和 Windows。** 本机不需要安装 `claude`，也不需要登录 Claude。
- **就是原汁原味的 Claude Code。** cc-remote 就是 Claude Code 的 ACP 适配器
  [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)，只改了一处：
  它启动的 `claude` 跑在服务器上。会话、权限确认、模式、模型、fork 和 diff 都和 claude-agent-acp 一样工作。

## 什么在哪里运行

| 在本机运行 | 在服务器运行 |
|---|---|
| Read、Write、Edit、NotebookEdit、Bash（Windows 上为 PowerShell）、Glob、Grep | 模型、系统提示词、会话 |
| ACP 客户端带来的 MCP 服务器，以及本地 Claude Code 配置里的 MCP 服务器 | 网页搜索、子代理、skills |
| 你的 `CLAUDE.md` 文件、git 状态、环境信息 | 服务器自己的设置和 MCP 服务器 |

## 前置条件

本文中的 `<your-server>` 指你的服务器，请替换成任何 `ssh` 接受的写法，比如主机名、`user@host`，
或 `~/.ssh/config` 里的 `Host` 别名。

开始之前，先准备好这两样：

- **能 ssh 到服务器。** `ssh <your-server>` 能免密登录（用密钥，端口、用户名和跳板机写进 `~/.ssh/config`）。
- **服务器上的 `claude` 已登录。** Claude Code 2.1.268 或更新版本，登录 shell 为 POSIX shell。
  在服务器上运行一次 `claude` 并登录，或者装好 cc-remote 后用 `cc-remote --cli auth login`。

服务器上的 `python3`（3.6 或更高）是可选的：有它，连接断开后会话还能继续。

本机上的 cc-remote 是一个没有任何依赖的二进制，只有从源码构建时才需要 [Bun](https://bun.sh)。
支持 macOS、Linux 和 Windows；Windows 上还需要 Windows 10 及以上自带的 OpenSSH 客户端。

## 安装

在每台要用 cc-remote 的机器上（你的笔记本，或每台运行 Orca Server 的项目机器）运行：

```sh
curl -fsSL https://raw.githubusercontent.com/specialpointcentral/cc-remote/main/install.sh | sh
```

安装脚本会下载适合本机的发布版二进制（linux-x64、linux-arm64 或 darwin-arm64），用发布中的
`SHA256SUMS` 校验，放到 `~/.local/share/cc-remote/versions/<版本>/`，让 `~/.local/bin/cc-remote` 指向它，
然后运行 [`cc-remote setup`](#设置)。它从不使用 sudo，也从不修改 shell 的启动文件；如果 `~/.local/bin`
不在 PATH 上，会告诉你要加什么。`sh -s --` 之后的选项会传给 setup，例如 `| sh -s -- --host <your-server>`；
`--no-setup` 跳过 setup，`CC_REMOTE_VERSION=0.3.1` 安装指定版本。Windows 上请从发布页面下载
`cc-remote-windows-x64.exe`（或 `-arm64.exe`），之后用 [`cc-remote update`](#更新) 保持更新。

### 从源码安装

```sh
git clone https://github.com/specialpointcentral/cc-remote && cd cc-remote
bun install
bun run compile    # 为当前机器构建二进制，输出到 dist/cc-remote
bun link           # 把 cc-remote 加到 PATH，位于 ~/.bun/bin
```

`bun run compile` 会根据当前机器选择对应的 `build:<os>-<arch>` 脚本。要一次构建所有平台
（linux-x64、linux-arm64、darwin-arm64、windows-x64、windows-arm64），运行 `bun run build`，产物在 `dist/`。
从源码安装的用 `git pull && bun run compile` 更新，而不是 `cc-remote update`。

运行 `cc-remote setup`，或者自己指定要用的主机，然后检查连接：

```sh
mkdir -p ~/.config/cc-remote && echo <your-server> > ~/.config/cc-remote/host
cc-remote doctor
```

cc-remote 按以下顺序查找主机：`--host`，然后 `$CC_REMOTE_HOST`，然后 `~/.config/cc-remote/host`。
主机可以是任何 `ssh` 接受的写法，端口、密钥和跳板机写进 `~/.ssh/config`。

如果需要换一个 ssh 命令，设置 `CC_REMOTE_SSH`，用法类似 rsync 的 `RSYNC_RSH`：

```sh
export CC_REMOTE_SSH="ssh -p 2222 -i ~/.ssh/id_ed25519"
```

如果服务器还没登录，运行 `cc-remote --cli auth login`。

## 设置

`cc-remote setup` 会逐步检查和配置本机的一切，可以放心重复运行（再次运行时只会询问服务器，按回车保留原值）：

1. **本机：** ssh、cc-remote 的安装、ripgrep、登录 shell、git 和主机名。缺少工具时会显示确切的安装命令，
   并先以 `[y/N]` 询问再运行。
2. **中心服务器：** 询问要用哪台服务器。Tab 会从 `~/.ssh/config`、`~/.ssh/known_hosts` 和以前的输入中补全，
   上下方向键可以浏览它们。
3. **连接：** 检查 ssh 能否不用密码、也不靠 ssh-agent 登录（Orca Server 没有 ssh-agent）。它可以通过 OpenSSH
   自己的提示信任未知的主机密钥，为 cc-remote 生成密钥并用 `ssh-copy-id` 复制过去（密码输给 ssh），
   再把这个密钥写进 `~/.ssh/config` 中一个受管理的块（会先备份）。绝不接受改变了的主机密钥。
4. **检查服务器：** claude 的版本和登录状态、auto 权限模式、`~/.cc-remote`、python3（用于重连），以及
   sshd 的限制和账号的资源。
   claude 不存在、太旧或未登录时，setup 会停下并给出提示：setup 从不安装、更新或登录 claude，
   也不会改动服务器上 `~/.cc-remote` 以外的任何东西。给服务器管理员的建议（例如 sshd 的 `MaxSessions`）
   只会打印出来，绝不自动应用。
5. **保存：** host 文件 `~/.config/cc-remote/host`，以及服务器上本机的标记，两台项目机器主机名相同时会发出警告。
6. **本机的 Orca Server**（如果在运行）：把它的 Claude Command 设为 `~/.local/bin/cc-remote claude`，
   为新的 Claude 聊天提供 auto 权限模式（只改 Claude 的，其他 agent 保持不变），还可以把 `CC_REMOTE_SSH`
   复制到 Orca 的 Claude 环境变量。每项改动都会显示当前值和新值，先询问，再从 Orca 读回确认。
7. **端到端：** 按 Orca 的方式运行 Orca 的命令加 `--version`，使用 Orca Server 的环境、不依赖 ssh-agent，
   实时询问服务器。

```sh
cc-remote setup                                   # 在终端里交互运行
cc-remote setup --check                           # 只验证，不做任何改动；有失败时退出码为 1
cc-remote setup --yes --host <your-server>        # 无人值守，采用默认选择；不安装任何东西
cc-remote setup --yes --install --host <your-server> --orca set
```

没有终端或加了 `--yes` 时，setup 只采用安全的选择：写 host 文件和它自己的记录；Orca 的 Claude Command
只在它是 Orca 默认值或其他 cc-remote 路径时才修改（`--orca set` 总是替换，`--orca skip` 不碰 Orca）；
权限模式只从 Orca 的默认值修改。只有加 `--install` 才会安装工具，并通过 `sudo -n` 进行。`--smoke`
会在最后发送一次很小的真实提问，会消耗 token。`cc-remote setup --help` 列出所有选项。提示信息按你的
locale 或 `--lang` 使用中文或英文。

setup 会在 `~/.config/cc-remote/` 中保存输入历史，以及它做过的每项改动和被替换的旧值。

## 更新

```sh
cc-remote update --check          # 已安装版本和最新版本；不做任何改动
cc-remote update                  # 安装最新版本并切换过去
cc-remote update --version 0.3.1  # 指定版本，也可以是更旧的
cc-remote update --rollback       # 切回上一个版本
```

更新从不打断正在运行的东西。新版本放进当前版本旁边自己的目录，`~/.local/bin/cc-remote` 通过一次原子的
重命名切换过去：正在运行的会话和 Orca 聊天继续使用它们启动时的版本，新开的才会用新版本。Orca 的
Claude Command 指向 `~/.local/bin/cc-remote`，因此永远不需要修改。切换之前，更新会用 `SHA256SUMS` 校验
下载、运行新版本，并在配置了服务器时用它在服务器上运行 `doctor`：服务器上的 claude 对新版本来说太旧时，
更新会停止（服务器连不上时，`--skip-host-check` 可以照样切换）。旧版本在没有任何进程使用后才会删除，
上一个版本会保留以便 `--rollback`。cc-remote 从不自动更新；有新版本时 `setup` 会提示。

## 使用

装好 cc-remote 后，任何支持 ACP 的客户端都能用。添加一个命令为 `cc-remote --host <your-server>` 的 agent
（如果上面已经写了 host 文件，直接用 `cc-remote` 也行）。

**acpc**，在终端里使用。[acpc](https://github.com/AkaraChen/acpc) 为任何 ACP agent 提供 Codex 的终端界面。
安装它，把 cc-remote 添加为 agent，然后开始会话：

```sh
curl -fsSL https://raw.githubusercontent.com/AkaraChen/acpc/main/install.sh | sh
acpc add --slug cc-remote --name "Claude (remote)" cc-remote --host <your-server>
acpc -a cc-remote
```

给 `acpc add` 加上 `--default`，直接运行 `acpc` 时就会用它。在 acpc 里，`/model` 和 Shift+Tab
可以切换 Claude 的模型和模式，`/resume` 重新打开会话，`/agent` 可以把对话在 cc-remote 和其他 agent 之间转移。

**Zed**，在 `settings.json` 中：

```json
"agent_servers": {
  "Claude (remote)": { "command": "cc-remote", "args": ["--host", "<your-server>"] }
}
```

**paseo**，在 `~/.paseo/config.json` 的 `agents.providers` 下：

```json
"claude-remote": {
  "extends": "acp",
  "label": "Claude (remote)",
  "command": ["cc-remote", "--host", "<your-server>"]
}
```

paseo 还有一个插件，在 [`paseo-plugin/`](paseo-plugin)。可以装插件代替手改配置：它会添加一个
"Claude (remote)" provider，以及设置主机、ssh 命令和可执行文件路径的界面
（Settings → Plugins → cc-remote）。界面上的 "Check" 按钮会运行 `cc-remote doctor`。

```sh
paseo plugin install github:AkaraChen/cc-remote:paseo-plugin
```

### Orca

[Orca](https://github.com/stablyai/orca) 不能添加 ACP agent，但它的 Claude 对话会运行 **Claude Command**
所指定的可执行文件，并像 Claude Agent SDK 对待 `claude` 那样与之通信。`cc-remote claude` 就替代这个
可执行文件：模型跑在服务器上，Read、Write、Edit、Bash、Glob 和 Grep 在运行 Orca Server 的机器上、
对话所在的文件夹里执行。有多台项目机器时，每台都运行 Orca Server 和 cc-remote，共用同一台已登录
`claude` 的服务器。

在每台项目机器上（运行 Orca Server、存放文件的那台）：

1. 按[安装](#安装)一节安装 cc-remote。安装脚本会运行 [`cc-remote setup`](#设置)，它会写好主机文件、
   设置 Orca 的 Claude Command，并提议把新 Claude 对话的权限模式设为 auto。Orca Server 不读取你的
   shell 配置文件，所以请用主机文件，而不是 `$CC_REMOTE_HOST`。
2. 如果想手动设置：把 Orca 的 Claude Command（在 Claude agent 的设置里）设为 cc-remote 的完整路径，
   后面加上 `claude`：

   ```
   /home/me/.local/bin/cc-remote claude
   ```

   `command -v cc-remote` 会输出这个路径。如果想在这里指定服务器而不是用主机文件，就在 `claude`
   前加上 `--host <your-server>`。需要 `CC_REMOTE_SSH` 的话，把它加到 Orca 里 Claude agent 的环境变量中。
3. 新开一个 Claude 对话。权限确认、工具卡片和 diff 都和本地 Claude 一样。

Orca 新对话默认的权限模式是 full-access，这时 Bash 会在项目机器上直接执行，不经询问。`cc-remote setup`
会提议把 Claude 对话改成 auto，也可以在 Orca 设置里自己改。即使在 full-access 下，settings 里的 deny 规则仍会拒绝，ask 规则仍会弹出卡片。
Orca 只提供"本次会话允许"，没有"总是允许"；需要长期生效的授权请写进 `.claude/settings.local.json`。
在 Orca 里切换对话的模式或模型时，Orca 会重启 claude，这个对话里"本次会话允许"的授权会保留。

每个对话的记录都会镜像到项目机器上的 `~/.claude/projects/`，Orca 从那里读取，所以历史记录、追问，
以及 Orca Server 重启后恢复对话都能正常工作。Orca 自带的对话插件（内嵌可视化）会在第一次需要时
复制到服务器的 `~/.cc-remote/plugins/` 下。如果某个应用只接受一个路径、不能带参数，可以建一个名为
`claude`、指向 cc-remote 可执行文件的链接，它的作用和 `cc-remote claude` 一样。不要把这个链接放进
`PATH`，以免遮住本地的 `claude`。

在[通用限制](#限制)之外，Orca 还有这些限制：

- 对话总是使用服务器上的 Claude 登录。Orca 的账号切换改变不了这一点，所以请用 Orca 的系统账号；
  选了托管账号时，对话记录会写到该账号的目录，但登录仍然是服务器的。
- Orca 一次性的 `claude -p` 调用（例如给对话起名）在服务器上运行，不带任何工具。
- Orca 终端面板里的 Claude 也用这个命令，cc-remote 会拒绝它：交互式的 `claude` 会在服务器的
  文件夹里工作，而不是你的项目。请用 Orca 的对话，或在终端里用 acpc。
- Orca 的 agent 状态钩子装在项目机器的 Claude 设置里，服务器上的 `claude` 不会读取它们。

### 命令

```
cc-remote [--host <host>]                    在 stdio 上提供 ACP（客户端运行的就是这个）
cc-remote [--host <host>] doctor             检查 ssh 和远端 claude 的版本
cc-remote [--host <host>] --cli <args...>    在服务器上运行 `claude <args...>`
cc-remote [--host <host>] claude <args...>   在内嵌 Agent SDK 的应用（如 Orca）里替代 `claude`
cc-remote setup [--check] [options]          设置本机、服务器和 Orca；见“设置”
cc-remote update [--check | --rollback]      安装最新版本；见“更新”
cc-remote --version | --help
```

## 行为

**权限。** 权限请求会发到你的客户端，和其他 ACP agent 一样。Read、Glob 和 Grep 从不询问。
"Accept edits" 会批准会话目录内的 Write、Edit 和 NotebookEdit，但 Claude Code 的受保护路径（`.git`、
`.claude`、shell 启动文件、`.mcp.json` 等）和经符号链接跑到项目外的路径除外。在 auto 模式下，这些编辑
直接放行，不必再去问分类器；其他操作由服务器上 Claude 的 auto 模式分类器判断，它看到的是真实的命令或文件。

本地 shell 命令按你本机的 settings 判断：managed settings、`~/.claude/settings.json`、项目的
`.claude/settings.json`，以及 `.claude/settings.local.json`（和 Claude Code 一样放在仓库根目录）里的
`Bash(...)` 规则。服务器上的规则对它们不起作用。deny 规则会在命令执行前拒绝，任何模式都一样，包括 bypass；
ask 规则总会询问，bypass（Orca 的 full-access）下也一样；allow 规则在默认、accept-edits 和 don't-ask
模式下批准简单的单条命令，在 auto 模式下批准范围窄的规则。命令会像 shell 那样拆开，所以藏在 `&&`、`|`、
`$(…)` 后面，或者套了 `sudo`、`env` 这类包装的命令也能匹配到规则。删除 `/`、顶层目录、你的 home 目录或
项目目录的上级目录（`rm`、`rmdir`）总会询问，在 auto 模式下直接拒绝，任何规则都不能放行。
相对路径从 shell 当前所在目录算起，同一条命令里的 `cd` 也会跟进；`cd` 到 cc-remote 无法确定的位置
（如 `cd "$DIR"`）之后，所有相对路径都按关键路径处理。

只读命令在默认、accept-edits、plan 和 don't-ask 模式下不再询问，和 Claude Code 自己的 Bash 一样：`ls`、
`cat`、`head`、`tail`、`wc`、`grep`/`rg`、不带 `-exec`/`-delete`/`-fprint` 的 `find`、`git status`/`log`/
`diff`/`show`/`branch` 等，也可以用管道或 `&&` 连起来，输出只能重定向到 `/dev/null`，`cd` 只能进入会话
目录。这份清单比 Claude Code 的窄，其他命令照旧询问。auto 模式下仍由分类器判断。

Bash 命令需要确认时，提供的授权针对的是命令前缀（比如 `npm test:*`），而不是整个 Bash。Windows 上的
PowerShell 命令同理。含有 `;`、`&`、`|`、重定向、`$(…)`、反引号或换行的命令永远不会被前缀授权放行。
"不再询问"会把 `Bash(<前缀>:*)` 写进 `.claude/settings.local.json`，并像 Claude Code 一样在第一次写入时
把这个文件加进全局 git 忽略列表；如果这个文件已被 git 跟踪，授权只在本次会话内有效。本次会话的授权
跟着会话保存在 `~/.cache/cc-remote/grants/` 下的私有文件里，同一会话新起的 claude（比如在 Orca 里切换
模式或模型时重启的那个）仍然有效；三天没用的文件会被删除。子代理不能使用 `isolation: worktree`，因为 worktree 会建在服务器上。

**服务器自己的文件。** claude 在服务器上保存一些自己的文件并让模型使用：plan 模式的计划文件（服务器上的
`~/.claude/plans/`）、服务器上 `~/.claude/projects/` 里本会话的目录（自动记忆、因为太大而被存成文件的工具
结果、子代理记录）、子代理记忆（`~/.claude/agent-memory/`）以及后台任务的输出。Read、Write、Edit 和
Glob 会通过同一条 ssh 连接在服务器上读写这些文件，所以 plan 模式照常可用：计划写在 ExitPlanMode 读取它
的地方，审批时也能看到。和 Claude Code 一样，写计划文件和记忆文件不会询问。

**Shell。** Bash 在你的登录 shell 环境里运行，所以即使是 Orca 这类应用拉起 cc-remote，profile 里配置的
工具（conda、nvm、`module` 等）也找得到。用 bash 或 zsh 时，cc-remote 只抓取一次这个环境并在会话之间共享，
十分钟后或启动文件变化时重新抓取；设 `CC_REMOTE_SHELL_SNAPSHOT=off` 则每条命令都以登录 shell 运行。
命令超时或被停止时先收到 SIGTERM，五秒后再收到 SIGKILL。

**搜索。** 装了 ripgrep 时，Glob 和 Grep 一样会遵守你的忽略文件。Grep 默认最多返回 250 条结果
（`head_limit: 0` 返回全部），够数就停止搜索。

**会话。** 每个会话都会镜像到本机的 `~/.claude/projects/`，也就是本地 Claude Code 存放会话的位置。
客户端可以从那里列出、回放、加载和 fork 会话。如果恢复一个服务器没见过的会话（比如 fork 出来的），
cc-remote 会先把它复制到服务器。在服务器上，每个本地目录都有一个独立的工作目录，位于
`~/.cc-remote/ws/<你的主机名>/<本地路径>/`。

**启动会话。** claude 启动之前，会在服务器上做一次检查，看会话需要的东西在不在：要恢复的会话记录、
客户端传来的插件，以及项目的 `.claude/commands`、`.claude/skills` 和 `.claude/agents`（见[限制](#限制)）。
通常它们都在，这时会话只用一个 ssh 通道就能启动。缺了什么，cc-remote 就只上传缺的部分，然后重新启动。
这期间客户端发来的内容不会丢失，也不会重复。

**连接断开。** 会话中的 claude 在 ssh 连接断开后会继续运行。服务器上有 `python3` 3.6 或更高版本时，
cc-remote 会在一个小的中继下启动 claude，中继会被复制到服务器的 `~/.cc-remote/bin/`：它运行 claude，
保存 claude 的输出直到你的机器收到，并等待 cc-remote 回来。cc-remote 每 10 秒发一次心跳；链路 45 秒
没有任何消息（`CC_REMOTE_LINK_TIMEOUT`）或 ssh 退出时，它会用单独的连接重连，先立即重试，之后每隔几秒
一次，数据流从断开的地方接着走。客户端和 claude 发出的内容都不会丢失，也不会重复，所以进行中的回合、
正在运行的 Bash 命令或打开着的权限确认都会照常继续。没有连接时，服务器会保留 claude 30 分钟
（`CC_REMOTE_RECONNECT_GRACE`，单位秒；设为 `0` 关闭此功能），之后将其停止；超过这个时间，或者服务器
重启过，会话会像以前一样结束，下一条消息会恢复它。停止 cc-remote 或关闭聊天会停止服务器上的 claude；
恢复会话时，会停止之前那个已失联的 cc-remote 留下的同一会话的 claude。服务器上没有 python3 时，会话照旧
启动，cc-remote 会提示一次：连接断开会结束会话。claude 在中继下运行时，服务器自己的文件（计划文件、记忆、
保存下来的工具结果）会走会话的连接，而不是每次单独执行一条 ssh 命令。

**服务器上的 claude。** 每个会话启动时都会检查服务器上 claude 的版本，低于[前置条件](#前置条件)里的
版本就拒绝启动。版本号会记住十分钟，所以有些应用每开一个聊天都要先查一次版本，这不会多花 ssh 往返；
`cc-remote doctor` 则每次都会去服务器上查。Agent Teams 已关闭，因为队友会在服务器上运行，用不到你机器上的工具。
cc-remote 还把这一项写进 claude 启动时的 settings，服务器自己的设置也无法再开启它，并会去掉
`--agent-teams` 参数。claude-agent-acp 在每个会话启动时会多次查询 `claude auth status`，结果按服务器
缓存一分钟；通过 `cc-remote --cli auth login` 或 `logout` 登录登出时清空缓存。

**MCP 服务器。** 除了客户端传来的服务器，cc-remote 还会启动本地 Claude Code 会加载的那些：
`~/.claude.json` 里的用户级服务器、为当前目录添加的服务器，以及项目 `.mcp.json` 中你已批准的服务器
（在 `~/.claude/settings.json`、`.claude/settings.local.json` 中批准，或在本地 `claude` 中批准过）。
它们在本机运行，和客户端的服务器以同样方式接到 claude。名字冲突时，客户端的服务器优先于本地配置的，
两者都优先于服务器上同名的服务器。需要 OAuth 的 http 或 sse 服务器在你登录前会提供一个 `authenticate` 工具。
调用它会在本机浏览器打开登录页，在 `localhost` 接收回调，之后服务器真正的工具就会出现。
令牌保存在 `~/.config/cc-remote/mcp-auth/`，与 Claude Code 自己的分开。

**ssh。** 默认所有会话共享一个连接（`ControlMaster`），最后一个会话结束后再保持一小时
（`CC_REMOTE_CONTROL_PERSIST`，可以填任何 `ControlPersist` 接受的值）。数据流会压缩（`Compression=yes`），
链路慢时更快。每个连接都会设置 `ServerAliveInterval=15`，连续五分钟没有响应才放弃
（`CC_REMOTE_KEEPALIVE_TIMEOUT`，单位秒），所以短暂断网不会让聊天中断，真正断开的连接也会报错而不是一直卡住。
建立连接最多等 20 秒（`ConnectTimeout=20`），服务器不可达时很快就会报错。`IPQoS=none` 让流量的 DSCP 标记
交给操作系统决定：上游 OpenSSH 会把这种不带终端的会话标成批量流量（`cs1`），在启用了 QoS 的网络和 Wi-Fi
里会被排在其他流量后面。
如果 `CC_REMOTE_SSH` 里更早出现了同名的 `-o`，则以那个为准。服务器拒绝在共享连接上再开会话时
（sshd 的 `MaxSessions`，默认 10），这个会话会改用自己单独的连接重试。Windows 的 OpenSSH 不能共享连接，
所以在 Windows 上每个会话各开一个连接。

在中继下运行的会话靠自己的心跳更快发现断开的链路。重连使用单独的连接（`ControlPath=none`、
`ConnectTimeout=10`、`BatchMode=yes`），所以卡在断开链路上的共享连接不会拖住它。会话的链路没有响应时，
cc-remote 还会用一次快速的 `ssh <your-server> true` 检查共享连接；如果没有回应，就让它不再接受新会话
（`ssh -O stop`），新的会话会建立新的连接，而不是一直卡到 keepalive 放弃。同时发起的版本探测（Orca 每个
新聊天会发两次）共用一次 ssh。

**Windows。** shell 工具是 PowerShell 而不是 Bash，和 Windows 上的 Claude Code 一致。PATH 里有
PowerShell 7（`pwsh`）时用它，否则用 Windows PowerShell 5.1。Grep 需要 PATH 里有
[ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）。在服务器上，像 `C:\Users\me\app` 这样的本地目录
对应的工作目录是 `~/.cc-remote/ws/<你的主机名>/C/Users/me/app/`。

### 限制

- 项目的 `.claude/` 目录里，只有 `commands/`、`skills/` 和 `agents/` 会发送到服务器（有变化时复制到
  对应的工作目录；最多 1000 个文件，单个 1 MiB，总共 8 MiB）。settings 和 hooks 留在本机。
  服务器上用户级的设置、skills 和 MCP 服务器仍然生效。
- 文件检查点和回退记录在服务器上，因此看不到你本地的修改。
- 从客户端桥接的 MCP 服务器只暴露工具，不暴露 resources 和 prompts。
- LSP、Monitor 和 worktree 相关工具已关闭。
- 重连需要服务器上有 `python3` 3.6 或更高版本。链路断开期间 claude 写到 stderr 的内容会被保留（最多
  1 MiB），但断开那一刻正在传输的部分可能丢失；会话的数据流本身不会丢。如果服务器的 systemd-logind 会在
  ssh 会话结束时杀掉该用户的进程（`KillUserProcesses=yes`），claude 就无法在连接断开后继续运行。
- 一次性的 `claude -p`（例如 Orca 给聊天起标题）和 `cc-remote --cli` 不会重连。
- claude 留在服务器上的自用文件只有 Read、Write、Edit 和 Glob 能访问，Bash 和 Grep 看不到。服务器上的
  skills 和插件不走这条路：skill 指向它旁边的文件时，读到的是你本机的同名文件（如果有）。不支持服务器
  设置里的 `plansDirectory`。

## 工作原理

Claude Agent SDK 通过 stdin 和 stdout 与 `claude` 通信。claude-agent-acp 在你本机运行 SDK，
cc-remote 通过 `ssh -T` 启动 `claude`，于是同一条数据流就跨过了网络。

服务器上内置的文件和 shell 工具被关闭，cc-remote 换上名字和参数都相同的本地版本，
`claude` 通过 SDK 的工具通道调用它们，就像调用任何进程内 MCP 工具一样。客户端的 MCP 服务器也走同一通道。
数据流上的一个代理会把工具名改回内置名，这样客户端能照常渲染 diff 和终端；它还会把服务器上的路径映射回本地路径。

claude-agent-acp 只打了一处补丁（`patches/`）：一个改写每个会话 `query()` 选项的钩子。

在 Orca 下，数据流另一端是 Orca 自己的 SDK，它对 cc-remote 一无所知。`cc-remote claude` 会像选项钩子
那样调整 claude 的命令行，把本地工具加进 SDK 的 `initialize` 请求，并自己应答 claude 对这些工具的请求，
这些请求不会到达 Orca。它还会打开 claude 的会话记录镜像，并把镜像写到本地。数据流上的其他内容，
包括 Orca 自己的工具和权限确认，都照常经过同一个代理。

## 开发

```sh
bun install
bun test
bun src/main.ts --host <your-server>     # 在 stdio 上提供 ACP
bun run compile                   # dist/cc-remote，当前机器
bun run build                     # dist/cc-remote-{linux-x64,linux-arm64,darwin-arm64,windows-x64,windows-arm64}
```

`test/e2e/` 里有一个最小的 ACP 客户端和一个假的 ssh，它会在本机用独立的 `HOME` 运行"远端"那一侧。
设 `FAKE_HOST_ISOLATED=1`（Linux，需要非特权 user namespace）后，假服务器在文件层面就是另一台机器：它的
home、临时目录和 claude 的会话目录都是私有的，Claude 登录仍然共用。用法见 `test/e2e/client.ts` 和
`test/e2e/fakessh` 的文件头。`test/e2e/sdk.ts` 扮演内嵌 Agent SDK 的应用（例如 Orca），在回合进行中
弄断链路（正在运行的 Bash 调用、打开着的权限确认、冻结的链路），用来演示回合会照常继续；用法见文件头。
