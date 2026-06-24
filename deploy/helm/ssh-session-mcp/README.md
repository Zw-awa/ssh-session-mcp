<!-- SPDX-FileCopyrightText: 2026 Zw-awa
SPDX-License-Identifier: Apache-2.0 -->

# ssh-session-mcp Helm Chart

This chart is the primary Kubernetes deployment entrypoint for `ssh-session-mcp`.

Supported deployment modes:

- `singleNode`
- `distributedV0`

Recommended production defaults for `distributedV0`:

- external Redis
- trusted reverse proxy in front of the viewer
- `SSH_MCP_AUTH_MODE=proxy`
- `SSH_MCP_TRUST_PROXY=true`
- explicit `SSH_MCP_PUBLIC_BASE_URL`

Example install:

```bash
helm upgrade --install ssh-session-mcp ./deploy/helm/ssh-session-mcp \
  --set deploymentMode=distributedV0 \
  --set replicaCount=2 \
  --set env.publicBaseUrl=https://ssh-mcp.example.com \
  --set distributed.redis.existingSecret=ssh-session-mcp-distributed-secrets
```

Bundled value presets:

- `values-single-node.yaml`
- `values-distributed-v0.yaml`
