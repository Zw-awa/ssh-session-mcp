# ssh-session-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)

Persistent SSH PTY session manager for MCP clients with actor-aware input tracking, split dashboard rendering, and automatic session cleanup.

它不是一次性 SSH 命令执行器，而是：

- 建立 SSH 连接
- 打开交互式 PTY shell
- 持续写入输入
- 增量读取终端输出
- 长轮询会话变化
- 实时渲染双栏 dashboard
- 自动回收空闲/悬挂 SSH 会话

## 当前能力

- `ssh-session-open`
  - 打开一个持久 SSH PTY 会话
  - 支持 `startupInput`
  - 支持每会话 `idleTimeoutMs`
  - 支持 `includeDashboard`、`autoOpenViewer`、`viewerMode`、`viewerSingletonScope`
  - 返回当前会话状态和初始 dashboard

- `ssh-session-send`
  - 往已有会话发送原始输入
  - 支持 `actor`
  - 适合标记 `codex`、`claude`、`user`

- `ssh-session-read`
  - 读取原始终端输出
  - 支持 `offset`
  - 支持 `waitForChangeMs`

- `ssh-session-watch`
  - 长轮询会话变化
  - 返回一个双栏 dashboard
  - 左边是远端 SSH 终端输出
  - 右边是 `user/codex/claude` 输入与会话生命周期
  - 支持 `includeDashboard=false` 只取结构化状态

- `ssh-session-control`
  - 发送控制键
  - 支持 `ctrl_c`、`ctrl_d`、方向键、`tab`、`esc`
  - 支持 `actor`

- `ssh-session-resize`
  - 调整 PTY 窗口大小

- `ssh-session-list`
  - 查看当前被 MCP 进程跟踪的会话
  - 默认只看活跃会话
  - 可选包含刚关闭但还未清理的 retained 会话

- `ssh-session-close`
  - 立即关闭会话并从 MCP 中移除

- `ssh-viewer-ensure`
  - 为某个会话确保存在 viewer
  - 支持 `terminal` / `browser`
  - 支持按 `connection` 或 `session` 维度做单实例复用

- `ssh-viewer-list`
  - 查看当前持久化 viewer 进程状态
  - 可用于排查 viewer 绑定关系和 PID

## 双栏显示

`ssh-session-watch` 返回的是一个接近 CLI Agent 的 dashboard：

- 左栏：远端主机 shell / codex / claude / tmux 的终端输出
- 右栏：谁输入了什么
  - `actor=user`
  - `actor=codex`
  - `actor=claude`
  - 控制键和会话关闭原因也会记录在右栏

如果你想自己和代理共用同一个 SSH 会话，关键是：

1. 代理调用 `ssh-session-send` 时传 `actor=codex`
2. 你自己手动调用 `ssh-session-send` 时传 `actor=user`
3. 持续调用 `ssh-session-watch`

这样右栏就能明确区分“谁发的输入”。

## 自动回收

当前实现已经补上了悬挂会话的自动处理：

- 远端 shell / channel 关闭
  - 会立即关闭底层 SSH 连接

- 会话长时间无输入输出
  - 到达 `idleTimeoutMs` 后自动关闭

- MCP 进程正常退出
  - 会主动关闭所有会话

- 已关闭会话
  - 会保留一小段时间用于排查
  - 之后自动从内存里清理

默认参数：

- 空闲超时：`30 分钟`
- 关闭后保留：`5 分钟`
- sweep 间隔：`5 秒`

## 启动参数

可选默认值：

- `--host`
- `--port=22`
- `--user`
- `--password`
- `--key=/path/to/private/key`
- `--timeout=1800000`
  - 默认空闲回收超时
- `--cols=120`
- `--rows=40`
- `--term=xterm-256color`
- `--maxBufferChars=200000`
- `--defaultReadChars=4000`
- `--idleSweepMs=5000`
- `--closedRetentionMs=300000`
- `--maxTranscriptEvents=2000`
- `--maxTranscriptChars=200000`
- `--defaultWatchWaitMs=5000`
- `--defaultDashboardWidth=140`
- `--defaultDashboardHeight=24`
- `--defaultDashboardLeftChars=12000`
- `--defaultDashboardRightEvents=40`
- `--viewerHost=127.0.0.1`
- `--viewerPort=0`
- `--viewerRefreshMs=1000`

## Viewer 与 Windows Helper 脚本

如果你已经启用了内置 viewer HTTP 服务，可以直接用 MCP 工具：

- `ssh-session-open`
  - 传 `autoOpenViewer=true`
  - `viewerMode=terminal|browser`
  - `viewerSingletonScope=connection|session`

- `ssh-viewer-ensure`
  - 对已有会话补开 viewer

- `ssh-viewer-list`
  - 查看当前 viewer 绑定、PID 和状态

Windows 下也可以直接用仓库自带脚本：

