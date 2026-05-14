# AGENT.md

This file is the primary playbook for AI agents that need to install, inspect, configure, and operate `ssh-session-mcp` for a user.

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

## What To Inspect First

Before doing interactive SSH work, check these in order:

1. Is Node.js available and modern enough.
2. Did the user install globally, use `npx`, or clone from source.
3. Does `.env` exist.
4. Does `ssh-session-mcp.config.json` exist.
5. Is the user asking for local demo mode or real SSH access.

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
