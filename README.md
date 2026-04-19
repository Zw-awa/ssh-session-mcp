# ssh-session-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)

Persistent SSH PTY session manager for MCP clients. Users and AI agents share one SSH terminal — AI sends commands via MCP tools, users type in the browser terminal, input sources are visually distinguished.

## Features

- **Shared SSH Terminal**: One PTY, shared by user and AI, with input lock to prevent conflicts
- **xterm.js Browser Terminal**: Real terminal emulator in the browser (not a text dashboard)
- **WebSocket Real-time**: Binary PTY output streamed via WebSocket, no polling
- **Input Lock**: User/AI mode switch prevents simultaneous input conflicts
- **Actor Tracking**: Color-coded input source markers (user/codex/claude) in the status bar
- **Simplified AI Tools**: `ssh-quick-connect` + `ssh-run` — two tools cover most use cases
- **Auto Session Reuse**: AI calls `ssh-quick-connect` once, subsequent calls reuse the session
- **Auto Cleanup**: Idle timeout, graceful shutdown, no orphan processes

## Quick Start

### 1. Install

```bash
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp
npm install && npm run build
```

Or from npm:

```bash
npm install -g ssh-session-mcp
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
| `ssh-run` | Execute command, return output (repeat as needed) |
| `ssh-status` | Check if sessions are running |

### Example

```
AI: ssh-quick-connect()
AI: "Connected. Terminal at http://127.0.0.1:8793/terminal/session/..."

AI: ssh-run({ command: "uname -a" })
AI: "Linux board 5.10.160-rockchip-rk3588 aarch64"

AI: ssh-run({ command: "df -h /" })
AI: "34% used (19G of 56G)"
```

## Input Lock

The browser terminal has a mode selector (top-right dropdown):

- **user**: You can type. AI's `ssh-run` is blocked and returns an error.
- **claude/codex**: AI can send commands. Your keyboard input is blocked, status bar shows "AI active".

The AI automatically acquires/releases the lock when calling `ssh-run`. Only the user can switch modes via the browser UI.

## All MCP Tools

### Simplified (for AI agents)

| Tool | Description |
|------|-------------|
| `ssh-quick-connect` | One-step connect + open terminal. Reuses existing sessions. |
| `ssh-run` | Execute command, wait for output, return it. Auto-locks. |
| `ssh-status` | List active sessions and terminal URLs. |

### Full control

| Tool | Description |
|------|-------------|
| `ssh-session-open` | Open session with custom parameters |
| `ssh-session-send` | Send raw input without waiting |
| `ssh-session-read` | Read output without sending |
| `ssh-session-watch` | Long-poll for changes, render dashboard |
| `ssh-session-control` | Send control keys (Ctrl+C, arrows, etc.) |
| `ssh-session-resize` | Resize PTY window |
| `ssh-session-list` | List all sessions |
| `ssh-session-close` | Close a session |
| `ssh-viewer-ensure` | Open viewer window |
| `ssh-viewer-list` | List viewer processes |

## Configuration

### Environment variables (.env)

| Variable | Description |
|----------|-------------|
| `SSH_HOST` | SSH host address |
| `SSH_PORT` | SSH port (default: 22) |
| `SSH_USER` | SSH username |
| `SSH_PASSWORD` | SSH password |
| `SSH_KEY` | Path to SSH private key (recommended over password) |
| `VIEWER_HOST` | Viewer server bind address (default: 127.0.0.1) |
| `VIEWER_PORT` | Viewer server port (default: 0 = disabled) |
| `AUTO_OPEN_TERMINAL` | Auto-open browser terminal on session open (default: false) |

### Command-line parameters

All `.env` variables can be overridden with `--` flags:

```bash
node build/index.js -- --host=192.168.1.100 --user=username --viewerPort=8793
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

## Development

```bash
npm run build          # Compile
npm test               # Unit tests
npm run test:watch     # Watch mode
npm run coverage       # Coverage report
npm run inspect        # MCP inspector
```

## Security

- SSH credentials are stored in `.env` only, excluded from git and npm
- Viewer server binds to `127.0.0.1` by default (local only)
- No data is uploaded to external servers
- Use `SSH_KEY` instead of `SSH_PASSWORD` when possible

## License

[MIT](LICENSE)
