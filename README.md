# ssh-session-mcp

[中文](README.zh-CN.md) | **English**

[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

`ssh-session-mcp` is a persistent SSH PTY session manager for MCP clients. It gives the user and the AI the same terminal session, adds a browser viewer, tracks who typed what, and keeps long-running SSH work manageable instead of stateless.

![ssh-session-mcp hero demo](https://raw.githubusercontent.com/Zw-awa/ssh-session-mcp/main/site/assets/hero-loop.gif)

## Why It Exists

Most SSH-oriented MCP servers can execute commands, but they do not manage terminal state well enough for real collaboration.

`ssh-session-mcp` focuses on the missing runtime layer:

- One shared PTY for both the human and the AI
- Browser terminal for live inspection and manual intervention
- Input lock so the AI does not type over the user
- Safe/full execution modes for risky commands
- Async command tracking for long-running remote work
- Multi-device and multi-connection profile support
- Local debug mode for demos, offline testing, and prompt iteration

## Best Fit

- AI-assisted remote development on Linux boards and SSH servers
- Embedded, ROS, training, and deployment hosts that need a real terminal
- Users who want the AI to help, but do not want to surrender the terminal
- MCP Marketplace listings where the install and demo path must be clear

## Quick Start

### 1. Fastest Local Demo

```bash
npm install -g ssh-session-mcp
ssh-session-mcp-ctl launch --local --viewerPort=auto
```

This starts a local shell instead of SSH and opens the browser terminal, which is the easiest way to test the MCP runtime before touching a real server.

### 2. Register As An MCP Server

Use the MCP server binary directly when wiring a client:

```bash
# Global install
npm install -g ssh-session-mcp

# Server command used by MCP clients
ssh-session-mcp --viewerPort=auto
```

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- ssh-session-mcp --viewerPort=auto

# Codex CLI
codex mcp add ssh-session-mcp -- ssh-session-mcp --viewerPort=auto
```

If you prefer `npx` instead of a global install:

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

### 3. Connect To A Real SSH Target

Create `.env` from `.env.example`:

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

Then launch:

```bash
ssh-session-mcp-ctl launch --viewerPort=auto
```

### 4. Multi-Device Config

For multiple boards or named targets, create `ssh-session-mcp.config.json`:

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

Discovery order:

1. `--config=/path/to/config.json`
2. Workspace `ssh-session-mcp.config.json`
3. User-global config
4. Legacy `.env` fallback

Important:

- Config discovery is based on the MCP process working directory.
- `auth.password` is intentionally unsupported. Use `auth.passwordEnv` or `auth.keyPath`.
- Secrets belong in `.env` or the parent environment, not in repo-tracked JSON.

## Viewer And Collaboration Model

The browser viewer is not decorative. It is part of the workflow:

- The user can see exactly what the AI did.
- The AI can pause when the user takes over.
- Password prompts, pagers, and editors become visible state instead of hidden failure modes.
- Session diagnostics and history turn terminal debugging into something inspectable.

## Marketplace-Friendly Flow

For users:

```text
install -> launch viewer -> connect once -> keep the session alive -> let the AI help
```

For agents:

```text
ssh-quick-connect -> ssh-run -> inspect output -> ssh-command-status if needed -> ssh-run again
```

Use [AGENT.md](AGENT.md) when you want the AI to install, inspect config, connect devices, and help the user end-to-end. Compatibility notes for older agent setups remain in [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md).

## Core Differences From A Stateless MCP SSH Wrapper

- Shared PTY instead of one-off command execution
- Actor-aware transcript markers for user, system, and agent input
- Terminal-state checks before dangerous or nonsensical writes
- Auto cleanup for sessions and viewer processes
- Session-scoped browser viewer with diagnostics and history
- Local debug mode with `--local` for offline testing

## Operation Modes

| Mode | Behavior |
|------|----------|
| `safe` | Default. Blocks obviously dangerous, interactive, or streaming commands when they are a poor fit for autonomous execution. |
| `full` | Allows broader control and warns less, while still blocking extreme cases such as obvious destructive abuse. |

## Input Lock

| Mode | Who can type |
|------|-------------|
| `common` | User and AI |
| `user` | Only the user |
| `claude` / `codex` | Only the selected agent |

If the terminal is locked by the user, `ssh-run`, `ssh-session-send`, and `ssh-session-control` return a blocked response instead of forcing input into the PTY.

## MCP Tools

### Recommended Daily Tools

| Tool | Purpose |
|------|---------|
| `ssh-quick-connect` | Connect or reuse the default target and optionally open the viewer |
| `ssh-run` | Execute a command with completion detection and exit-code capture |
| `ssh-status` | Inspect sessions, viewer state, and operation mode |
| `ssh-command-status` | Poll async command progress |
| `ssh-retry` | Retry flaky commands with backoff |

### Full Tool Catalog

| Tool | Purpose |
|------|---------|
| `ssh-session-open` | Open a session with explicit SSH parameters |
| `ssh-session-send` | Send raw PTY input |
| `ssh-device-list` | List configured devices and defaults |
| `ssh-session-read` | Read buffered terminal output by offset |
| `ssh-session-watch` | Long-poll for output and dashboard changes |
| `ssh-session-history` | Read line-numbered mixed terminal history |
| `ssh-session-control` | Send control keys such as `ctrl_c`, arrows, or `tab` |
| `ssh-session-resize` | Resize the PTY |
| `ssh-session-list` | List tracked sessions |
| `ssh-session-diagnostics` | Inspect lock state, warnings, running command state, and viewer health |
| `ssh-session-set-active` | Choose the default session |
| `ssh-viewer-ensure` | Open or reuse the local viewer |
| `ssh-viewer-list` | List tracked viewer processes |
| `ssh-session-close` | Close a session cleanly |
| `ssh-quick-connect` | One-step connect flow for agents |
| `ssh-run` | Main command execution tool |
| `ssh-status` | Runtime overview |
| `ssh-command-status` | Async poller |
| `ssh-retry` | Retry executor |

## Local Operator Commands

These helpers are for humans on the workstation that owns the viewer:

```bash
ssh-session-mcp-ctl status
ssh-session-mcp-ctl devices
ssh-session-mcp-ctl launch --viewerPort=auto
ssh-session-mcp-ctl launch --local --viewerPort=auto
ssh-session-mcp-ctl logs --tail=60
ssh-session-mcp-ctl cleanup
```

Equivalent repo-local commands also exist:

```bash
npm run launch
npm run status
npm run devices
npm run logs
npm run cleanup
```

## Configuration Summary

Key environment variables:

| Variable | Meaning | Default |
|----------|---------|---------|
| `SSH_HOST` | Legacy single-target SSH host | required in legacy mode |
| `SSH_PORT` | Legacy single-target SSH port | `22` |
| `SSH_USER` | Legacy single-target SSH user | required in legacy mode |
| `SSH_PASSWORD` | Password auth | empty |
| `SSH_KEY` | Local private key path | empty |
| `SSH_MCP_INSTANCE` | Runtime isolation key | `proc-<pid>` or helper-selected |
| `SSH_MCP_CONFIG` | Explicit config file path | auto-discovery |
| `VIEWER_HOST` | Viewer bind host | `127.0.0.1` |
| `VIEWER_PORT` | Viewer port or `auto` | `0` unless configured |
| `SSH_MCP_MODE` | `safe` or `full` | `safe` |
| `SSH_MCP_LOCAL` | Launch a local shell instead of SSH | `false` |
| `SSH_MCP_DEBUG` | Enable debug browser actions | `false` |
| `AUTO_OPEN_TERMINAL` | Auto-open browser terminal | `false` |
| `SSH_MCP_LOG_MODE` | `off` or `meta` JSONL logging | `off` |

Example config file: [docs/examples/ssh-session-mcp.config.example.json](docs/examples/ssh-session-mcp.config.example.json)

## Security

- The package never requires raw passwords inside tracked JSON config.
- `.env` is ignored by git and npm.
- Viewer HTTP binds to localhost by default.
- The MCP server treats terminal mode and input lock as first-class safety signals.

See [SECURITY.md](SECURITY.md) for the full policy.

## Platform Notes

- Windows 10/11: first-class host environment
- Linux: strong fit for headless MCP + browser viewer workflows
- macOS: standard Node.js path supported
- Remote Linux hosts: first-class target

More detail: [docs/platform-compatibility.md](docs/platform-compatibility.md)

## Docs

- [AGENT.md](AGENT.md)
- [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)
- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md)
- [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
npm install
npm run build
npm run test
npm run validate:repo
npm run build:site
```

GitHub Actions included in this repo can:

- run CI on push and pull request
- deploy a GitHub Pages landing page from `dist/`
- build a tagged GitHub Release with the npm package tarball attached

## License

Apache-2.0. See [LICENSE](LICENSE).
