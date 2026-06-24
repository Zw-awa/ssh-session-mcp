# SPDX-FileCopyrightText: 2026 Zw-awa
# SPDX-License-Identifier: Apache-2.0

FROM node:20-bookworm-slim AS build

WORKDIR /opt/ssh-session-mcp

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
  SSH_MCP_LOG_MODE=stderr \
  SSH_MCP_STATE_DIR=/workspace/state

WORKDIR /opt/ssh-session-mcp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /opt/ssh-session-mcp/build ./build
COPY scripts/ctl.mjs ./scripts/ctl.mjs
COPY docker/entrypoint.sh /usr/local/bin/ssh-session-mcp-entrypoint

RUN chmod 755 /usr/local/bin/ssh-session-mcp-entrypoint \
  && mkdir -p /workspace /workspace/state /tmp \
  && chown -R node:node /workspace /opt/ssh-session-mcp /tmp

WORKDIR /workspace
USER node

EXPOSE 8793

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=(process.env.VIEWER_PORT||'8793').trim(); if (port==='0') process.exit(0); fetch(`http://127.0.0.1:${port}/readyz`).then((response)=>{ if(!response.ok) process.exit(1); }).catch(()=>process.exit(1));"]

ENTRYPOINT ["ssh-session-mcp-entrypoint"]
CMD ["ssh-session-mcp"]
