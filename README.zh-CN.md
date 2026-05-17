# ssh-session-mcp

**中文** | [English](README.md)

[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

面向 MCP 客户端的共享 SSH 终端运行时。

`ssh-session-mcp` 让用户和 AI 共享同一个 SSH PTY 会话，补上浏览器 viewer、输入来源标记、长任务跟踪和会话级状态管理，不再把 SSH 交互退化成一次性命令调用。

![ssh-session-mcp 首页动图](https://raw.githubusercontent.com/Zw-awa/ssh-session-mcp/main/site/assets/hero-loop.gif)

## 目录

- [安装方式一眼看懂](#安装方式一眼看懂)
- [项目文件目录](#项目文件目录)
- [快速开始](#快速开始)
- [Docker 现状](#6-docker-现状)
- [MCP 工具](#mcp-工具)
- [配置摘要](#配置摘要)
- [安全](#安全)
- [文档](#文档)
- [开发](#开发)

## 安装方式一眼看懂

- 普通用户不需要 `git clone` 这个仓库。
- 面向 MCP client 的首选安装方式：`npx -y ssh-session-mcp --viewerPort=auto`
- 面向本机操作者、希望拿到本地命令的安装方式：`npm install -g ssh-session-mcp`
- 官方容器分发方式也支持，例如 `docker.io/zwawa/ssh-session-mcp`
- `git clone` 只用于二次开发、源码构建和本地调试。
- 对桌面侧 MCP 使用场景来说，`npx` 或全局 npm 安装仍然是推荐路径；Docker 更适合需要固定运行时、容器化部署或镜像仓库分发的场景。

## 它解决什么问题

很多 SSH 类 MCP server 能“执行命令”，但还不能真正管理“共享终端”这件事。

`ssh-session-mcp` 聚焦的是运行时这一层：

- 用户和 AI 共享同一条 PTY
- 浏览器 viewer 用于旁观、接管和协作
- 输入锁防止 AI 覆盖用户输入
- `safe` / `full` 模式控制高风险操作
- 支持默认规则库和会话级自定义规则覆写
- 长时间运行命令自动转异步并可轮询
- 多设备 / 多连接 profile
- `--local` 本地调试模式，适合演示和离线测试

## 最适合的场景

- AI 辅助远程开发 Linux 板卡、训练机、部署机
- 嵌入式、ROS、运维、远端调试这类需要真实终端状态的工作
- 希望 AI 帮忙，但又不愿意把终端完全让出去的用户
- 需要在 MCP Market / GitHub 首页快速讲清楚安装路径和协作模型的项目

## 项目文件目录

关键目录和文件如下：

| 路径 | 用途 |
|------|------|
| `src/` | MCP server、SSH 会话运行时、viewer、工具和配置 CLI 的核心 TypeScript 实现 |
| `src/viewer-html/` | 终端 viewer 的 HTML 页面生成器和浏览器侧脚本 |
| `test/` | 覆盖运行时行为、viewer 契约、配置加载和仓库校验的 Vitest 测试 |
| `docs/` | 契约、失败分类、平台说明、Docker 使用说明等补充文档 |
| `docs/examples/` | 普通模式和 Docker 模式的配置示例 |
| `scripts/` | 构建、版本同步和本地操作者 helper 脚本 |
| `site/` | GitHub Pages 落地页源码 |
| `dist/` | `npm run build:site` 生成的静态站点输出 |
| `build/` | `npm run build` 生成的 JavaScript 构建产物 |
| `Dockerfile` | 容器镜像构建定义 |
| `docker-compose.yml` | profile 配置模式的 Docker Compose 示例 |
| `docker-compose.env.yml` | legacy `.env` 风格的 Docker Compose 示例 |
| `server.json` | 面向 marketplace 分发的 MCP server 元数据 |
| `AGENT.md` | 主 Agent / 操作者执行手册 |
| `llms-install.md` | 面向 Agent 的安装说明和环境变量确认清单 |
| `.env.example` | legacy 单目标环境变量模板 |

## 快速开始

### 1. 面向 Agent 的自动安装方式

如果你的目标是让 Claude Code、Codex、OpenCode 在 `mcp add` 时自动下载并运行这个 server，优先把 MCP 命令写成 `npx -y ssh-session-mcp`，而不是要求用户先全局安装。

如果你是为了 Cline Marketplace 或其他 agent installer 做一键安装，请看 [llms-install.md](llms-install.md)。当前仓库已经按 `npx -y ssh-session-mcp --viewerPort=auto` 这种可自动下载的方式组织。

#### Claude Code

```bash
claude mcp add --transport stdio ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

根据 Claude Code 官方文档，Windows 原生环境下，stdio MCP server 通过 `npx` 启动时建议套一层 `cmd /c`：

```bash
claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto
```

#### Codex

```bash
codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

#### OpenCode

OpenCode 的 `opencode mcp add` 是交互式流程。选择本地 MCP server 后，把命令填成：

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

如果你更喜欢直接写配置，也可以这样：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ssh-session-mcp": {
      "type": "local",
      "command": ["npx", "-y", "ssh-session-mcp", "--viewerPort=auto"]
    }
  }
}
```

这已经是今天 stdio MCP server 最接近“自动安装”的方式了：MCP client 记住命令，第一次运行时由 `npx -y` 自动下载 npm 包。

### 2. 最快本地演示

```bash
npm install -g ssh-session-mcp
ssh-session-mcp-ctl launch --local --viewerPort=auto
```

这会启动本地 shell 而不是 SSH，并自动打开浏览器终端。它是验证产品体验、MCP 调用链和 viewer 的最快路径。

### 3. 作为 MCP Server 注册

如果你要把它接到 Claude Code、Codex CLI 这类 MCP 客户端，直接使用 server 命令：

```bash
# 全局安装
npm install -g ssh-session-mcp

# MCP client 最终使用的 server 命令
ssh-session-mcp --viewerPort=auto
```

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- ssh-session-mcp --viewerPort=auto

# Codex CLI
codex mcp add ssh-session-mcp -- ssh-session-mcp --viewerPort=auto
```

如果你不想全局安装，也可以直接：

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

### 4. 连接真实 SSH 目标

从 `.env.example` 复制一份：

```bash
cp .env.example .env
```

```ini
SSH_HOST=YOUR_DEVICE_HOST
SSH_PORT=22
SSH_USER=YOUR_DEVICE_USER
SSH_PASSWORD=
SSH_KEY=
VIEWER_PORT=auto
AUTO_OPEN_TERMINAL=false
SSH_MCP_MODE=safe
```

然后启动：

```bash
ssh-session-mcp-ctl launch --viewerPort=auto
```

### 5. 多设备配置

如果你有多个设备或多个命名连接，创建 `ssh-session-mcp.config.json`：

```json
{
  "defaultDevice": "DEVICE_A_ID",
  "devices": [
    {
      "id": "DEVICE_A_ID",
      "host": "DEVICE_A_HOST",
      "port": 22,
      "user": "DEVICE_A_USER",
      "auth": { "passwordEnv": "DEVICE_A_PASSWORD" },
      "defaults": {
        "term": "xterm-256color",
        "cols": 120,
        "rows": 40,
        "autoOpenViewer": true,
        "viewerMode": "browser"
      }
    }
  ]
}
```

配置解析顺序：

1. `--config=/path/to/config.json`
2. 工作区 `ssh-session-mcp.config.json`
3. 用户级全局配置
4. 旧式 `.env` 回退

重要说明：

- 配置自动发现基于 MCP 进程工作目录
- `auth.password` 故意不支持，请使用 `auth.passwordEnv` 或 `auth.keyPath`
- 密码等 secret 应保存在 `.env` 或父进程环境中，不应写进受版本控制的 JSON

### 6. Docker 现状

当前仓库已经支持构建并发布官方 Docker 镜像，公开拉取建议优先走 Docker Hub，GHCR 作为补充：

```bash
docker.io/zwawa/ssh-session-mcp:<version>
docker.io/zwawa/ssh-session-mcp:latest
ghcr.io/zw-awa/ssh-session-mcp:<version>
```

连接真实 SSH 目标时，推荐这样启动：

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_HOST=YOUR_DEVICE_HOST \
  -e SSH_PORT=22 \
  -e SSH_USER=YOUR_DEVICE_USER \
  -e SSH_PASSWORD \
  docker.io/zwawa/ssh-session-mcp:latest
```

密码建议先在当前 shell 里导出，不要直接写进命令行。

如果你走 profile 配置方式，推荐这样：

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_MCP_CONFIG=/workspace/ssh-session-mcp.config.json \
  -v "$PWD/ssh-session-mcp.config.json:/workspace/ssh-session-mcp.config.json:ro" \
  -v "/path/to/host/keys:/workspace/keys:ro" \
  docker.io/zwawa/ssh-session-mcp:latest
```

等价的 Compose 用法：

```bash
docker compose up -d
```

可直接参考仓库里的 [docker-compose.yml](docker-compose.yml)。它已经包含 `ssh-session-mcp.config.json` 挂载、`8793` viewer 端口映射，以及通过 `SSH_KEY_DIR` 覆盖默认密钥目录；未设置时会回退到专门的 `./keys` 目录，而不是仓库根目录。
更完整的 Docker 使用说明，包括旧式 `.env` compose 示例和 MCP client 配置片段，见 [docs/docker.md](docs/docker.md)。
如果你想直接从容器友好的 profile 配置开始，可以参考 [docs/examples/ssh-session-mcp.config.docker.example.json](docs/examples/ssh-session-mcp.config.docker.example.json)。

容器场景的额外说明：

- 镜像内如果未显式设置 `VIEWER_PORT`，默认会使用 `8793`，方便稳定映射 browser viewer。
- 镜像内如果未显式设置 `VIEWER_HOST`，默认会改成 `0.0.0.0`，这样宿主机才能访问映射出来的 viewer 端口。
- 容器里默认把 `AUTO_OPEN_TERMINAL` 设为 `false`，因为在容器内部自动打开浏览器通常没有意义。
- 配置文件和 SSH key 建议只读挂载。
- SSH key 最好从仓库目录之外的宿主机目录挂载进来。
- `docker-compose.yml` 里如果设置了 `SSH_KEY_DIR` 就优先使用它；未设置时会回退到 `./keys`，不会回退到仓库根目录。
- 不要把密码直接写进命令行；优先用已导出的环境变量、Compose `.env` 或 `--env-file`。
- 对 stdio MCP client 来说，Docker 可以用，但如果没有明确的容器化要求，宿主机直接用 `npx` 仍然更省事。

把 Docker 作为 MCP server command 的示例：

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest

# Codex CLI
codex mcp add ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

对 JSON 配置式 MCP client，同样可以把 `docker` 作为 command，把后面的 `run ... docker.io/zwawa/ssh-session-mcp:latest` 拆成 args。

Docker 适合这些情况：

- 你想固定 Node 和运行时环境，不依赖本机安装。
- 你想走镜像仓库分发给团队或托管环境。
- 你希望 MCP server 进程本身有容器级隔离。

但对大多数桌面用户来说，发布到 npm 并推荐 `npx -y ssh-session-mcp --viewerPort=auto` 仍然是摩擦最小的安装路径。

## Viewer 与协作模型

浏览器 viewer 不是装饰层，而是协作模型的一部分：

- 用户能实时看到 AI 做了什么
- 用户可以随时接管输入
- password prompt、pager、editor 之类终端状态能被显式看见
- 诊断和历史视图让终端问题变得可排查，而不是只能猜

## 更适合 Marketplace 的使用路径

面向用户：

```text
安装 -> 启动 viewer -> 连接一次 -> 保持会话活着 -> 让 AI 继续协助
```

面向 Agent：

```text
ssh-quick-connect -> ssh-run -> 看输出 -> 需要时查 ssh-command-status -> ssh-run
```

如果你希望 AI 自己检查安装、确认配置来源、连设备并协助排障，优先看 [AGENT.md](AGENT.md)。老的 agent 兼容说明保留在 [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)。

## 它和“无状态 SSH MCP 包装器”的差异

- 共享 PTY，而不是一次一条命令
- transcript 中区分 user / system / agent 输入来源
- 写入前检查终端状态，避免在错误时机发命令
- 自动清理 session 和 viewer 进程
- session 级 browser viewer、诊断和历史
- `--local` 本地调试模式可离线演示

## 运行模式

| 模式 | 行为 |
|------|------|
| `safe` | 默认模式。自动拦截明显危险、交互式或不会自行结束的命令。 |
| `full` | 更少保护，更适合高级使用场景，但仍会拦截少数非常明确的破坏性操作。 |

默认规则集支持按需自定义。

## 输入锁策略

浏览器终端 UI 里，操作者可以选择这些输入策略：

| 策略 | 用户实际体验 |
|------|--------------|
| `common` | 用户和 agent 都可以向共享终端输入。 |
| `user` | 只有用户可以输入，agent 的写入操作会被阻止。 |
| `auto` | 用户开始输入时，不需要和 agent 抢输入权；在用户正在编辑输入草稿时，agent 写入会被阻止。 |
| `agent` | 只有 agent 可以输入，直到策略再次切换前，用户输入都会被阻止。 |

当终端当前不允许 agent 输入时，`ssh-run`、`ssh-session-send` 和 `ssh-session-control` 会返回 blocked，而不会强行把输入打进 PTY。

## MCP 工具

### 日常最常用的工具

| 工具 | 用途 |
|------|------|
| `ssh-quick-connect` | 连接或复用默认目标，并可顺手打开 viewer |
| `ssh-run` | 执行命令，带完成判定和退出码捕获 |
| `ssh-status` | 查看 session、viewer 状态和运行模式 |
| `ssh-command-status` | 查询异步命令进度 |
| `ssh-retry` | 对易失败命令做自动重试 |
| `ssh-session-policy-list` | 查看继承默认规则和当前会话自定义规则 |
| `ssh-session-policy-upsert` | 新增或更新会话级自定义规则 |
| `ssh-session-policy-remove` | 删除会话级自定义规则 |
| `ssh-session-policy-reset` | 将会话规则恢复为继承默认值 |

### 完整工具清单

| 工具 | 用途 |
|------|------|
| `ssh-session-open` | 显式参数打开会话 |
| `ssh-session-send` | 发送原始 PTY 输入 |
| `ssh-device-list` | 列出配置好的设备和默认项 |
| `ssh-session-read` | 按 offset 读取终端输出 |
| `ssh-session-watch` | 长轮询输出和 dashboard 变化 |
| `ssh-session-history` | 查看混合历史记录 |
| `ssh-session-control` | 发送 `ctrl_c`、方向键、`tab` 等控制输入 |
| `ssh-session-resize` | 调整 PTY 尺寸 |
| `ssh-session-list` | 列出所有追踪中的会话 |
| `ssh-session-diagnostics` | 查看锁状态、告警、运行中命令和 viewer 健康状态 |
| `ssh-session-policy-list` | 查看继承默认规则和当前会话规则集 |
| `ssh-session-policy-upsert` | 新增或更新会话级自定义规则 |
| `ssh-session-policy-remove` | 删除会话级自定义规则 |
| `ssh-session-policy-reset` | 把会话规则恢复为继承默认值 |
| `ssh-session-set-active` | 设置默认活动会话 |
| `ssh-viewer-ensure` | 打开或复用本地 viewer |
| `ssh-viewer-list` | 查看 viewer 进程 |
| `ssh-session-close` | 关闭会话 |
| `ssh-quick-connect` | 面向 agent 的一键连接路径 |
| `ssh-run` | 主命令执行路径 |
| `ssh-status` | 运行时总览 |
| `ssh-command-status` | 异步查询 |
| `ssh-retry` | 重试执行 |

## 面向本机操作者的命令

这些 helper 命令给拥有 viewer 的本机操作者使用：

```bash
ssh-session-mcp-ctl status
ssh-session-mcp-ctl devices
ssh-session-mcp-ctl launch --viewerPort=auto
ssh-session-mcp-ctl launch --local --viewerPort=auto
ssh-session-mcp-ctl logs --tail=60
ssh-session-mcp-ctl cleanup
```

给操作者维护默认规则库：

```bash
ssh-session-mcp-config policy list --scope=merged
ssh-session-mcp-config policy set block-kubectl-delete --pattern="\\bkubectl\\s+delete\\b" --category=dangerous --action=block --message="safe 模式下禁止 kubectl delete"
ssh-session-mcp-config policy remove block-kubectl-delete
```

仓库内等价命令也保留着：

```bash
npm run launch
npm run status
npm run devices
npm run logs
npm run cleanup
```

## 配置摘要

关键环境变量：

| 变量 | 含义 | 默认值 |
|------|------|--------|
| `SSH_HOST` | 旧式单目标 SSH host | legacy 模式必填 |
| `SSH_PORT` | 旧式单目标 SSH port | `22` |
| `SSH_USER` | 旧式单目标 SSH user | legacy 模式必填 |
| `SSH_PASSWORD` | 密码认证 | 空 |
| `SSH_KEY` | 本地私钥路径 | 空 |
| `SSH_MCP_INSTANCE` | 运行时隔离 key | `proc-<pid>` 或 helper 选择值 |
| `SSH_MCP_CONFIG` | 显式配置文件路径 | 自动发现 |
| `VIEWER_HOST` | Viewer 绑定 host | `127.0.0.1` |
| `VIEWER_PORT` | Viewer 端口或 `auto` | 未配置时为 `0` |
| `SSH_MCP_MODE` | `safe` 或 `full` | `safe` |
| `SSH_MCP_LOCAL` | 用本地 shell 替代 SSH | `false` |
| `SSH_MCP_DEBUG` | 开启浏览器 debug 动作 | `false` |
| `AUTO_OPEN_TERMINAL` | 自动打开浏览器终端 | `false` |
| `SSH_MCP_LOG_MODE` | `off` 或 `meta` JSONL 日志 | `off` |

### 宏定义 / 环境变量对照表

根据你的安装路径，使用这些变量：

| 变量 | 何时必需 | 可接受值 / 示例 | 说明 |
|------|----------|----------------|------|
| `SSH_HOST` | 旧式单目标 SSH 模式 | `YOUR_DEVICE_HOST` | 除非你使用 `ssh-session-mcp.config.json` 或 `--local`，否则必填。 |
| `SSH_PORT` | 旧式单目标 SSH 模式 | `22` | legacy 模式可省略，默认 `22`。 |
| `SSH_USER` | 旧式单目标 SSH 模式 | `YOUR_DEVICE_USER` | 除非你使用 device profile，否则必填。 |
| `SSH_PASSWORD` | 使用密码认证时 | 已导出的环境变量 | 优先用环境变量，不要把密码直接写进命令行。 |
| `SSH_KEY` | legacy 模式下使用私钥认证时 | `/absolute/path/to/private/key` | 路径必须存在于运行 MCP server 的宿主机上。 |
| `SSH_MCP_CONFIG` | profile 模式，或配置文件不在当前工作目录时 | `/path/to/ssh-session-mcp.config.json` | 当自动发现不够用时显式指定。 |
| `SSH_MCP_INSTANCE` | 多 agent / 多客户端隔离时 | `agent-a` | 当两个 agent 不应该共享运行时状态时，必须用不同值。 |
| `VIEWER_HOST` | 自定义 viewer 绑定地址时 | `127.0.0.1`, `0.0.0.0` | 容器里通常用 `0.0.0.0`；普通宿主机默认保持 `127.0.0.1`。 |
| `VIEWER_PORT` | 需要 viewer 时 | `auto`, `0`, `8793` | `auto` 自动找空闲端口，`0` 关闭 viewer，固定端口更适合 Docker。 |
| `AUTO_OPEN_TERMINAL` | 自动打开 viewer 页面时 | `true`, `false` | 容器里通常建议 `false`。 |
| `SSH_MCP_MODE` | 运行时安全模式 | `safe`, `full` | 默认推荐 `safe`。 |
| `SSH_MCP_LOCAL` | 本地演示模式 | `true`, `false` | 启动本地 shell，而不是 SSH。 |
| `SSH_MCP_DEBUG` | 浏览器 debug 控件 | `true`, `false` | 主要用于演示和排障。 |
| `SSH_MCP_LOG_MODE` | 运行时元数据日志 | `off`, `meta` | `meta` 会写 JSONL 元数据日志，但不应保存明文 secret。 |
| `SSH_KEY_DIR` | Docker Compose profile 示例 | `/path/to/host/keys` | `docker-compose.yml` 里可选；未设置时回退到 `./keys`。 |
| `SSH_SESSION_MCP_IMAGE` | Docker Compose 镜像覆盖 | `docker.io/zwawa/ssh-session-mcp:latest` | 当你要切换 tag 或镜像源时用它覆盖。 |

### 最小必需配置

按场景至少准备这些：

- 本地演示：`SSH_MCP_LOCAL=true` 和 `VIEWER_PORT=auto`
- legacy SSH + 密码：`SSH_HOST`、`SSH_USER`、`SSH_PASSWORD`
- legacy SSH + 私钥：`SSH_HOST`、`SSH_USER`、`SSH_KEY`
- profile 模式：`ssh-session-mcp.config.json`，以及该配置里引用到的 `passwordEnv` 变量
- Docker Compose profile 模式：`ssh-session-mcp.config.json`，可选 `SSH_KEY_DIR`，可选 `SSH_SESSION_MCP_IMAGE`

配置示例：[docs/examples/ssh-session-mcp.config.example.json](docs/examples/ssh-session-mcp.config.example.json)

## 安全

- 包本身不要求在受版本控制的 JSON 中写明文密码
- `.env` 不会被 git 和 npm 包带出去
- Viewer 默认只绑定到本机 localhost
- MCP server 把终端模式和输入锁当成一等安全信号

完整策略见 [SECURITY.md](SECURITY.md)。

## 平台说明

- Windows 10/11：第一优先宿主环境
- Linux：很适合 headless MCP + browser viewer 工作流
- macOS：走标准 Node.js 路径
- 远端 Linux host：第一优先目标

更多细节见 [docs/platform-compatibility.md](docs/platform-compatibility.md)

## 文档

- [AGENT.md](AGENT.md)
- [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)
- [llms-install.md](llms-install.md)
- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md)
- [docs/docker.md](docs/docker.md)
- [CHANGELOG.md](CHANGELOG.md)

## 开发

只有在你要改源码、跑测试或构建发布产物时，才需要 `git clone` 这个仓库。

```bash
npm install
npm run build
npm run test
npm run validate:repo
npm run build:site
```

仓库内的 GitHub Actions 现在支持：

- push / pull request 自动跑 CI
- 从 `dist/` 自动部署 GitHub Pages
- 基于 tag 自动构建 GitHub Release，并附带 npm tarball 和站点包

## 许可证

本项目采用 Apache-2.0，见 [LICENSE](LICENSE)。
