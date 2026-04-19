# AI Agent Integration Guide

This document explains how AI agents (Claude Code, Codex CLI, etc.) should use ssh-session-mcp correctly.

## Core Principle

**Do NOT write scripts.** Use MCP tools interactively in a loop:

```
ssh-quick-connect → ssh-run → read output → decide → ssh-run → ...
```

## Quick Start (for AI agents)

### Step 1: Connect (once per conversation)

Call `ssh-quick-connect`. If a session already exists, it will be reused automatically.

```json
{ "name": "ssh-quick-connect" }
```

This returns a `terminalUrl` — tell the user to open it in their browser so they can watch.

### Step 2: Run commands (repeat as needed)

Call `ssh-run` with the command you want to execute:

```json
{ "name": "ssh-run", "arguments": { "command": "hostname -I" } }
```

The tool sends the command, waits for output, and returns it. Read the output, decide what to do next, then call `ssh-run` again.

### Step 3: Check status (if unsure)

Call `ssh-status` to see if sessions are running:

```json
{ "name": "ssh-status" }
```

## Input Lock Mechanism

The terminal has an input lock to prevent user and AI from typing simultaneously.

- When AI calls `ssh-run`, it automatically acquires the `agent` lock, sends the command, reads output, then releases the lock.
- When the lock is `agent`, the browser terminal blocks user keyboard input and shows "AI active".
- The user can switch to `user` mode in the browser (dropdown selector) to take control. When locked to `user`, `ssh-run` returns an error telling the AI to wait.
- The user switches back to `claude`/`codex` mode to let AI resume.

**AI agents cannot change the lock.** Only the user can switch modes via the browser UI. The AI should respect `INPUT_LOCKED` errors and inform the user.

## Tool Reference

| Tool | Purpose | When to use |
|------|---------|-------------|
| `ssh-quick-connect` | Connect SSH + open terminal | Once at start of conversation |
| `ssh-run` | Execute command, return output | Every time you need to run something |
| `ssh-status` | Check active sessions | When unsure if connected |
| `ssh-session-close` | Close a session | When done with the session |

## Advanced Tools (rarely needed)

These exist for fine-grained control but `ssh-run` covers most use cases:

| Tool | Purpose |
|------|---------|
| `ssh-session-open` | Open session with custom parameters |
| `ssh-session-send` | Send raw input without waiting |
| `ssh-session-read` | Read output without sending |
| `ssh-session-watch` | Long-poll for changes |
| `ssh-session-control` | Send control keys (Ctrl+C, etc.) |
| `ssh-session-resize` | Resize PTY |
| `ssh-viewer-ensure` | Open viewer window |
| `ssh-viewer-list` | List viewer processes |
| `ssh-session-list` | List all sessions |

## Anti-Patterns (DO NOT do these)

1. **Do NOT write .mjs/.js scripts** to automate SSH interaction. Use `ssh-run` directly.
2. **Do NOT hardcode SSH credentials** in any file. They belong in `.env` only.
3. **Do NOT send multiple commands** without reading output between them. Always: send → read → decide → send.
4. **Do NOT ignore `INPUT_LOCKED` errors.** Tell the user to switch to agent mode.
5. **Do NOT try to run interactive TUI programs** (vim, htop, claude) via `ssh-run`. Use `ssh-session-send` for those and read output with `ssh-session-read`.

## Example Conversation Flow

```
AI: [calls ssh-quick-connect]
AI: "I've connected to the board. Terminal is at http://127.0.0.1:8793/terminal/session/..."

AI: [calls ssh-run { command: "uname -a" }]
AI: "The board is running Linux 5.10.160-rockchip-rk3588 on aarch64."

AI: [calls ssh-run { command: "df -h /" }]
AI: "Root partition is 34% used (19G of 56G)."

User: "Check what Python version is installed"
AI: [calls ssh-run { command: "python3 --version" }]
AI: "Python 3.10.12"
```
