<!-- SPDX-FileCopyrightText: 2026 Zw-awa
SPDX-License-Identifier: Apache-2.0 -->

# SSH Session MCP Installation Guide for AI Agents

This file is intended for AI agents such as Cline that need to install and configure `ssh-session-mcp` automatically.

## Goal

Set up `ssh-session-mcp` as a stdio MCP server with the least friction possible.

Preferred behavior:

1. Do not build from source unless explicitly necessary.
2. Prefer `npx -y ssh-session-mcp` so the package is downloaded automatically on first run.
3. Use `--viewerPort=auto` so the local browser terminal is available without manual port selection.
4. Keep secrets in environment variables or `.env`, never inline in tracked JSON.
5. Use Docker only when the client or operator explicitly wants a containerized runtime.

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

## Container Alternative

If the user explicitly prefers container distribution, use the published image instead of `npx`:

```bash
docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

Notes:

- `VIEWER_PORT=8793` is recommended in containers so the viewer can be published on a fixed mapped port.
- `VIEWER_HOST=0.0.0.0` is required inside the container if the host browser needs to reach the viewer.
- For profile-based config, mount `ssh-session-mcp.config.json` and SSH keys read-only.

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

Docker variant:

```json
{
  "mcpServers": {
    "ssh-session-mcp": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-p", "8793:8793", "-e", "VIEWER_PORT=8793", "-e", "VIEWER_HOST=0.0.0.0", "docker.io/zwawa/ssh-session-mcp:latest"],
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

Docker variant:

```bash
claude mcp add --transport stdio ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

### Codex

```bash
codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

Docker variant:

```bash
codex mcp add ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
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
SSH_HOST=YOUR_DEVICE_HOST
SSH_PORT=22
SSH_USER=YOUR_DEVICE_USER
SSH_PASSWORD=
SSH_KEY=
VIEWER_PORT=auto
SSH_MCP_MODE=safe
```

### Path B: Multi-device profile mode

Use `ssh-session-mcp.config.json` and keep secrets in env variables:

```json
{
  "defaultDevice": "DEVICE_A_ID",
  "devices": [
    {
      "id": "DEVICE_A_ID",
      "host": "DEVICE_A_HOST",
      "port": 22,
      "user": "DEVICE_A_USER",
      "auth": { "passwordEnv": "DEVICE_A_PASSWORD" }
    }
  ]
}
```

## Agent Question Checklist

Before an agent installs or launches the server automatically, it should ask the user to confirm:

1. Which install path should be used: `npx`, global npm, or Docker.
2. Whether the goal is a local demo or a real SSH target.
3. Whether runtime config should come from legacy `.env` mode or `ssh-session-mcp.config.json`.
4. If using legacy mode: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, and whether auth is password or key based.
5. If using profile mode: where `ssh-session-mcp.config.json` lives, and which `passwordEnv` variables must already exist.
6. Whether the browser viewer should be enabled, and which `VIEWER_PORT` or fixed Docker port should be used.
7. Whether `SSH_MCP_MODE` should stay `safe` or be changed to `full`.
8. If using Docker key auth: what `SSH_KEY_DIR` should be mounted, or whether the fallback `./keys` directory is acceptable.
9. Whether `SSH_MCP_INSTANCE` should be set explicitly for multi-agent isolation.

If the user does not provide enough information for one of those answers, the agent should stop and ask instead of inventing values.

## Agent Macro / Env Checklist

Depending on the chosen path, the agent should gather these values:

- Local demo: `SSH_MCP_LOCAL`, `VIEWER_PORT`
- Legacy SSH + password: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`
- Legacy SSH + key: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`
- Profile mode: `SSH_MCP_CONFIG`, plus every `passwordEnv` referenced by the config file
- Docker profile mode: `SSH_SESSION_MCP_IMAGE`, optional `SSH_KEY_DIR`, `VIEWER_PORT`, `VIEWER_HOST`
- Optional controls: `SSH_MCP_MODE`, `AUTO_OPEN_TERMINAL`, `SSH_MCP_INSTANCE`, `SSH_MCP_LOG_MODE`

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
