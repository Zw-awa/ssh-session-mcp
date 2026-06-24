#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zw-awa
# SPDX-License-Identifier: Apache-2.0

set -eu

if [ -z "${VIEWER_PORT:-}" ] || [ "${VIEWER_PORT}" = "auto" ]; then
  export VIEWER_PORT=8793
fi

if [ -z "${VIEWER_HOST:-}" ] || [ "${VIEWER_HOST}" = "127.0.0.1" ] || [ "${VIEWER_HOST}" = "localhost" ]; then
  export VIEWER_HOST=0.0.0.0
fi

if [ -z "${AUTO_OPEN_TERMINAL:-}" ]; then
  export AUTO_OPEN_TERMINAL=false
fi

if [ -z "${SSH_MCP_STATE_DIR:-}" ]; then
  export SSH_MCP_STATE_DIR=/workspace/state
fi

if [ -z "${SSH_MCP_LOG_MODE:-}" ]; then
  export SSH_MCP_LOG_MODE=stderr
fi

case "${1:-}" in
  "")
    set -- node /opt/ssh-session-mcp/build/index.js
    ;;
  ssh-session-mcp)
    shift
    set -- node /opt/ssh-session-mcp/build/index.js "$@"
    ;;
  ssh-session-mcp-ctl)
    shift
    set -- node /opt/ssh-session-mcp/scripts/ctl.mjs "$@"
    ;;
  ssh-session-mcp-view)
    shift
    set -- node /opt/ssh-session-mcp/build/viewer-cli.js "$@"
    ;;
  ssh-session-mcp-config)
    shift
    set -- node /opt/ssh-session-mcp/build/config-cli.js "$@"
    ;;
  ssh-session-mcp-validate-repo)
    shift
    set -- node /opt/ssh-session-mcp/build/validate-repo.js "$@"
    ;;
  -*|--*)
    set -- node /opt/ssh-session-mcp/build/index.js "$@"
    ;;
esac

exec "$@"
