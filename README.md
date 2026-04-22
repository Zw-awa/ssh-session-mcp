# ssh-session-mcp

中文文档: [简体中文](README.zh-CN.md)

[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

Persistent SSH PTY session manager for MCP clients. Users and AI agents share one SSH terminal — AI sends commands via MCP tools, users type in the browser terminal, input sources are visually distinguished.

## Features

- **Shared SSH Terminal**: One PTY, shared by user and AI, with input lock to prevent conflicts
- **Multi-device / Multi-connection**: One MCP instance can manage multiple device profiles, and each device can keep multiple named SSH connections
- **Per-AI isolation by instance**: Run separate stdio MCP processes with different `SSH_MCP_INSTANCE` values so multiple AI agents do not interfere with each other
- **Terminal / Browser split**: Terminal mode is raw PTY passthrough; browser mode provides richer controls and status UI
- **xterm.js Browser Terminal**: Real terminal emulator in the browser with WebSocket streaming
- **Intelligent Command Completion**: Prompt detection + idle timeout + deterministic sentinel markers for reliable output capture
- **Safety Modes**: Safe/Full operation modes with dangerous command blocking and terminal state awareness
- **Async Command Tracking**: Long-running commands auto-transition to async with polling support
- **Structured Output Parsing**: Automatic JSON parsing for common commands (git status, git log, ls -la)
- **Retry with Backoff**: Built-in `ssh-retry` tool for flaky commands with exponential/fixed backoff
- **Session Diagnostics**: `ssh-session-diagnostics` reports terminal mode, lock state, viewer state, running command metadata, and buffer trim warnings
- **Line History Recall**: `ssh-session-history` provides line-numbered history across SSH output, agent input, user input, and lifecycle events
- **File-Only Meta Logging**: Optional JSONL logs record session/viewer/command metadata locally without writing transcripts to MCP stdio
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
VIEWER_PORT=auto
AUTO_OPEN_TERMINAL=false
SSH_MCP_MODE=safe
```

Optional multi-device config:

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

Save it as `ssh-session-mcp.config.json` in the repo root, or pass `--config=/path/to/config.json`.

Important:

- Auto-discovery is based on the MCP process working directory, not on arbitrary project folders elsewhere on disk.
- If the MCP process is started in `E:\\XSmartcar\\tools\\ssh-mcp`, then `E:\\other-project\\ssh-session-mcp.config.json` will not be discovered automatically.
- For a config file outside the current working directory, set `SSH_MCP_CONFIG=/path/to/config.json` or start the server with `--config=/path/to/config.json`.
- Device auth currently supports only `auth.passwordEnv` and `auth.keyPath`.
- Raw inline passwords such as `"auth": { "password": "secret" }` are invalid and will fail schema validation.
- When using `passwordEnv`, put the real secret in `.env` or the parent process environment, for example `BOARD_A_PASSWORD=orangepi`.

Config resolution order:

1. Explicit `--config=/path/to/config.json`
2. Workspace `ssh-session-mcp.config.json`
3. User-global config at the platform default location
4. Legacy `.env` single-device fallback

This means a config file stored in another workspace is ignored unless you point to it explicitly with `SSH_MCP_CONFIG` or `--config`.

Manage config from the compiled CLI:

```bash
npm run config -- path
npm run config -- show --scope=merged
npm run config -- device list --scope=merged
npm run config -- device set board-a --host=192.168.10.58 --user=orangepi --password-env=BOARD_A_PASSWORD
npm run config -- defaults set viewerPort auto
```

### 3. Launch (for users)

```bash
npm run launch    # Start MCP + SSH + open browser terminal
npm run status    # Check server/session status
npm run devices   # List configured device profiles
npm run kill      # Kill leftover processes
npm run cleanup   # Kill + clean state files
npm run logs      # View local JSONL metadata logs
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
| `ssh-device-list` | List configured device profiles and defaults |
| `ssh-run` | Execute command, return output with exit code (repeat as needed) |
| `ssh-status` | Check sessions, terminal mode, and operation mode |
| `ssh-session-set-active` | Switch the active session used when `session` is omitted |
| `ssh-session-diagnostics` | Inspect lock state, viewer state, running command metadata, and trim warnings |
| `ssh-session-history` | Read line-numbered mixed history of output and user/agent actions |
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
| `ssh-session-history` | Read line-numbered history snapshots |
| `ssh-session-watch` | Long-poll for changes, render dashboard |
| `ssh-session-control` | Send control keys (Ctrl+C, arrows, etc.) |
| `ssh-session-resize` | Resize PTY window |
| `ssh-session-list` | List all sessions |
| `ssh-device-list` | List configured device profiles |
| `ssh-session-set-active` | Set or clear the active session |
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
| `SSH_MCP_INSTANCE` | Instance id for per-AI runtime isolation | auto (`proc-<pid>`) |
| `SSH_MCP_CONFIG` | Path to `ssh-session-mcp.config.json` | auto-discovery |
| `VIEWER_HOST` | Viewer server bind address | 127.0.0.1 |
| `VIEWER_PORT` | Viewer server port (`0` = disabled, `auto` = random free port) | `0` |
| `AUTO_OPEN_TERMINAL` | Auto-open browser on connect | false |
| `SSH_MCP_MODE` | Operation mode: safe or full | safe |
| `SSH_MCP_USE_MARKER` | Enable sentinel completion markers | true |
| `SSH_MCP_LOG_MODE` | Local log mode: `off` or `meta` | `off` |
| `SSH_MCP_LOG_DIR` | Local JSONL log directory | per-instance runtime dir |

### Command-line parameters

All env variables can be overridden with `--` flags:

```bash
node build/index.js --host=192.168.1.100 --user=username --viewerPort=8793 --mode=full
```

### Config files

- Workspace config: `./ssh-session-mcp.config.json`
- User-global config:
  - Windows: `%APPDATA%\\ssh-session-mcp\\config.json`
  - Linux/macOS: `$XDG_CONFIG_HOME/ssh-session-mcp/config.json` or `~/.config/ssh-session-mcp/config.json`
- Explicit config: `SSH_MCP_CONFIG=/path/to/config.json` or `--config=/path/to/config.json`

Config files support top-level `defaults`, `defaultDevice`, and `devices`. A workspace config replaces matching devices from the global config by `id`, while top-level `defaults` are shallow-merged.

Discovery rule:

- The workspace config path is always resolved from the current MCP process working directory.
- A file in some other directory is not auto-discovered just because it exists on the machine.
- If you want to reuse a config from another project folder, pass it explicitly with `SSH_MCP_CONFIG` or `--config`.

Auth schema rule:

- Supported: `auth.passwordEnv`, `auth.keyPath`
- Not supported: `auth.password`
- Recommended password pattern:

```json
{
  "auth": {
    "passwordEnv": "BOARD_A_PASSWORD"
  }
}
```

```ini
BOARD_A_PASSWORD=orangepi
```

Reference example: [docs/examples/ssh-session-mcp.config.example.json](docs/examples/ssh-session-mcp.config.example.json)

## Tool Response Contract

Structured tool responses may include these extra top-level fields:

| Field | Meaning |
|------|---------|
| `resultStatus` | Normalized outcome: `success`, `partial_success`, `blocked`, `failure` |
| `summary` | Short human/agent readable summary |
| `failureCategory` | Normalized failure type when blocked or failed |
| `nextAction` | Suggested next step |
| `evidence` | Short supporting facts |

Compatibility note:

- Existing tool payloads remain compatible.
- `resultStatus` is the cross-tool decision field.
- Top-level `status` is still used by some tools for lifecycle values such as `running` or `completed`.

Reference docs:

- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)

