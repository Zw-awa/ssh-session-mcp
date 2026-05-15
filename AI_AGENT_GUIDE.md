# AI Agent Integration Guide

`AGENT.md` is the main operator playbook for AI tools. This file stays as the compatibility guide for agents and workflows that already look for `AI_AGENT_GUIDE.md`.

See [AGENT.md](AGENT.md) first.

## Default Loop

Use the MCP tools directly:

```text
ssh-quick-connect -> ssh-run -> inspect -> ssh-command-status if async -> ssh-run
```

Do not build wrapper scripts for normal terminal work unless the human explicitly wants automation outside MCP.

## Install And Startup Hints

- Prefer `ssh-session-mcp-ctl launch --local --viewerPort=auto` for a no-SSH demo.
- Prefer `ssh-session-mcp-ctl launch --viewerPort=auto` for an operator who already configured `.env` or `ssh-session-mcp.config.json`.
- If you are wiring an MCP client, run `ssh-session-mcp --viewerPort=auto`.
- If config may be ambiguous, check `ssh-device-list` before opening a session.

## High-Frequency Tools

| Tool | Use |
|------|-----|
| `ssh-device-list` | Discover configured devices and defaults |
| `ssh-quick-connect` | Open or reuse the common target |
| `ssh-run` | Main command execution tool |
| `ssh-status` | Inspect runtime state |
| `ssh-command-status` | Poll async commands |
| `ssh-retry` | Retry flaky commands |
| `ssh-session-policy-list` | Inspect inherited defaults and current session custom rules |
| `ssh-session-policy-upsert` | Add or update a session-specific custom rule |
| `ssh-session-policy-remove` | Remove a session-specific custom rule |
| `ssh-session-policy-reset` | Reset session rules back to inherited defaults |

## Full Tool Catalog

| Tool | Use |
|------|-----|
| `ssh-session-open` | Explicit session creation |
| `ssh-session-send` | Raw text send |
| `ssh-device-list` | Device discovery |
| `ssh-session-read` | Offset-based output reads |
| `ssh-session-watch` | Long-poll and dashboard updates |
| `ssh-session-history` | Mixed transcript history |
| `ssh-session-control` | `ctrl_c`, arrows, `tab`, and similar control input |
| `ssh-session-resize` | PTY resize |
| `ssh-session-list` | Session listing |
| `ssh-session-diagnostics` | Lock state, warnings, running command, viewer health |
| `ssh-session-policy-list` | Inspect the active custom rule set and inherited defaults |
| `ssh-session-policy-upsert` | Add or update a session-level custom rule |
| `ssh-session-policy-remove` | Remove a session-level custom rule |
| `ssh-session-policy-reset` | Restore inherited rules for the session |
| `ssh-session-set-active` | Default-target selection |
| `ssh-viewer-ensure` | Open or reuse viewer |
| `ssh-viewer-list` | Viewer process inspection |
| `ssh-session-close` | Close session |
| `ssh-quick-connect` | Recommended connect path |
| `ssh-run` | Recommended run path |
| `ssh-status` | Runtime overview |
| `ssh-command-status` | Async poll path |
| `ssh-retry` | Controlled retry path |

## Operational Rules

- When more than one session exists, do not guess. Use `ssh-status`, `ssh-session-list`, or `ssh-session-set-active`.
- When the terminal is locked by the user, wait instead of forcing input with `ssh-run`, `ssh-session-send`, or `ssh-session-control`.
- If the shell appears to be in a password prompt, pager, or editor, stop and inspect with `ssh-session-diagnostics`.
- Prefer one command per `ssh-run`.
- Keep secrets in `.env` or external environment variables, never in prompts or tracked JSON.

## Response Contract

Cross-tool branching should use normalized fields such as `resultStatus`, `failureCategory`, `summary`, `nextAction`, and `evidence`, but should still respect tool-specific fields like async `status`.

Reference:

- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
