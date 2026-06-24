<!-- SPDX-FileCopyrightText: 2026 Zw-awa
SPDX-License-Identifier: Apache-2.0 -->

# AGENT.md

This file is the primary playbook for AI agents that need to install, inspect, configure, and operate `ssh-session-mcp` for a user.

For marketplace-style one-click installation guidance, also see [llms-install.md](llms-install.md).

## Mission

Help the user get to a stable shared terminal with the least friction possible:

1. Pick the lightest install path.
2. Verify whether the user wants a local demo or a real SSH target.
3. Launch the viewer.
4. Connect once.
5. Use MCP tools directly instead of inventing wrappers.

## Pick The Right Setup Path

### Path A: Fastest Demo

Use this when the user wants to verify the UX, the MCP loop, or the browser viewer without touching SSH.

```bash
npm install -g ssh-session-mcp
ssh-session-mcp-ctl launch --local --viewerPort=auto
```

### Path B: Existing SSH Credentials In `.env`

Use this when the user has one target and does not need multi-device config yet.

```bash
npm install -g ssh-session-mcp
cp .env.example .env
ssh-session-mcp-ctl launch --viewerPort=auto
```

### Path C: Multiple Devices Or Teams

Use this when the user has more than one board, host, or named connection.

1. Create `ssh-session-mcp.config.json`.
2. Put secrets in `.env` using `auth.passwordEnv` or use `auth.keyPath`.
3. Launch with `ssh-session-mcp-ctl launch --viewerPort=auto`.

### Path D: MCP Client Registration

Use this when the user already understands the operator side and wants the AI connected through stdio MCP.

```bash
ssh-session-mcp --viewerPort=auto
```

Examples:

```bash
claude mcp add --transport stdio ssh-session-mcp -- ssh-session-mcp --viewerPort=auto
codex mcp add ssh-session-mcp -- ssh-session-mcp --viewerPort=auto
```

### Path E: Containerized MCP Runtime

Use this when the operator explicitly wants image-based distribution or a pinned container runtime.

