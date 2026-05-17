FROM node:20-bookworm-slim AS build

WORKDIR /opt/ssh-session-mcp

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /opt/ssh-session-mcp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /opt/ssh-session-mcp/build ./build
COPY scripts/ctl.mjs ./scripts/ctl.mjs
COPY docker/entrypoint.sh /usr/local/bin/ssh-session-mcp-entrypoint

RUN chmod 755 /usr/local/bin/ssh-session-mcp-entrypoint \
  && mkdir -p /workspace \
  && chown -R node:node /workspace /opt/ssh-session-mcp

WORKDIR /workspace
USER node

EXPOSE 8793

ENTRYPOINT ["ssh-session-mcp-entrypoint"]
CMD ["ssh-session-mcp"]
