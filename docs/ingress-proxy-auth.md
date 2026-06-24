# Ingress And Proxy Auth

The recommended production access model is:

- a trusted reverse proxy or ingress in front of `ssh-session-mcp`
- the proxy authenticates the viewer user
- the proxy injects user and role headers
- `ssh-session-mcp` runs with `SSH_MCP_AUTH_MODE=proxy`

## Recommended Header Contract

Default application headers:

- `x-ssh-session-mcp-user`
- `x-ssh-session-mcp-role`

Recommended reverse-proxy mapping:

- authenticated username -> `x-forwarded-user`
- authenticated roles -> `x-forwarded-role`

If you use those names, configure:

```bash
SSH_MCP_AUTH_MODE=proxy
SSH_MCP_TRUST_PROXY=true
SSH_MCP_AUTH_USER_HEADER=x-forwarded-user
SSH_MCP_AUTH_ROLE_HEADER=x-forwarded-role
```

## Roles

Accepted roles:

- `viewer_read`
- `viewer_write`
- `session_admin`

Behavior:

- `viewer_read`: pages, list/read endpoints, history, diagnostics, health, readiness, metrics
- `viewer_write`: attach input, resize, control
- `session_admin`: mode, policy, close, set-active, debug-agent actions, local debug session creation

## Remote Owner Behavior

In distributed v0, when the current replica is not the session owner:

- API routes return `REMOTE_OWNER`
- page routes render a remote-owner error page
- websocket attach closes with `4009`

This is expected behavior. Route the request to the owner node URL returned by the application.

## Failure Cases

- Missing identity headers: HTTP 403 / websocket upgrade rejected
- Role too weak for operation: HTTP 403 / websocket `forbidden` message
- Redis unreachable: readiness fails
- Owner node unavailable: `REMOTE_OWNER` may have no usable redirect target

## TLS And Routing

Recommended split:

- TLS terminates at the ingress or reverse proxy
- viewer traffic stays HTTP inside the cluster
- owner routing remains a platform concern, not an application-internal proxy concern
