<!-- SPDX-FileCopyrightText: 2026 Zw-awa
SPDX-License-Identifier: Apache-2.0 -->

# Docker Distribution

`ssh-session-mcp` supports container-based distribution in addition to npm.

Official image target:

```text
docker.io/zwawa/ssh-session-mcp:<version>
docker.io/zwawa/ssh-session-mcp:latest
ghcr.io/zw-awa/ssh-session-mcp:<version>
```

## When Docker Is A Good Fit

- You want a pinned runtime without installing Node.js on the host.
- You want registry-based distribution for a team or a managed workstation.
- You want the MCP server process isolated in a container.
- Your MCP client can launch local commands through `docker run`.

For many desktop users, `npx -y ssh-session-mcp --viewerPort=auto` is still the simpler default.

## Important Container Defaults

The image entrypoint adjusts a few defaults for container use:

- `VIEWER_PORT` defaults to `8793` when unset.
- `VIEWER_HOST` defaults to `0.0.0.0` when unset or still set to loopback.
- `AUTO_OPEN_TERMINAL` defaults to `false`.
- `SSH_MCP_STATE_DIR` defaults to `/workspace/state`.
- `SSH_MCP_LOG_MODE` defaults to `stderr`.

These defaults exist so the browser viewer can be exposed through a fixed mapped port and because auto-opening a browser from inside a container is usually not useful.

## Basic `docker run`

### Real SSH target via env vars

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_MCP_STATE_DIR=/workspace/state \
  -e SSH_HOST=YOUR_DEVICE_HOST \
  -e SSH_PORT=22 \
  -e SSH_USER=YOUR_DEVICE_USER \
  -e SSH_PASSWORD_FILE=/run/secrets/ssh_password \
  -v "/path/to/ssh_password:/run/secrets/ssh_password:ro" \
  docker.io/zwawa/ssh-session-mcp:latest
```

If you still prefer env-based auth, export `SSH_PASSWORD` in your shell first instead of embedding it directly in the command line.

### Profile-based config

```bash
docker run --rm -i \
  -p 8793:8793 \
  -e VIEWER_PORT=8793 \
  -e VIEWER_HOST=0.0.0.0 \
  -e SSH_MCP_STATE_DIR=/workspace/state \
  -e SSH_MCP_CONFIG=/workspace/ssh-session-mcp.config.json \
  -v "$PWD/ssh-session-mcp.config.json:/workspace/ssh-session-mcp.config.json:ro" \
  -v "/path/to/host/keys:/workspace/keys:ro" \
  -v "ssh-session-mcp-state:/workspace/state" \
  docker.io/zwawa/ssh-session-mcp:latest
