# ssh-session-mcp

[中文](README.zh-CN.md) | **English**

[![License: Apache%202.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/ssh-session-mcp)](https://www.npmjs.com/package/ssh-session-mcp)

Persistent shared-terminal runtime for MCP clients over SSH.

`ssh-session-mcp` gives the user and the AI the same SSH PTY session, adds a browser viewer, tracks who typed what, and makes long-running remote work manageable instead of stateless.

![ssh-session-mcp hero demo](https://raw.githubusercontent.com/Zw-awa/ssh-session-mcp/main/site/assets/hero-loop.gif)

## Contents

- [Install At A Glance](#install-at-a-glance)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Docker Status](#6-docker-status)
- [MCP Tools](#mcp-tools)
- [Configuration Summary](#configuration-summary)
- [Security](#security)
- [Docs](#docs)
- [Development](#development)

## Install At A Glance

- Normal users do not need to `git clone` this repository.
- Preferred install path for MCP clients: `npx -y ssh-session-mcp --viewerPort=auto`
- Preferred install path for human operators who want local binaries: `npm install -g ssh-session-mcp`
- Official container distribution can be published to a public registry such as `docker.io/zwawa/ssh-session-mcp`
- `git clone` is only for contributors, source builds, and local development.
- For the common desktop MCP workflow, `npx` or a global npm install is still the lowest-friction path. Docker is mainly useful when you want a pinned runtime, container-based deployment, or registry-backed distribution.

## Why It Exists

Most SSH-oriented MCP servers can execute commands, but they do not manage terminal state well enough for real collaboration.

`ssh-session-mcp` focuses on the missing runtime layer:

- One shared PTY for both the human and the AI
- Browser terminal for live inspection and manual intervention
- Input lock so the AI does not type over the user
- Safe/full execution modes for risky commands
- Configurable default policy rules plus session-level custom rule overrides
- Async command tracking for long-running remote work
- Multi-device and multi-connection profile support
- Local debug mode for demos, offline testing, and prompt iteration

## Best Fit

- AI-assisted remote development on Linux boards and SSH servers
- Embedded, ROS, training, and deployment hosts that need a real terminal
- Users who want the AI to help, but do not want to surrender the terminal
- MCP Marketplace listings where the install and demo path must be clear

## Project Structure

Key directories and files:

| Path | Purpose |
|------|---------|
| `src/` | Core TypeScript implementation for the MCP server, SSH session runtime, viewer, tools, and config CLIs |
| `src/viewer-html/` | HTML page generators and browser-side scripts for the terminal viewer |
| `test/` | Vitest coverage for runtime behavior, viewer contracts, config loading, and repository validation |
| `docs/` | Supporting documentation such as contracts, failure taxonomy, platform notes, and Docker usage |
| `docs/examples/` | Example config files for normal and Docker-oriented setups |
| `scripts/` | Build, version sync, and local operator helper scripts |
| `deploy/helm/` | Helm chart for Kubernetes deployment in single-node or distributed v0 mode |
| `site/` | GitHub Pages landing page source |
| `dist/` | Generated static site output from `npm run build:site` |
| `build/` | Generated JavaScript output from `npm run build` |
| `Dockerfile` | Container image build definition |
| `docker-compose.yml` | Profile-based Docker Compose example |
| `docker-compose.env.yml` | Legacy `.env`-style Docker Compose example |
| `server.json` | MCP server metadata for marketplace-style distribution |
| `AGENT.md` | Primary agent/operator playbook |
| `llms-install.md` | Agent-focused installation and environment checklist |
| `.env.example` | Legacy single-target environment variable template |

## Quick Start

### 1. Agent-First Install (Auto-download on first run)

If the goal is to let Claude Code, Codex, or OpenCode install the server automatically, prefer `npx -y ssh-session-mcp` in the MCP command instead of a prior global install.

For Cline Marketplace and other agent installers, see [llms-install.md](llms-install.md). This repo is structured to be one-click installable through an `npx -y ssh-session-mcp --viewerPort=auto` command.

#### Claude Code

```bash
claude mcp add --transport stdio ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

Windows note from the Claude Code docs: native Windows users should wrap `npx` with `cmd /c` for stdio MCP servers.

```bash
claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto
```

#### Codex

```bash
codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto
```

#### OpenCode

OpenCode's `opencode mcp add` flow is interactive. Choose a local MCP server and use this command:

```bash
npx -y ssh-session-mcp --viewerPort=auto
```

If you prefer config instead of the interactive flow:

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

This is the closest thing to "automatic installation" for stdio MCP servers today: the MCP client stores the command, and `npx -y` downloads the package automatically the first time it runs.

### 2. Fastest Local Demo

```bash
npm install -g ssh-session-mcp
ssh-session-mcp-ctl launch --local --viewerPort=auto
```

This starts a local shell instead of SSH and opens the browser terminal, which is the easiest way to test the MCP runtime before touching a real server.

### 3. Register As An MCP Server

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

### 4. Connect To A Real SSH Target

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

```ini
SSH_HOST=YOUR_DEVICE_HOST
SSH_PORT=22
SSH_USER=YOUR_DEVICE_USER
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

### 5. Multi-Device Config

For multiple boards or named targets, create `ssh-session-mcp.config.json`:

```json
{
  "defaultDevice": "DEVICE_A_ID",
  "devices": [
    {
      "id": "DEVICE_A_ID",
      "host": "DEVICE_A_HOST",
      "port": 22,
      "user": "DEVICE_A_USER",
      "auth": { "passwordEnv": "DEVICE_A_PASSWORD" },
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

### 6. Docker Status

Public Docker images should be distributed through Docker Hub, with GitHub Container Registry as an optional secondary registry:

```bash
docker.io/zwawa/ssh-session-mcp:<version>
docker.io/zwawa/ssh-session-mcp:latest
ghcr.io/zw-awa/ssh-session-mcp:<version>
```

Recommended container launch for a real SSH target:

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_HOST=YOUR_DEVICE_HOST \
  -e SSH_PORT=22 \
  -e SSH_USER=YOUR_DEVICE_USER \
  -e SSH_PASSWORD \
  docker.io/zwawa/ssh-session-mcp:latest
```

Export the password in your shell first instead of placing it directly on the command line.

Recommended launch for profile-based config:

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_MCP_CONFIG=/workspace/ssh-session-mcp.config.json \
  -v "$PWD/ssh-session-mcp.config.json:/workspace/ssh-session-mcp.config.json:ro" \
  -v "/path/to/host/keys:/workspace/keys:ro" \
  docker.io/zwawa/ssh-session-mcp:latest
```

Equivalent Compose example:

```bash
docker compose up -d
```

See [docker-compose.yml](docker-compose.yml) for a ready-to-run example that mounts `ssh-session-mcp.config.json`, publishes the viewer on `8793`, and uses `SSH_KEY_DIR` when set or falls back to a dedicated `./keys` directory.
For the full Docker guide, including the legacy `.env` compose variant and MCP client config snippets, see [docs/docker.md](docs/docker.md).
For a container-oriented profile example, see [docs/examples/ssh-session-mcp.config.docker.example.json](docs/examples/ssh-session-mcp.config.docker.example.json).

Container-specific notes:

- The image defaults `VIEWER_PORT` to `8793` when unset so the browser viewer can be published reliably.
- The image defaults `VIEWER_HOST` to `0.0.0.0` inside the container so the mapped port is reachable from the host.
- `AUTO_OPEN_TERMINAL` defaults to `false` in the container because browser auto-open from inside a container is usually not useful.
- Mount config files or SSH keys read-only when possible.
- Prefer mounting SSH keys from a directory outside the repo root.
- In `docker-compose.yml`, `SSH_KEY_DIR` overrides the default key mount path. If it is unset, Compose falls back to `./keys`, not the repo root.
- Avoid putting passwords directly on the command line. Prefer exported env vars, Compose `.env`, or `--env-file`.
- For stdio MCP clients, Docker is viable, but host-native `npx` is still simpler unless your client explicitly prefers containerized commands.

Docker-based MCP client command examples:

```bash
# Claude Code
claude mcp add --transport stdio ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest

# Codex CLI
codex mcp add ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

For JSON-based MCP clients, the same pattern works by using `docker` as the command and passing the remaining `run ... docker.io/zwawa/ssh-session-mcp:latest` tokens as args.

This is useful when:

- The primary workflow is a local stdio MCP server command, not a long-lived network service.
- You want a pinned Node/runtime environment without a local install.
- You need registry-based distribution for a team or managed host.
- You want container-level isolation for the MCP server process.

For many users, publishing to npm and recommending `npx -y ssh-session-mcp --viewerPort=auto` is still the lower-friction install path.

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
| `safe` | Default per session. Automatically blocks obviously dangerous, interactive, or never-ending commands. |
| `full` | Per session. Relaxes the guardrails for advanced use, while still blocking a small set of clearly destructive abuse cases. |

Each session now owns its own `safe` / `full` mode. Switching one browser terminal to `full` does not change other sessions.

The default rule set can be customized if needed. Custom rules now support:

- `error`: block the command
- `warning`: allow but surface a warning
- `log`: allow and annotate only

Rule precedence is `error > warning > log`, and within the same level, earlier rules win.

## Lock Policy

The browser terminal UI lets the operator choose one of these input policies:

| Policy | What the operator experiences |
|------|-------------------------------|
| `common` | User and agent can both type into the shared terminal. |
| `user` | Only the user can type. Agent write actions are blocked. |
| `auto` | The user can start typing without fighting the agent. While the user is actively drafting input, agent writes are blocked. |
| `agent` | Only the agent can type. User input is blocked until the policy changes. |

When the terminal is not available for agent input, tools such as `ssh-run`, `ssh-session-send`, and `ssh-session-control` return a blocked response instead of forcing input into the PTY.

## MCP Tools

### Recommended Daily Tools

| Tool | Purpose |
|------|---------|
| `ssh-quick-connect` | Connect or reuse the default target and optionally open the viewer |
| `ssh-run` | Execute a command with completion detection and exit-code capture |
| `ssh-status` | Inspect sessions, viewer state, and operation mode |
| `ssh-command-status` | Poll async command progress |
| `ssh-retry` | Retry flaky commands with backoff |
| `ssh-session-policy-list` | Inspect inherited defaults and current session custom policy rules |
| `ssh-session-policy-upsert` | Add or update a session-level custom policy rule |
| `ssh-session-policy-remove` | Remove a session-level custom policy rule |
| `ssh-session-policy-reset` | Reset session custom rules back to inherited defaults |

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
| `ssh-session-policy-list` | Show inherited policy defaults and the current session rule set |
| `ssh-session-policy-upsert` | Add or update a session-specific custom policy rule |
| `ssh-session-policy-remove` | Remove a session-specific custom policy rule |
| `ssh-session-policy-reset` | Restore inherited rules for the current session |
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

Default rule library management for operators:

```bash
ssh-session-mcp-config policy list --scope=merged
ssh-session-mcp-config policy set error-kubectl-delete --pattern="\\bkubectl\\s+delete\\b" --category=dangerous --action=error --priority=0 --message="kubectl delete is blocked in safe mode"
ssh-session-mcp-config policy remove error-kubectl-delete
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
| `SSH_PASSWORD_FILE` | File containing the SSH password | empty |
| `SSH_KEY_FILE` | File containing the SSH private key | empty |
| `SSH_MCP_INSTANCE` | Runtime isolation key | `proc-<pid>` or helper-selected |
| `SSH_MCP_CONFIG` | Explicit config file path | auto-discovery |
| `SSH_MCP_STATE_DIR` | Runtime state root directory | platform default |
| `VIEWER_HOST` | Viewer bind host | `127.0.0.1` |
| `VIEWER_PORT` | Viewer port or `auto` | `0` unless configured |
| `VIEWER_ACCESS_MODE` | Viewer IP filter mode | config-driven |
| `SSH_MCP_MODE` | `safe` or `full` | `safe` |
| `SSH_MCP_LOCAL` | Launch a local shell instead of SSH | `false` |
| `SSH_MCP_DEBUG` | Enable debug browser actions | `false` |
| `AUTO_OPEN_TERMINAL` | Auto-open browser terminal | `false` |
| `SSH_MCP_LOG_MODE` | `off`, `meta`, or `stderr` logging | `off` |
| `SSH_MCP_LOG_DIR` | Metadata log directory | platform default |

### Distributed v0

Distributed v0 intentionally implements a narrow boundary:

- Supported runtime modes: `single-node` and `distributed`
- Distributed mode shares control-plane state only: node heartbeat, session metadata, binding metadata, command metadata, and viewer access policy
- When the current replica is not the owner, HTTP APIs return `REMOTE_OWNER`, HTML pages render a remote-owner error page, and websocket attaches close with code `4009`
- Cross-node PTY migration is not supported
- Transparent cross-node HTTP or websocket proxying is not supported

Distributed v0 requires Redis for real multi-node deployments. `SSH_MCP_STORE=memory` only exists for local skeleton testing and does not provide a shared store across replicas.

Distributed configuration:

| Variable | Meaning | Default |
|----------|---------|---------|
| `SSH_MCP_RUNTIME_MODE` | `single-node` or `distributed` | `single-node` |
| `SSH_MCP_STORE` | `memory` or `redis` | `redis` in distributed mode, otherwise `memory` |
| `SSH_MCP_REDIS_URL` | Redis connection URL | required when `SSH_MCP_STORE=redis` |
| `SSH_MCP_NODE_ID` | Stable logical node id for this replica | runtime instance id |
| `SSH_MCP_PUBLIC_BASE_URL` | Public viewer base URL advertised to other replicas | unset |
| `SSH_MCP_AUTH_MODE` | `off` or `proxy` | `off` |
| `SSH_MCP_TRUST_PROXY` | Whether to trust authenticated proxy headers | `false` |
| `SSH_MCP_AUTH_USER_HEADER` | Authenticated user header name | `x-ssh-session-mcp-user` |
| `SSH_MCP_AUTH_ROLE_HEADER` | Authenticated role header name | `x-ssh-session-mcp-role` |

Recommended distributed env example:

```bash
SSH_MCP_RUNTIME_MODE=distributed
SSH_MCP_STORE=redis
SSH_MCP_REDIS_URL=redis://redis:6379/0
SSH_MCP_NODE_ID=node-a
SSH_MCP_PUBLIC_BASE_URL=https://ssh-mcp.example.com
SSH_MCP_AUTH_MODE=proxy
SSH_MCP_TRUST_PROXY=true
SSH_MCP_AUTH_USER_HEADER=x-forwarded-user
SSH_MCP_AUTH_ROLE_HEADER=x-forwarded-role
```

Proxy auth is most useful in distributed mode behind a trusted reverse proxy. The built-in role mapping is:

- `viewer_read`: pages, session list/read endpoints, history, diagnostics, health, readiness, metrics
- `viewer_write`: attach input, resize, control
- `session_admin`: mode changes, policy updates, close, set-active, debug-agent actions, local debug session creation

### Macro / Environment Variable Reference

Use these variables according to your installation path:

| Variable | Required When | Accepted Values / Example | Notes |
|----------|---------------|---------------------------|-------|
| `SSH_HOST` | Legacy single-target SSH mode | `YOUR_DEVICE_HOST` | Required unless you use `ssh-session-mcp.config.json` or `--local`. |
| `SSH_PORT` | Legacy single-target SSH mode | `22` | Optional in legacy mode; defaults to `22`. |
| `SSH_USER` | Legacy single-target SSH mode | `YOUR_DEVICE_USER` | Required unless you use device profiles. |
| `SSH_PASSWORD` | Password-based auth | exported env var | Prefer env export over putting the password directly in the command line. |
| `SSH_PASSWORD_FILE` | Password-based auth via secret file | `/run/secrets/ssh_password` | The file contents are used as the password. This is the preferred pattern for Docker and Kubernetes secrets. |
| `SSH_KEY` | Key-based auth in legacy mode | `/absolute/path/to/private/key` | The path must exist on the host running the MCP server. |
| `SSH_KEY_FILE` | Key-based auth via secret file | `/run/secrets/ssh_private_key` | The file contents are used as the private key. This works well with mounted container secrets. |
| `SSH_MCP_CONFIG` | Profile-based mode or config outside cwd | `/path/to/ssh-session-mcp.config.json` | Use this when config auto-discovery is not enough. |
| `SSH_MCP_INSTANCE` | Multi-agent / multi-client isolation | `agent-a` | Use different values when two agents should not share runtime state. |
| `SSH_MCP_STATE_DIR` | Runtime state root override | `/workspace/state` | Controls where per-instance server info, viewer state, and default logs are stored. Mount it persistently in containers. |
| `SSH_MCP_RUNTIME_MODE` | Distributed topology selection | `single-node`, `distributed` | Distributed v0 only shares control-plane state; it does not migrate PTYs across nodes. |
| `SSH_MCP_STORE` | Distributed state backend | `memory`, `redis` | Use `redis` for any real multi-node deployment. `memory` is only for local distributed skeleton testing. |
| `SSH_MCP_REDIS_URL` | Redis backend enabled | `redis://redis:6379/0` | Required when `SSH_MCP_RUNTIME_MODE=distributed` and `SSH_MCP_STORE=redis`. |
| `SSH_MCP_NODE_ID` | Stable distributed node id | `node-a` | Useful when multiple replicas share Redis and need durable owner ids. |
| `SSH_MCP_PUBLIC_BASE_URL` | Public routing hint for this node | `https://ssh-mcp.example.com` | Used in `REMOTE_OWNER` payloads and cluster status output. |
| `SSH_MCP_AUTH_MODE` | Viewer auth mode | `off`, `proxy` | `proxy` is recommended only behind a trusted reverse proxy. |
| `SSH_MCP_TRUST_PROXY` | Trust viewer identity headers | `true`, `false` | Must be enabled together with `SSH_MCP_AUTH_MODE=proxy`. |
| `SSH_MCP_AUTH_USER_HEADER` | Proxy-auth viewer user header | `x-forwarded-user` | Header names are normalized to lowercase internally. |
| `SSH_MCP_AUTH_ROLE_HEADER` | Proxy-auth viewer role header | `x-forwarded-role` | Roles are comma-separated and mapped to `viewer_read`, `viewer_write`, `session_admin`. |
| `VIEWER_HOST` | Custom viewer bind | `127.0.0.1`, `0.0.0.0` | Use `0.0.0.0` inside containers; keep `127.0.0.1` on normal host installs unless you need remote access. |
| `VIEWER_PORT` | Viewer enabled | `auto`, `0`, `8793` | `auto` picks a free port, `0` disables the viewer, fixed ports are best for Docker. |
| `VIEWER_ACCESS_MODE` | Viewer access control mode | `allow_all`, `allowlist`, `denylist` | Usually edited in the viewer home page. Keep `allow_all` only when you stay on localhost. |
| `AUTO_OPEN_TERMINAL` | Auto-open viewer tab | `true`, `false` | Usually `false` in containers. |
| `SSH_MCP_MODE` | Runtime safety mode | `safe`, `full` | `safe` is the recommended default. |
| `SSH_MCP_LOCAL` | Local demo mode | `true`, `false` | Starts a local shell instead of SSH. |
| `SSH_MCP_DEBUG` | Browser debug controls | `true`, `false` | Intended for demos and troubleshooting. |
| `SSH_MCP_LOG_MODE` | Runtime metadata logging | `off`, `meta`, `stderr` | `meta` writes JSONL metadata logs without storing raw secrets. `stderr` is the preferred container mode because it preserves stdio MCP transport while exposing structured logs to the container runtime. |
| `SSH_MCP_LOG_DIR` | Override metadata log directory | `/workspace/state/instances/<instance>/logs` | Mainly useful with `SSH_MCP_LOG_MODE=meta`; ignored for `stderr`. |
| `SSH_KEY_DIR` | Docker Compose profile-based example | `/path/to/host/keys` | Optional in `docker-compose.yml`; when unset it falls back to `./keys`. |
| `SSH_SESSION_MCP_IMAGE` | Docker Compose image override | `docker.io/zwawa/ssh-session-mcp:latest` | Override this if you mirror the image or test another tag. |

### Minimum Required Settings

Choose one of these minimum configuration sets:

- Local demo: `SSH_MCP_LOCAL=true` and `VIEWER_PORT=auto`
- Legacy SSH with password: `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`
- Legacy SSH with key: `SSH_HOST`, `SSH_USER`, `SSH_KEY`
- Profile-based mode: `ssh-session-mcp.config.json`, plus any `passwordEnv` variables referenced by that config
- Docker Compose profile mode: `ssh-session-mcp.config.json`, optional `SSH_KEY_DIR`, optional `SSH_SESSION_MCP_IMAGE`

### Container Runtime Notes

- Container defaults now set `SSH_MCP_LOG_MODE=stderr` so logs go to the container runtime without corrupting stdio MCP transport.
- Mount `SSH_MCP_STATE_DIR` persistently when you want viewer policy, server info, and state files to survive container restarts.
- Distributed multi-node deployments need Redis plus a routable `SSH_MCP_PUBLIC_BASE_URL` per replica.
- Distributed v0 does not provide cross-node PTY migration or transparent cross-node proxying. Route requests to the owner node when you receive `REMOTE_OWNER`.
- Health endpoints:
  - `/livez` for process liveness
  - `/readyz` for readiness checks
  - `/metrics` for Prometheus text metrics
- Example single-instance Kubernetes baseline: [docs/examples/ssh-session-mcp.k8s.single-instance.yaml](docs/examples/ssh-session-mcp.k8s.single-instance.yaml)
- Example distributed Kubernetes baseline: [docs/examples/ssh-session-mcp.k8s.distributed.example.yaml](docs/examples/ssh-session-mcp.k8s.distributed.example.yaml)
- Primary Kubernetes installation path: `deploy/helm/ssh-session-mcp`

Example config file: [docs/examples/ssh-session-mcp.config.example.json](docs/examples/ssh-session-mcp.config.example.json)

## Security

- The package never requires raw passwords inside tracked JSON config.
- `.env` is ignored by git and npm.
- Viewer HTTP binds to localhost by default.
- The MCP server treats terminal mode and input lock as first-class safety signals.
- CI runs Trivy filesystem and container-image scans against high and critical vulnerabilities.
- Release builds generate a CycloneDX SBOM for the published GHCR image digest and attach it to the GitHub release.
- Release builds sign the published GHCR image digest with keyless Cosign.
- GHCR digest is the primary verification path. Docker Hub remains a distribution path, not the main signature-verification target.

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
- [llms-install.md](llms-install.md)
- [docs/contracts.md](docs/contracts.md)
- [docs/failure-taxonomy.md](docs/failure-taxonomy.md)
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md)
- [docs/docker.md](docs/docker.md)
- [docs/kubernetes.md](docs/kubernetes.md)
- [docs/ingress-proxy-auth.md](docs/ingress-proxy-auth.md)
- [CHANGELOG.md](CHANGELOG.md)

## Development

Clone the repo only if you want to modify the source, run tests locally, or build release artifacts.

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