## CLI Commands

```bash
npm run launch    # Start server + connect SSH + open browser
npm run config -- show --scope=merged
npm run status    # Check server and session status
npm run devices   # List configured device profiles
npm run kill      # Kill process on viewer port
npm run cleanup   # Kill + remove state files
npm run logs      # Inspect local server/session JSONL logs
npm run validate:repo  # Validate repo docs/config contract coverage
npm run build     # Compile TypeScript
npm run test      # Run unit tests
npm run inspect   # Open MCP inspector
```

Useful flags:

```bash
node scripts/ctl.mjs launch --instance=codex-a --device=board-a --connection=main
node scripts/ctl.mjs status --instance=codex-a
node scripts/ctl.mjs logs --instance=codex-a --session=board-a/main
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

## Docs and Validation

- [docs/contracts.md](docs/contracts.md): normalized tool response fields
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md): stable failure categories
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md): regression checklist for the current architecture
- [docs/platform-compatibility.md](docs/platform-compatibility.md): host/target/runtime support notes
- `npm run validate:repo`: checks required docs, example config validity, acceptance scenario ids, `.env.example`, and MCP tool coverage in docs

## Scope Boundary

This repository stays focused on the SSH transport/runtime layer: sessions, viewers, targeting, locks, logging, and tool contracts. Project-specific prompts, ROS workflows, board-role logic, model pipelines, and higher-level agent skills should live outside this repo.

## License

This repository is licensed under the [Apache License 2.0](LICENSE).

See also [NOTICE](NOTICE) for project attribution metadata.
