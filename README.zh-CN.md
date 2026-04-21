# ssh-session-mcp

English: [README.md](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

`ssh-session-mcp` 是一个面向 MCP 客户端的持久化 SSH PTY 会话管理器。用户和 AI 代理共用同一个 SSH 终端：AI 通过 MCP 工具发送命令，用户在浏览器终端中直接输入，输入来源会在本地界面中区分显示。

## 特性

- **共享 SSH 终端**：用户与 AI 共享同一条 PTY，会话状态一致
- **终端 / 浏览器分层**：`terminal` 模式走原样 PTY 透传，`browser` 模式提供更丰富的状态与控制能力
- **xterm.js 浏览器终端**：通过 WebSocket 实时推送终端输出，接近原生 SSH 工具体验
- **智能命令完成判定**：结合 prompt 检测、空闲超时和 sentinel 标记判断命令是否结束
- **安全模式**：提供 `safe` / `full` 两种运行模式，限制危险命令和错误终端状态下的执行
- **异步命令跟踪**：长时间运行的命令可自动转为异步并通过轮询查询状态
- **结构化输出解析**：可自动解析部分常见命令输出，如 `git status`、`git log`、`ls -la`
- **自动重试**：内置 `ssh-retry` 工具，支持固定/指数退避
- **会话诊断**：`ssh-session-diagnostics` 可汇总终端模式、锁状态、viewer 状态、运行中命令和缓存裁剪告警
- **行级历史回看**：`ssh-session-history` 可按行查看 SSH 输出、用户输入、AI 输入和生命周期事件
- **本地元数据日志**：可选 JSONL 文件日志仅记录本地会话 / viewer / 命令元数据，不把终端 transcript 写入 MCP 标准输出
- **输入锁**：支持 `common` / `user` / `codex` / `claude` 模式，避免人与 AI 抢输入
- **来源标记**：状态栏会区分最近一次输入来自 `user`、`codex` 或 `claude`
- **自动清理**：支持空闲超时回收，减少悬挂会话和遗留进程

## 快速开始

### 1. 安装

```bash
npm install -g ssh-session-mcp
```

或者从源码安装：

```bash
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp
npm install && npm run build
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填写你的 SSH 连接信息
```

```ini
SSH_HOST=192.168.1.100
SSH_PORT=22
SSH_USER=username
SSH_PASSWORD=your-password
# 或使用 SSH_KEY=/path/to/private/key（更推荐）
VIEWER_PORT=8793
AUTO_OPEN_TERMINAL=true
SSH_MCP_MODE=safe
```

### 3. 启动（面向用户）

```bash
npm run launch    # 启动 MCP + SSH + 浏览器终端
npm run status    # 查看服务和会话状态
npm run kill      # 结束占用 viewer 端口的进程
npm run cleanup   # 结束进程并清理状态文件
npm run logs      # 查看本地 JSONL 元数据日志
```

### 4. 注册 MCP（面向 AI Agent）

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- node /path/to/build/index.js

# Codex CLI
codex mcp add ssh-session-mcp -- node /path/to/build/index.js
```

SSH 凭据默认从 `.env` 中读取，不需要在命令行里重复传入。

## AI Agent 使用方式

完整说明见 [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)。

### 推荐工作流

```text
ssh-quick-connect → ssh-run → 读取输出 → 决策 → ssh-run → ...
```

### 推荐的简化工具

| 工具 | 用途 |
|------|------|
| `ssh-quick-connect` | 一步建立 SSH 会话并打开浏览器终端 |
| `ssh-run` | 执行命令并返回输出与退出码 |
| `ssh-status` | 查看当前会话、终端模式、运行模式 |
| `ssh-session-diagnostics` | 查看锁状态、viewer 状态、运行中命令和缓存裁剪告警 |
| `ssh-session-history` | 按行查看混合历史记录 |
| `ssh-command-status` | 查询异步长命令执行状态 |
| `ssh-retry` | 对易失败命令做自动重试 |

### 示例

```text
AI: ssh-quick-connect()
→ "Connected. Terminal at http://127.0.0.1:8793/terminal/session/..."

AI: ssh-run({ command: "uname -a" })
→ { exitCode: 0, completionReason: "sentinel" }
   "Linux board 5.10.160-rockchip-rk3588 aarch64"

AI: ssh-run({ command: "apt update" })
→ { async: true, commandId: "abc123", hint: "Use ssh-command-status to check" }

AI: ssh-command-status({ commandId: "abc123" })
→ { status: "completed", exitCode: 0 }
```

## 运行模式

浏览器终端右上角提供 `safe` / `full` 模式切换：

| 模式 | 行为 |
|------|------|
| **safe**（默认） | 默认阻止高风险命令、交互式程序和不会自然结束的流式命令，并返回替代建议 |
| **full** | 允许 AI 直接执行更多命令，仅对极端危险操作保留最强拦截 |

切换到 `full` 模式时，浏览器会弹出确认框。

也可以通过 `SSH_MCP_MODE=safe|full` 环境变量或 `--mode=safe|full` 命令行参数设置默认模式。

## 输入锁

浏览器终端右上角还有一个输入模式选择器：

| 模式 | 谁可以输入 |
|------|------------|
| **common**（默认） | 用户和 AI 都可以输入 |
| **user** | 只有用户可以输入；AI 的 `ssh-run` 会返回 `INPUT_LOCKED` |
| **claude/codex** | 只有 AI 可以输入；用户键盘输入会被阻止 |

当 AI 调用 `ssh-run` 时，会自动获取并释放 agent 锁。

## MCP 工具列表

### 面向 AI 的简化工具

| 工具 | 说明 |
|------|------|
| `ssh-quick-connect` | 一步连接 SSH 并打开终端；已存在会话时会自动复用 |
| `ssh-run` | 执行命令并等待结果，带智能完成判定 |
| `ssh-status` | 查看活动会话、终端状态和运行模式 |
| `ssh-command-status` | 查询异步长命令的执行状态 |
| `ssh-retry` | 自动重试失败命令，支持退避策略 |

### 底层控制工具

| 工具 | 说明 |
|------|------|
| `ssh-session-open` | 以自定义参数打开会话 |
| `ssh-session-send` | 发送原始输入，不等待完成 |
| `ssh-session-read` | 按 offset 读取输出 |
| `ssh-session-history` | 按行号读取历史视图 |
| `ssh-session-watch` | 长轮询会话变化，并渲染 dashboard |
| `ssh-session-control` | 发送控制键，如 Ctrl+C、方向键等 |
| `ssh-session-resize` | 调整 PTY 大小 |
| `ssh-session-list` | 列出所有会话 |
| `ssh-session-close` | 关闭会话 |
| `ssh-viewer-ensure` | 打开 viewer |
| `ssh-viewer-list` | 查看 viewer 进程状态 |

## 配置

### 环境变量（`.env`）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SSH_HOST` | SSH 主机地址 | 必填 |
| `SSH_PORT` | SSH 端口 | 22 |
| `SSH_USER` | SSH 用户名 | 必填 |
| `SSH_PASSWORD` | SSH 密码 | - |
| `SSH_KEY` | SSH 私钥路径 | - |
| `VIEWER_HOST` | Viewer HTTP 服务绑定地址 | `127.0.0.1` |
| `VIEWER_PORT` | Viewer 服务端口（`0` 表示禁用） | `0` |
| `AUTO_OPEN_TERMINAL` | 建立会话时自动打开浏览器终端 | `false` |
| `SSH_MCP_MODE` | 运行模式：`safe` 或 `full` | `safe` |
| `SSH_MCP_USE_MARKER` | 是否启用 sentinel 完成标记 | `true` |
| `SSH_MCP_LOG_MODE` | 本地日志模式：`off` 或 `meta` | `off` |
| `SSH_MCP_LOG_DIR` | 本地 JSONL 日志目录 | `logs/session-mcp` |

### 命令行参数

所有环境变量都可以通过 `--` 参数覆盖：

```bash
node build/index.js --host=192.168.1.100 --user=username --viewerPort=8793 --mode=full
```

## CLI 命令

```bash
npm run launch    # 启动服务并打开浏览器终端
npm run status    # 查看服务和会话状态
npm run kill      # 结束占用 viewer 端口的进程
npm run cleanup   # 结束进程并清理状态文件
npm run logs      # 查看本地 server/session JSONL 日志
npm run build     # 编译 TypeScript
npm run test      # 运行单元测试
npm run inspect   # 打开 MCP inspector
```

## Viewer 模式

- **Terminal 模式**
  - 目标是尽量像普通 SSH 终端窗口
  - 走原样 PTY 透传，把渲染交给本地终端模拟器
  - 适合追求稳定滚动、原生命令行行为、尽量少本地叠加 UI 的场景

- **Browser 模式**
  - 保留更丰富的 UI 和控制层
  - 适合需要锁切换、运行模式切换和会话协同控制的场景
  - 适合用户和 AI 在同一个页面里协作观察

## 安全

- SSH 凭据默认只存放在 `.env` 中，且不会被提交到 git 或 npm 包
- Viewer 默认仅绑定到 `127.0.0.1`
- `safe` 模式默认拦截高风险命令
- 建议优先使用 `SSH_KEY`，避免直接使用密码

## 许可证

[MIT](LICENSE)