```bash
docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

## What To Inspect First

Before doing interactive SSH work, check these in order:

1. Is Node.js available and modern enough.
2. Did the user install globally, use `npx`, or clone from source.
3. Does `.env` exist.
4. Does `ssh-session-mcp.config.json` exist.
5. Is the user asking for local demo mode or real SSH access.

## Required User Confirmations

Before you install or launch anything automatically, confirm these settings with the user:

| Question | Why it matters | Typical answers |
|----------|----------------|-----------------|
| Which install path do you want? | Decides whether to use `npx`, global npm, or Docker. | `npx`, global npm, Docker |
| Is this a local demo or a real SSH target? | Determines whether to set `SSH_MCP_LOCAL=true` or ask for real SSH settings. | local demo, real SSH |
| Do you want legacy `.env` mode or profile-based config? | Determines whether to ask for `SSH_HOST` / `SSH_USER` or for `ssh-session-mcp.config.json`. | `.env`, profile config |
| If using legacy mode, what are `SSH_HOST`, `SSH_PORT`, and `SSH_USER`? | Minimum SSH connection tuple. | host, port, user |
| If using auth, do you want `SSH_PASSWORD` or `SSH_KEY` / `auth.keyPath`? | Avoid guessing auth mode and avoid putting secrets in tracked JSON. | password, key |
| If using profile mode, where is `ssh-session-mcp.config.json`? | Needed when config is not in the current workspace. | workspace path, external path |
| Which env vars referenced by config need to be exported? | `passwordEnv` values must exist before launch. | `DEVICE_A_PASSWORD`, `BOARD_B_PASSWORD` |
| Do you want the browser viewer enabled, and on what port? | Needed for `VIEWER_PORT` and operator expectations. | `auto`, `8793`, `0` |
| If using Docker, what image tag and optional `SSH_SESSION_MCP_IMAGE` should be used? | Avoid pulling the wrong image or tag. | `zwawa/ssh-session-mcp:latest`, version tag |
| If using Docker with key auth, what should `SSH_KEY_DIR` be? | Prevents accidental repo-root mounting and clarifies key source. | external key directory, `./keys` |
| Do you want `safe` or `full` mode? | Affects command blocking behavior. | `safe`, `full` |
| Do you want multiple agent/client instances isolated? | Determines whether `SSH_MCP_INSTANCE` must be set explicitly. | default, custom instance id |

If the user cannot answer these yet, pause installation and help them decide instead of inventing values.

## Required Macro / Env Checklist

When the agent prepares installation, collect or verify these variables as applicable:

- Local demo: `SSH_MCP_LOCAL`, `VIEWER_PORT`
- Legacy SSH + password: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`
- Legacy SSH + key: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`
- Profile mode: `SSH_MCP_CONFIG`, plus all `passwordEnv` variables referenced by `ssh-session-mcp.config.json`
- Docker profile mode: `SSH_SESSION_MCP_IMAGE`, optional `SSH_KEY_DIR`, `VIEWER_PORT`, `VIEWER_HOST`
- Optional runtime controls: `SSH_MCP_MODE`, `AUTO_OPEN_TERMINAL`, `SSH_MCP_INSTANCE`, `SSH_MCP_LOG_MODE`

## Operator Commands

Use these commands when you are helping the human on the workstation:

```bash
ssh-session-mcp-ctl status
ssh-session-mcp-ctl devices
ssh-session-mcp-ctl launch --viewerPort=auto
ssh-session-mcp-ctl launch --local --viewerPort=auto
ssh-session-mcp-ctl logs --tail=80
ssh-session-mcp-ctl cleanup
```

Repo-local equivalents:

```bash
npm run status
npm run devices
npm run launch
npm run logs
npm run cleanup
```

## MCP Tool Loop

Preferred agent loop:

```text
ssh-device-list -> ssh-quick-connect -> ssh-run -> inspect -> ssh-command-status if async -> ssh-run
```

Do not jump to raw PTY tools unless the normal loop is insufficient.

## High-Frequency MCP Tools

| Tool | Use |
|------|-----|
| `ssh-device-list` | Inspect configured targets |
| `ssh-quick-connect` | Connect or reuse the common target |
| `ssh-run` | Main command execution path |
| `ssh-status` | Inspect sessions, viewer state, and mode |
| `ssh-command-status` | Poll long-running commands |
| `ssh-retry` | Retry known-flaky commands |
| `ssh-session-policy-list` | Inspect inherited defaults and current session custom rules |
| `ssh-session-policy-upsert` | Add or update a session-level custom policy rule |
| `ssh-session-policy-remove` | Remove a session-level custom policy rule |
| `ssh-session-policy-reset` | Reset the session rule set back to inherited defaults |

## Full MCP Tool Catalog

| Tool | Use |
|------|-----|
| `ssh-session-open` | Explicit SSH session creation |
| `ssh-session-send` | Raw input |
| `ssh-device-list` | Device listing |
| `ssh-session-read` | Output reads |
| `ssh-session-watch` | Long-poll watch |
| `ssh-session-history` | Mixed history inspection |
| `ssh-session-control` | Send control keys |
| `ssh-session-resize` | PTY resize |
| `ssh-session-list` | Session listing |
| `ssh-session-diagnostics` | Terminal mode, warnings, running command, viewer health |
| `ssh-session-policy-list` | Inspect inherited defaults and current session policy rules |
| `ssh-session-policy-upsert` | Add or update a session-level custom rule |
| `ssh-session-policy-remove` | Remove a session-level custom rule |
| `ssh-session-policy-reset` | Restore inherited rules for the current session |
| `ssh-session-set-active` | Default-target selection |
| `ssh-viewer-ensure` | Open viewer |
| `ssh-viewer-list` | Inspect viewer processes |
| `ssh-session-close` | Close session |
| `ssh-quick-connect` | Recommended connection path |
| `ssh-run` | Recommended execution path |
| `ssh-status` | Runtime overview |
| `ssh-command-status` | Async polling |
| `ssh-retry` | Retry policy |

## Installation Help Rules

- Prefer `npm install -g ssh-session-mcp` for human operators.
- Prefer `npx -y ssh-session-mcp --viewerPort=auto` when the user does not want a global install.
- Prefer the published Docker Hub image when the user explicitly asks for Docker or containerized distribution.
- Prefer `ssh-session-mcp-ctl launch --local --viewerPort=auto` for demos and debugging.
- Do not tell the user to put passwords in `ssh-session-mcp.config.json`.
- Do not assume a config file in another workspace will be auto-discovered.

## Safe Behavior Rules

- If the terminal is user-locked, wait.
- If the terminal is at a password prompt, do not send more commands blindly.
- If the shell is in a pager or editor, use `ssh-session-diagnostics` and recover intentionally.
- If more than one session exists, use `ssh-session-set-active` or pass `session` explicitly.
- Prefer one command per `ssh-run`.

## Failure Triage

### No Devices Listed

- Check `ssh-device-list`.
- If `source=legacy-env`, the config file was not loaded.
- Confirm working directory, `SSH_MCP_CONFIG`, or `--config`.

### Viewer Does Not Open

- Check `ssh-status`.
- Check whether `VIEWER_PORT` is `0`.
- Relaunch with `--viewerPort=auto`.

### Commands Feel Stuck

- Check `ssh-command-status`.
- Check `ssh-session-diagnostics`.
- Check whether the user took the lock.

### User Wants To Abort A Long Command

- Prefer `ssh-session-control` with `ctrl_c`.
- Then inspect with `ssh-session-read` or `ssh-command-status`.

## Important Config Rules

- Config discovery order is `--config`, workspace config, user-global config, then legacy `.env`.
- `auth.passwordEnv` and `auth.keyPath` are valid device auth fields.
- `auth.password` is invalid.
- Viewer bind host defaults to `127.0.0.1`.
- Runtime state is isolated by `SSH_MCP_INSTANCE`.

## References

- [README.md](README.md)
- [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)
- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
- [docs/platform-compatibility.md](docs/platform-compatibility.md)
- [docs/examples/ssh-session-mcp.config.example.json](docs/examples/ssh-session-mcp.config.example.json)
