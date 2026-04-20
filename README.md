# ssh-session-mcp

中文文档: [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

Persistent SSH PTY session manager for MCP clients. Users and AI agents share one SSH terminal — AI sends commands via MCP tools, users type in the browser terminal, input sources are visually distinguished.

## Features

- **Shared SSH Terminal**: One PTY, shared by user and AI, with input lock to prevent conflicts
- **Terminal / Browser split**: Terminal mode is raw PTY passthrough; browser mode provides richer controls and status UI
- **xterm.js Browser Terminal**: Real terminal emulator in the browser with WebSocket streaming
- **Intelligent Command Completion**: Prompt detection + idle timeout + deterministic sentinel markers for reliable output capture
- **Safety Modes**: Safe/Full operation modes with dangerous command blocking and terminal state awareness
- **Async Command Tracking**: Long-running commands auto-transition to async with polling support
- **Structured Output Parsing**: Automatic JSON parsing for common commands (git status, git log, ls -la)
- **Retry with Backoff**: Built-in `ssh-retry` tool for flaky commands with exponential/fixed backoff
- **Input Lock**: User/AI/Common mode switch prevents simultaneous input conflicts
- **Actor Tracking**: Color-coded input source markers (user/codex/claude) in the status bar
- **Auto Cleanup**: Idle timeout, graceful shutdown, no orphan processes

## Quick Start

### 1. Install

```bash
npm install -g ssh-session-mcp
```

Or from source:

```bash
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp
npm install && npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your SSH credentials
```

```ini
SSH_HOST=192.168.1.100
SSH_PORT=22
SSH_USER=username
SSH_PASSWORD=your-password
# Or use SSH_KEY=/path/to/private/key (recommended)
VIEWER_PORT=8793
AUTO_OPEN_TERMINAL=true
SSH_MCP_MODE=safe
```

### 3. Launch (for users)

```bash
npm run launch    # Start MCP + SSH + open browser terminal
npm run status    # Check server/session status
npm run kill      # Kill leftover processes
npm run cleanup   # Kill + clean state files
```

### 4. Register MCP (for AI agents)

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- node /path/to/build/index.js

# Codex CLI
codex mcp add ssh-session-mcp -- node /path/to/build/index.js
```

No need to pass SSH credentials on the command line — they are read from `.env`.

## AI Agent Usage

See [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) for the full guide.

### Core workflow

```
ssh-quick-connect → ssh-run → read output → decide → ssh-run → ...
```

### Simplified tools (recommended)

| Tool | Purpose |
|------|---------|
| `ssh-quick-connect` | Connect SSH + open browser terminal (once per conversation) |
| `ssh-run` | Execute command, return output with exit code (repeat as needed) |
| `ssh-status` | Check sessions, terminal mode, and operation mode |
| `ssh-command-status` | Poll async command progress |
| `ssh-retry` | Retry flaky commands with backoff |

### Example

```
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

## Operation Modes

The browser terminal has a **safe/full** mode selector (top-right):

| Mode | Behavior |
|------|----------|
| **safe** (default) | Blocks dangerous commands (rm -rf, mkfs), interactive programs (vim, htop), and streaming commands (tail -f). Returns suggestions for alternatives. |
| **full** | AI has full control. Only blocks extreme threats (fork bombs, dd to disk). Other dangerous commands execute with warnings. |

Switching to Full mode requires confirmation via browser dialog.

Configure via `SSH_MCP_MODE=safe|full` env var or `--mode=safe|full` flag.

## Input Lock

The browser terminal has a mode selector (top-right dropdown):

| Mode | Who can type |
|------|-------------|
| **common** (default) | Both user and AI |
| **user** | Only user. AI's `ssh-run` returns `INPUT_LOCKED` error. |
| **claude/codex** | Only AI. User keyboard input is blocked. |

The AI automatically acquires/releases the lock when calling `ssh-run`.

## All MCP Tools

### Simplified (for AI agents)

| Tool | Description |
|------|-------------|
| `ssh-quick-connect` | One-step connect + open terminal. Reuses existing sessions. |
| `ssh-run` | Execute command with intelligent completion detection. Returns exit code. |
| `ssh-status` | List active sessions, terminal mode, and operation mode. |
| `ssh-command-status` | Check status of async long-running commands. |
| `ssh-retry` | Execute command with automatic retry and backoff on failure. |

### Full control

| Tool | Description |
|------|-------------|
| `ssh-session-open` | Open session with custom parameters |
| `ssh-session-send` | Send raw input without waiting |
| `ssh-session-read` | Read output with offset-based pagination |
| `ssh-session-watch` | Long-poll for changes, render dashboard |
| `ssh-session-control` | Send control keys (Ctrl+C, arrows, etc.) |
| `ssh-session-resize` | Resize PTY window |
| `ssh-session-list` | List all sessions |
| `ssh-session-close` | Close a session |
| `ssh-viewer-ensure` | Open viewer window |
| `ssh-viewer-list` | List viewer processes |

## Configuration

### Environment variables (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `SSH_HOST` | SSH host address | (required) |
| `SSH_PORT` | SSH port | 22 |
| `SSH_USER` | SSH username | (required) |
| `SSH_PASSWORD` | SSH password | - |
| `SSH_KEY` | Path to SSH private key | - |
| `VIEWER_HOST` | Viewer server bind address | 127.0.0.1 |
| `VIEWER_PORT` | Viewer server port (0 = disabled) | 0 |
| `AUTO_OPEN_TERMINAL` | Auto-open browser on connect | false |
| `SSH_MCP_MODE` | Operation mode: safe or full | safe |
| `SSH_MCP_USE_MARKER` | Enable sentinel completion markers | true |

### Command-line parameters

All env variables can be overridden with `--` flags:

```bash
node build/index.js --host=192.168.1.100 --user=username --viewerPort=8793 --mode=full
```

## CLI Commands

```bash
npm run launch    # Start server + connect SSH + open browser
npm run status    # Check server and session status
npm run kill      # Kill process on viewer port
npm run cleanup   # Kill + remove state files
npm run build     # Compile TypeScript
npm run test      # Run unit tests
npm run inspect   # Open MCP inspector
```

## Viewer Modes

- **Terminal mode**
  - Designed to behave like a normal SSH terminal window
  - Uses raw PTY passthrough and leaves rendering to your local terminal emulator
  - Best when you want stable scrolling, shell-native behavior, and fewer local UI overlays

- **Browser mode**
  - Keeps the richer UI layer
  - Supports lock switching, safe/full mode switching, and more session-oriented controls
  - Best when user and AI need to observe and coordinate in the same page

## Security

- SSH credentials are stored in `.env` only, excluded from git and npm
- Viewer server binds to `127.0.0.1` by default (local only)
- Safe mode blocks dangerous commands by default
- No data is uploaded to external servers
- Use `SSH_KEY` instead of `SSH_PASSWORD` when possible

## License

[MIT](LICENSE)
