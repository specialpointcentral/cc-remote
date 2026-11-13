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
- **服务器上什么都不用装。** 没有守护进程，不开端口，不装 agent。
  只要 `ssh <your-server> claude --version` 能跑通，cc-remote 就能用。
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

本机需要 [Bun](https://bun.sh) 来构建 cc-remote，构建出的二进制没有任何依赖。
支持 macOS、Linux 和 Windows；Windows 上还需要 Windows 10 及以上自带的 OpenSSH 客户端。

## 安装

```sh
git clone https://github.com/AkaraChen/cc-remote && cd cc-remote
bun install
bun run compile    # 为当前机器构建二进制，输出到 dist/cc-remote
bun link           # 把 cc-remote 加到 PATH，位于 ~/.bun/bin
```

`bun run compile` 会根据当前机器选择对应的 `build:<os>-<arch>` 脚本。要一次构建所有平台
（linux-x64、linux-arm64、darwin-arm64、windows-x64、windows-arm64），运行 `bun run build`，产物在 `dist/`。

指定要用的主机，然后检查连接：

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

1. 按[安装](#安装)一节安装 cc-remote，写好主机文件，并运行 `cc-remote doctor`。
   Orca Server 不读取你的 shell 配置文件，所以请用主机文件，而不是 `$CC_REMOTE_HOST`。
2. 把 Orca 的 Claude Command（在 Claude agent 的设置里）设为 cc-remote 的完整路径，后面加上 `claude`：

   ```
   /home/me/.bun/bin/cc-remote claude
   ```

   `command -v cc-remote` 会输出这个路径。如果想在这里指定服务器而不是用主机文件，就在 `claude`
   前加上 `--host <your-server>`。需要 `CC_REMOTE_SSH` 的话，把它加到 Orca 里 Claude agent 的环境变量中。
3. 新开一个 Claude 对话。权限确认、工具卡片和 diff 都和本地 Claude 一样。

Orca 新对话默认的权限模式是 full-access，这时 Bash 会在项目机器上直接执行，不经询问。建议在 Orca
设置里把默认模式改成 auto。即使在 full-access 下，settings 里的 deny 规则仍会拒绝，ask 规则仍会弹出卡片。
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
如果 `CC_REMOTE_SSH` 里更早出现了同名的 `-o`，则以那个为准。服务器拒绝在共享连接上再开会话时
（sshd 的 `MaxSessions`，默认 10），这个会话会改用自己单独的连接重试。Windows 的 OpenSSH 不能共享连接，
所以在 Windows 上每个会话各开一个连接。

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
完整设计见 [`PLAN.md`](PLAN.md)。

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
`test/e2e/fakessh` 的文件头。
