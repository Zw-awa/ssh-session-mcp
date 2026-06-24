# Kubernetes Deployment

`ssh-session-mcp` now has three intended deployment paths:

- local quick use via `npx`
- single-container deployment via Docker / Compose
- production deployment via Kubernetes + Helm

For Kubernetes, the primary entrypoint is the Helm chart at `deploy/helm/ssh-session-mcp`.

## Supported Modes

### `singleNode`

Use this when you want one replica, one viewer endpoint, and no distributed routing.

Recommended when:

- you are migrating from Compose
- you want persistent local state
- you do not need cross-replica session discovery

### `distributedV0`

Use this when you want multiple replicas that share control-plane metadata through Redis.

Distributed v0 behavior:

- shared node/session/binding/command metadata
- owner-aware HTTP and websocket rejection semantics
- proxy-auth compatible viewer access control
- no cross-node PTY migration
- no transparent cross-node proxying

## Installation

Example single-node install:

```bash
helm upgrade --install ssh-session-mcp ./deploy/helm/ssh-session-mcp \
  -f ./deploy/helm/ssh-session-mcp/values-single-node.yaml
```

Example distributed install:

```bash
helm upgrade --install ssh-session-mcp ./deploy/helm/ssh-session-mcp \
  -f ./deploy/helm/ssh-session-mcp/values-distributed-v0.yaml \
  --set distributed.redis.existingSecret=ssh-session-mcp-distributed-secrets
```

## Required Distributed Settings

For `distributedV0`, you must provide:

- `deploymentMode=distributedV0`
- Redis via `distributed.redis.url` or `distributed.redis.existingSecret`
- `env.publicBaseUrl`
- a trusted reverse proxy in front of the viewer

## Operations

Health endpoints:

- `/livez`
- `/readyz`
- `/metrics`

Readiness in distributed mode depends on:

- writable state directory
- viewer listener readiness
- Redis reachability
- fresh node heartbeat

Supply-chain outputs:

- CI runs Trivy scans against the repo filesystem and the built container image
- Release builds publish a CycloneDX SBOM for the release GHCR digest
- Release builds sign the release GHCR digest with keyless Cosign
- Production consumers should prefer pinned GHCR digests when they want verifiable image identity

## Related Docs

- [docs/docker.md](docker.md)
- [docs/ingress-proxy-auth.md](ingress-proxy-auth.md)
- [docs/examples/ssh-session-mcp.k8s.single-instance.yaml](examples/ssh-session-mcp.k8s.single-instance.yaml)
- [docs/examples/ssh-session-mcp.k8s.distributed.example.yaml](examples/ssh-session-mcp.k8s.distributed.example.yaml)
