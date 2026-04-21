# AI Agent Integration Guide

This document explains how Claude Code, Codex CLI, and similar MCP clients should use `ssh-session-mcp`.

## Core Loop

Do not generate wrapper scripts for normal SSH interaction. Use MCP tools in a short control loop:

```text
ssh-quick-connect -> ssh-run -> inspect output -> decide -> ssh-run
```

When you need lower-level control, drop to the session tools directly instead of creating extra automation layers.

## Recommended Startup

### 1. Inspect available devices

Use `ssh-device-list` first when the repo or user may have configured more than one target.

### 2. Connect or reuse

Use `ssh-quick-connect` for the common case. It can reuse an existing session and optionally ensure a viewer.

### 3. Run commands

Use `ssh-run` for most shell work. It handles locking, completion detection, exit code capture, and async handoff.

### 4. Check status when targeting is unclear

Use `ssh-status`, `ssh-session-list`, `ssh-session-set-active`, and `ssh-session-diagnostics` before guessing.

## Tool Catalog

### High-frequency tools

| Tool | When to use |
|------|-------------|
| `ssh-device-list` | Discover configured devices and defaults |
| `ssh-quick-connect` | Open or reuse the default SSH session |
| `ssh-run` | Execute one command and wait for a stable result |
| `ssh-status` | Inspect active sessions, runtime mode, and viewer status |
| `ssh-command-status` | Poll a long-running async command |
| `ssh-retry` | Retry flaky commands with fixed or exponential backoff |

### Session control tools

| Tool | When to use |
|------|-------------|
| `ssh-session-open` | Open a session with explicit connection parameters |
| `ssh-session-send` | Send raw text without waiting for completion |
| `ssh-session-read` | Read buffered terminal output by offset |
| `ssh-session-watch` | Long-poll for transcript growth and dashboard updates |
| `ssh-session-history` | Read line-numbered mixed history of output and actor events |
| `ssh-session-control` | Send control keys such as `ctrl_c`, arrows, or `tab` |
| `ssh-session-resize` | Resize the PTY window |
| `ssh-session-list` | List all tracked sessions |
| `ssh-session-diagnostics` | Inspect lock state, trim warnings, running commands, and viewer health |
| `ssh-session-set-active` | Choose the default session for tools that omit `session` |
| `ssh-session-close` | Close a session cleanly |

### Viewer tools

| Tool | When to use |
|------|-------------|
| `ssh-viewer-ensure` | Open or reuse the local viewer |
| `ssh-viewer-list` | Inspect tracked local viewer processes |

## Response Contract

Many JSON-style responses include normalized contract fields in addition to tool-specific fields:

| Field | Meaning |
|------|---------|
| `resultStatus` | `success`, `partial_success`, `blocked`, or `failure` |
| `summary` | One-line summary for humans and agents |
| `failureCategory` | Normalized failure taxonomy key when blocked or failed |
| `nextAction` | Suggested next step |
| `evidence` | Short supporting facts such as ids, ports, or session refs |

Important compatibility rule:

- Do not replace tool-specific handling with `resultStatus` alone.
- Do not assume top-level `status` has the same meaning across tools.
- Some tools keep `status` for lifecycle values such as `running` or `completed`, so use `resultStatus` for cross-tool branching.

Reference docs:

- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)

## Targeting Rules

- If a tool supports `session`, pass it explicitly when more than one session may exist.
- If you want a reusable default target, call `ssh-session-set-active`.
- If targeting is ambiguous, do not guess. Expect a blocked/failure response and resolve it first.

## Locking Rules

- `ssh-run`, `ssh-session-send`, and `ssh-session-control` must respect input locking.
- When the user lock is active, expect an `input-locked` style failure and wait.
- Do not keep sending commands if the terminal is in a password prompt, pager, or editor state.
- Check `ssh-session-diagnostics` when the shell feels inconsistent.

## Safe Usage Rules

- Prefer one command per `ssh-run` call.
- Read output before issuing the next command.
- Do not hardcode credentials into prompts, scripts, or repo files.
- Do not try to hide ambiguous session selection behind agent assumptions.
- Use `ssh-retry` instead of ad hoc retry loops when the failure pattern is understood.

## Config Awareness

Config can come from three places:

1. Explicit `--config`
2. Workspace `ssh-session-mcp.config.json`
3. User-global config plus legacy `.env`

Important config discovery rules:

- Workspace config discovery is based on the MCP server process working directory.
- A config file in another project folder will not be auto-discovered unless the process is started there.
- To use a config outside the current working directory, the operator must set `SSH_MCP_CONFIG` or start the server with `--config`.
- Device auth schema supports `auth.passwordEnv` and `auth.keyPath`.
- `auth.password` is invalid in the current schema and will fail config loading.
- If `ssh-device-list` reports `source=legacy-env`, do not assume some other config file was loaded just because it exists elsewhere on disk.

Useful commands for local operators:

```bash
npm run config -- path
npm run config -- show --scope=merged
npm run config -- device list --scope=merged
npm run validate:repo
```

## Scope Boundary

`ssh-session-mcp` is the transport/runtime layer. Device-specific build logic, ROS workflows, training pipelines, or company/project prompts should live outside this repo, typically as prompts, skills, or a companion repository.