```

You can start from [docs/examples/ssh-session-mcp.config.docker.example.json](examples/ssh-session-mcp.config.docker.example.json) for a container-oriented config baseline.

## Compose Examples

### Profile-based config

Use [docker-compose.yml](../docker-compose.yml):

```bash
docker compose up -d
```

This example mounts:

- `./ssh-session-mcp.config.json` to `/workspace/ssh-session-mcp.config.json`
- `${SSH_KEY_DIR:-./keys}` to `/workspace/keys` read-only
- a named volume to `/workspace/state`

### Legacy `.env` mode

Use [docker-compose.env.yml](../docker-compose.env.yml):

```bash
docker compose -f docker-compose.env.yml up -d
```

This variant reads `SSH_HOST`, `SSH_PORT`, `SSH_USER`, and either `SSH_PASSWORD` / `SSH_PASSWORD_FILE`, plus optional `SSH_KEY` / `SSH_KEY_FILE`, from the shell or `.env` file used by Docker Compose.

If you want key-based auth in this mode, `SSH_KEY` must point to a key path that exists inside the container. That means you need to mount the key file or key directory yourself. If you do not want to manage that path mapping, prefer the profile-based compose example instead.
Any user with Docker access on the same host can inspect container environment variables, so avoid env-based password auth on shared machines when key-based auth is available.

## Health And Metrics

Container-friendly endpoints:

- `/livez` for liveness probes
- `/readyz` for readiness probes
- `/metrics` for Prometheus-style text metrics

The bundled Docker image `HEALTHCHECK` uses `/readyz`.

## Distributed v0 Notes

Distributed v0 is intentionally limited:

- It shares control-plane state only: node heartbeats, session metadata, binding metadata, command metadata, and viewer access policy
- It does not support cross-node PTY migration
- It does not support transparent cross-node HTTP or websocket proxying
- When a session is owned by another node, route the request to the owner node returned in the `REMOTE_OWNER` payload

For real multi-node distributed deployments:

- Set `SSH_MCP_RUNTIME_MODE=distributed`
- Set `SSH_MCP_STORE=redis`
- Provide `SSH_MCP_REDIS_URL`
- Give each replica a stable `SSH_MCP_NODE_ID`
- Give each replica a routable `SSH_MCP_PUBLIC_BASE_URL`
- Prefer `SSH_MCP_AUTH_MODE=proxy` plus `SSH_MCP_TRUST_PROXY=true` behind a trusted reverse proxy

Example distributed env block:

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

## Windows, PowerShell, And WSL Notes

Container volume syntax varies by shell:

- PowerShell: `-v "${PWD}\\ssh-session-mcp.config.json:/workspace/ssh-session-mcp.config.json:ro"` is often the simplest pattern.
- `cmd.exe`: prefer `%CD%\\ssh-session-mcp.config.json` and an explicit host key directory path outside the repo.
- Git Bash / WSL: the Unix-style examples in this doc usually work as written.

SSH key path behavior also differs by mode:

- If the config file uses `auth.keyPath`, the path must be valid inside the container filesystem, not the host path.
- The simplest container pattern is to mount a caller-chosen key directory into `/workspace/keys` and use in-container paths such as `/workspace/keys/id_ed25519`.
- In the default compose example, `SSH_KEY_DIR` overrides the key mount source. If it is unset, Compose falls back to `./keys`.
- If you keep using `passwordEnv`, prefer passing the secret through environment variables instead of editing tracked JSON.
- Avoid putting raw passwords directly in `docker run` command lines because they can leak through shell history or process inspection.
- Avoid storing long-lived SSH keys under the repo root just to satisfy a compose example; point `SSH_KEY_DIR` at an external host directory instead when possible.

Viewer access tips:

- The container can bind `VIEWER_HOST=0.0.0.0`, but user-facing URLs still resolve to `127.0.0.1` on the host side.
- If `8793` is already occupied, remap both the published port and `VIEWER_PORT`, for example `-p 8800:8800 -e VIEWER_PORT=8800`.

## Kubernetes Baseline

A single-instance Kubernetes baseline is provided at [docs/examples/ssh-session-mcp.k8s.single-instance.yaml](examples/ssh-session-mcp.k8s.single-instance.yaml).
A distributed baseline example is provided at [docs/examples/ssh-session-mcp.k8s.distributed.example.yaml](examples/ssh-session-mcp.k8s.distributed.example.yaml).

Recommended first-stage deployment model:

- `replicas: 1`
- persistent volume mounted at `/workspace/state`
- `readOnlyRootFilesystem: true`
- liveness probe on `/livez`
- readiness probe on `/readyz`

Recommended distributed v0 model:

- `replicas: 2+`
- Redis reachable by every replica
- stable `SSH_MCP_NODE_ID` per replica or pod template
- explicit `SSH_MCP_PUBLIC_BASE_URL` per routed entrypoint
- trusted reverse proxy that injects viewer identity headers
- readiness probe on `/readyz` so Redis or heartbeat failures keep the pod out of service

## Supply Chain Notes

- CI runs Trivy filesystem and image scans for high and critical vulnerabilities.
- Release builds generate a CycloneDX SBOM for the published GHCR image digest and attach it to the GitHub release assets.
- Release builds sign the published GHCR image digest with keyless Cosign.
- For verification, prefer `ghcr.io/...@sha256:...` over tag-only pulls.

## MCP Client Command Examples

### Claude Code

```bash
claude mcp add --transport stdio ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

### Codex CLI

```bash
codex mcp add ssh-session-mcp -- docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest
```

### JSON-configured clients

```json
{
  "mcpServers": {
    "ssh-session-mcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-p",
        "8793:8793",
        "-e",
        "VIEWER_PORT=8793",
        "-e",
        "VIEWER_HOST=0.0.0.0",
        "docker.io/zwawa/ssh-session-mcp:latest"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Operational Notes

- Mount config files and SSH keys read-only when possible.
- If you need a viewer on a different host port, change both the container port mapping and `VIEWER_PORT`.
- For profile-based config outside the working directory, set `SSH_MCP_CONFIG` to the in-container path.
- If your client already supports `npx` reliably, prefer the host-native npm path unless containerization is a real requirement.
