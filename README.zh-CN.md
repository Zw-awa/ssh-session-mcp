# ssh-session-mcp

**中文** | [English](README.md)

[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

`ssh-session-mcp` 是一个面向 MCP 客户端的持久化 SSH PTY 会话运行时。它让用户和 AI 共享同一个终端会话，补上浏览器 viewer、输入来源标记、长任务跟踪和会话级状态管理，不再把 SSH 交互退化成一次性命令调用。

![ssh-session-mcp 首页动图](https://raw.githubusercontent.com/Zw-awa/ssh-session-mcp/main/site/assets/hero-loop.gif)

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

## 快速开始

### 1. 面向 Agent 的自动安装方式

如果你的目标是让 Claude Code、Codex、OpenCode 在 `mcp add` 时自动下载并运行这个 server，优先把 MCP 命令写成 `npx -y ssh-session-mcp`，而不是要求用户先全局安装。

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
SSH_HOST=192.168.1.100
SSH_PORT=22
SSH_USER=username
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
  "defaultDevice": "board-a",
  "devices": [
    {
      "id": "board-a",
      "host": "192.168.10.58",
      "port": 22,
      "user": "orangepi",
      "auth": { "passwordEnv": "BOARD_A_PASSWORD" },
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
| `safe` | 默认模式。阻止明显危险、交互式或不适合自主执行的流式命令。 |
| `full` | 允许更宽的控制范围，但仍对极端危险操作保留最强拦截。 |

## 输入锁

| 模式 | 谁可以输入 |
|------|------------|
| `common` | 用户和 AI |
| `user` | 只有用户 |
| `claude` / `codex` | 只有选中的 AI |

当终端被用户锁住时，`ssh-run`、`ssh-session-send` 和 `ssh-session-control` 会返回 blocked，而不会强行把输入打进 PTY。

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
- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md)
- [CHANGELOG.md](CHANGELOG.md)

## 开发

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
