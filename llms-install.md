# SSH Session MCP Installation Guide for AI Agents

This file is intended for AI agents such as Cline that need to install and configure `ssh-session-mcp` automatically.

## Goal

Set up `ssh-session-mcp` as a stdio MCP server with the least friction possible.

Preferred behavior:

1. Do not build from source unless explicitly necessary.
2. Prefer `npx -y ssh-session-mcp` so the package is downloaded automatically on first run.
3. Use `--viewerPort=auto` so the local browser terminal is available without manual port selection.
4. Keep secrets in environment variables or `.env`, never inline in tracked JSON.

## Fastest Install Path

For most users, the correct MCP server command is:

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

Windows note:

```bash
cmd /c npx -y ssh-session-mcp --viewerPort=auto
```

Use the Windows variant when a client has trouble spawning `npx` directly as a stdio command.

## One-Click Install Readiness

This repository is designed to be one-click installable in marketplaces such as Cline's MCP Marketplace because:

- it is published to npm as `ssh-session-mcp`
- it can be started directly with `npx -y ssh-session-mcp`
- it does not require a source checkout or local build for standard usage
- it documents both legacy `.env` mode and profile-based config mode

If a marketplace or agent asks for the MCP server command, use the `npx` command above.

## Client-Specific Setup

### Cline / Roo / Compatible JSON-based clients

If manual JSON configuration is required, use:

```json
{
  "mcpServers": {
    "ssh-session-mcp": {
      "command": "npx",
      "args": ["-y", "ssh-session-mcp", "--viewerPort=auto"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Windows variant:

```json
{
  "mcpServers": {
    "ssh-session-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "ssh-session-mcp", "--viewerPort=auto"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

Windows:

```bash
claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto
```

### Codex

```bash
codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

### OpenCode

Use the interactive `opencode mcp add` flow with this local command:

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

Or write config like:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ssh-session-mcp": {
      "type": "local",
      "command": ["npx", "-y", "ssh-session-mcp", "--viewerPort=auto"]
    }
  }
}
```

## Runtime Configuration

The server supports two main runtime paths:

### Path A: Legacy single-target mode

Use `.env` with:

```ini
SSH_HOST=192.168.1.100
SSH_PORT=22
SSH_USER=username
SSH_PASSWORD=
SSH_KEY=
VIEWER_PORT=auto
SSH_MCP_MODE=safe
```

### Path B: Multi-device profile mode

Use `ssh-session-mcp.config.json` and keep secrets in env variables:

```json
{
  "defaultDevice": "board-a",
  "devices": [
    {
      "id": "board-a",
      "host": "192.168.10.58",
      "port": 22,
      "user": "orangepi",
      "auth": { "passwordEnv": "BOARD_A_PASSWORD" }
    }
  ]
}
```

## Config Discovery Rules

Important:

- config discovery is based on the MCP server working directory
- a config file in another workspace is not auto-discovered
- use `SSH_MCP_CONFIG=/path/to/config.json` if the config lives outside the current working directory

## Verification

After installation:

1. Confirm the MCP server starts without crashing.
2. Use `ssh-device-list` to see whether config loaded correctly.
3. Use `ssh-quick-connect` for the common path.
4. Use `ssh-status` and `ssh-session-diagnostics` if the terminal state looks abnormal.

## No-SSH Demo Mode

If the user explicitly wants a demo without touching a real SSH host, use:

```bash
npx -y ssh-session-mcp --local --viewerPort=auto
```

Only use `--local` for demos, offline testing, or prompt iteration. Do not silently choose it when the user expects a real SSH target.
