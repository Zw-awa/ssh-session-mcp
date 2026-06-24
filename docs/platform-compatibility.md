<!-- SPDX-FileCopyrightText: 2026 Zw-awa
SPDX-License-Identifier: Apache-2.0 -->

# Platform Compatibility

## Supported Host Environments

| Host | Status | Notes |
|------|--------|-------|
| Windows 10/11 | Supported | Primary development path for local viewer launching and multi-instance runtime state |
| Linux | Supported | Good fit for headless MCP server usage and browser viewer workflows |
| macOS | Supported with standard Node.js behavior | Browser viewer path is expected to work; terminal-launch details may differ from Windows |

## Supported Remote Targets

| Remote | Status | Notes |
|------|--------|-------|
| Linux boards over SSH | First-class target | Typical use case for Orange Pi, RK3588, ROS2 boards, and remote training/dev hosts |
| General SSH servers | Supported | Any OpenSSH-compatible target should work if shell behavior is normal |
| Windows SSH targets | Best effort | Less test coverage; prompt detection and shell semantics may vary |

## Viewer Modes

| Mode | Strength |
|------|----------|
| `terminal` | Closest to a normal SSH terminal; lowest local UI layer |
| `browser` | Richer collaborative controls, lock state, and session-oriented management |

## Runtime Notes

- Config discovery supports workspace config, user-global config, or explicit `--config`.
- Runtime state is isolated by `SSH_MCP_INSTANCE`.
- Viewer HTTP binds to `127.0.0.1` by default unless the user changes it.
- In Docker, publish the viewer port and bind `VIEWER_HOST=0.0.0.0` inside the container.
- No external service is required for the core SSH transport path.

See [docker.md](docker.md) for container-specific setup details.