```powershell
# 在新窗口里确保 runner 就绪并打开只读 viewer
powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File .\scripts\open-viewer-window.ps1 `
  -Host 192.168.1.100 `
  -User board `
  -Key C:\path\to\id_ed25519

# 查看后台 runner / viewer 状态
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-viewer.ps1 -Action status

# 停掉后台 runner / viewer
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-viewer.ps1 -Action stop
```

这些脚本会在仓库根目录产生本地运行时文件，但默认已忽略：

- `.viewer-processes.json`
- `.demo-viewer-state.json`
- `logs/live-viewer/*`

## 接入 Codex CLI

```bash
codex mcp add ssh-session-mcp -- node /path/to/ssh-session-mcp/build/index.js -- --host=192.168.1.100 --user=username --key=/path/to/private/key
```

## 接入 Claude Code

```bash
claude mcp add --transport stdio ssh-session-mcp -- node /path/to/ssh-session-mcp/build/index.js -- --host=192.168.1.100 --user=username --key=/path/to/private/key
```

## 示例

### 1. 打开会话

```json
{
  "sessionName": "board-main",
  "host": "192.168.1.100",
  "user": "board",
  "key": "/path/to/private/key",
  "startupInput": "cd /workspace/board-fw\n",
  "startupInputActor": "codex",
  "dashboardWidth": 160,
  "dashboardHeight": 28
}
```

### 2. 启动远程 codex

```json
{
  "session": "board-main",
  "input": "codex",
  "appendNewline": true,
  "actor": "codex"
}
```

### 3. 你自己插入一条输入

```json
{
  "session": "board-main",
  "input": "先检查当前 ROS2 launch 和模型加载路径",
  "appendNewline": true,
  "actor": "user"
}
```

### 4. 实时看双栏 dashboard

```json
{
  "session": "board-main",
  "waitForChangeMs": 3000,
  "dashboardWidth": 160,
  "dashboardHeight": 28
}
```

### 5. 读取原始终端输出

```json
{
  "session": "board-main",
  "offset": 0,
  "maxChars": 4000
}
```

## 持久性边界

“持续化”分两层：

- SSH shell 持续化
  - 只要 MCP 进程还在、会话没超时、远端 shell 没退出，就可以持续输入输出

- 跨 MCP 进程重启的持续化
  - 当前没有做跨进程恢复
  - 如果你要跨进程重启还保住远端工作流，建议远端配合 `tmux` / `screen`

## 安全边界

这个项目不会主动上传你的 SSH 数据到某个外部服务器。  
它本质上只是：

- 本地 MCP 进程
- 本地到你指定主机的 SSH 连接
- 内存中暂存输出缓冲、输入事件和 dashboard 数据

但要注意：

- 如果你给 MCP 配了第三方客户端，客户端本身如何记录对话，是客户端自己的行为
- 如果你把 `password` 明文写进启动参数，启动方式本身会留下本地使用痕迹
- 如果要更稳，优先用 `--key`

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [API 参考](#api-参考)
- [配置选项](#配置选项)
- [开发](#开发)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

- **持久化 SSH PTY 会话**: 建立并维护交互式 SSH 终端会话
- **多客户端支持**: 兼容 Codex、Claude Code、Cursor 等 MCP 客户端
- **双栏仪表盘**: 实时显示终端输出和输入历史
- **角色感知输入跟踪**: 区分用户、Codex、Claude 等不同角色的输入
- **自动会话管理**: 空闲超时自动回收，悬挂会话清理
- **控制键支持**: 支持 Ctrl+C、Ctrl+D、方向键等控制操作
- **窗口大小调整**: 动态调整 PTY 窗口尺寸

## 安装

```bash
# 克隆仓库
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp

# 安装依赖
npm install

# 构建项目
npm run build
```

### 从 npm 安装
```bash
npm install -g ssh-session-mcp
```

安装后可以使用以下命令：
- `ssh-session-mcp`: 主 MCP 服务器
- `ssh-session-mcp-view`: 终端查看器 CLI

## 快速开始

### 1. 配置 MCP 客户端

#### Codex CLI
```bash
codex mcp add ssh-session-mcp -- node /path/to/ssh-session-mcp/build/index.js -- --host=192.168.1.100 --user=username --key=/path/to/private/key
```

#### Claude Code
```bash
claude mcp add --transport stdio ssh-session-mcp -- node /path/to/ssh-session-mcp/build/index.js -- --host=192.168.1.100 --user=username --key=/path/to/private/key
```

### 2. 基本使用示例

```json
{
  "sessionName": "my-server",
  "host": "192.168.1.100",
  "user": "username",
  "key": "/path/to/private/key",
  "startupInput": "cd /workspace\n",
  "startupInputActor": "codex"
}
```

### 3. 使用 Viewer 实时监控会话

#### 终端查看器
```bash
# 启动终端查看器
ssh-session-mcp-view --session=my-server --host=127.0.0.1 --port=8765

# 或使用绑定键
ssh-session-mcp-view --binding=connection:username@192.168.1.100:22 --host=127.0.0.1 --port=8765
```

#### 浏览器查看器
访问 `http://127.0.0.1:8765` 查看所有活跃会话的 Web 界面。

## API 参考

### 工具列表

| 工具                  | 描述                       | 参数                                                                             |
| --------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `ssh-session-open`    | 打开持久 SSH PTY 会话      | `sessionName`, `host`, `user`, `key`/`password`, `startupInput`, `idleTimeoutMs`, `includeDashboard`, `autoOpenViewer` |
| `ssh-session-send`    | 发送输入到会话             | `session`, `input`, `actor`, `appendNewline`                                     |
| `ssh-session-read`    | 读取终端输出               | `session`, `offset`, `maxChars`                                                  |
| `ssh-session-watch`   | 监控会话变化（双栏仪表盘） | `session`, `waitForChangeMs`, `dashboardWidth`, `dashboardHeight`, `includeDashboard` |
| `ssh-session-control` | 发送控制键                 | `session`, `ctrl_c`, `ctrl_d`, `arrow_up`, 等                                    |
| `ssh-session-resize`  | 调整 PTY 窗口大小          | `session`, `cols`, `rows`                                                        |
| `ssh-session-list`    | 列出当前会话               | `includeClosed`                                                                  |
| `ssh-viewer-ensure`   | 为会话确保存在 viewer      | `session`, `mode`, `singletonScope`                                              |
| `ssh-viewer-list`     | 列出 viewer 进程与绑定     | 无                                                                               |
| `ssh-session-close`   | 关闭会话                   | `session`                                                                        |

### 角色系统

支持三种角色标记输入来源：
- `actor=user`: 用户手动输入
- `actor=codex`: Codex 代理输入
- `actor=claude`: Claude 代理输入

## 配置选项

### 命令行参数

| 参数                  | 默认值         | 描述                               |
| --------------------- | -------------- | ---------------------------------- |
| `--host`              | -              | SSH 主机地址（必需）               |
| `--port`              | 22             | SSH 端口                           |
| `--user`              | -              | SSH 用户名（必需）                 |
| `--password`          | -              | SSH 密码（与 key 二选一）          |
| `--key`               | -              | SSH 私钥路径（与 password 二选一） |
| `--timeout`           | 1800000        | 空闲回收超时（毫秒）               |
| `--cols`              | 120            | 终端列数                           |
| `--rows`              | 40             | 终端行数                           |
| `--term`              | xterm-256color | 终端类型                           |
| `--maxBufferChars`    | 200000         | 最大缓冲区字符数                   |
| `--defaultReadChars`  | 4000           | 默认读取字符数                     |
| `--idleSweepMs`       | 5000           | 空闲扫描间隔（毫秒）               |
| `--closedRetentionMs` | 300000         | 关闭后保留时间（毫秒）             |
| `--viewerHost`        | 127.0.0.1      | Viewer HTTP 服务器绑定主机         |
| `--viewerPort`        | 0              | Viewer HTTP 服务器端口（0=禁用）   |
| `--viewerRefreshMs`   | 1000           | Viewer 页面自动刷新间隔（毫秒）    |

### 环境变量

| 变量                   | 描述                                |
| ---------------------- | ----------------------------------- |
| `SSH_MCP_DISABLE_MAIN` | 设置为 "1" 时禁用主进程（用于测试） |

## 开发

### 构建项目
```bash
npm run build
```

### 推荐测试顺序
```bash
# 1. TypeScript 构建
npm run build

# 2. PowerShell helper 语法检查
powershell -NoLogo -NoProfile -Command "$paths = @('scripts\\ensure-viewer.ps1','scripts\\live-viewer.ps1','scripts\\open-viewer-window.ps1'); foreach ($path in $paths) { $tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$tokens, [ref]$errors); if ($errors) { $errors | ForEach-Object { throw \"${path}:$($_.Extent.StartLineNumber): $($_.Message)\" } } }; 'PowerShell syntax OK'"

# 3. demo runner 脚本语法检查
node --check scripts/demo-session-runner.mjs

# 4. 单元测试
npm test
```

如果你在受限沙箱里运行 `npm test` 遇到 `spawn EPERM`，通常是测试 worker 进程被环境拦截；换到本机正常 PowerShell / CMD 再跑一次即可。

### 运行测试
```bash
npm test
```

### 开发模式（监听文件变化）
```bash
npm run test:watch
```

### 代码覆盖率
```bash
npm run coverage
```

### MCP 检查器
```bash
npm run inspect
```

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解如何参与项目开发。

## 安装

### 从 npm 安装
```bash
npm install -g ssh-session-mcp
```

### 从源码安装
```bash
# 克隆仓库
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp

# 安装依赖
npm install

# 构建项目
npm run build
```

## 许可证

本项目基于 [MIT 许可证](LICENSE) 发布。
