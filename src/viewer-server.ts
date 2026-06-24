/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

import {
  AUTH_MODE,
  extractViewerIdentity,
  resolveRemoteOwnerForBinding,
  resolveRemoteOwnerForSessionRef,
  viewerServer,
  actualViewerPort,
  setViewerServer,
  setViewerWss,
  setActualViewerPort,
  incrementRuntimeMetric,
  logServerEvent,
  DEFAULT_VIEWER_HOST,
  VIEWER_PORT_SETTING,
  saveServerInfoState,
  viewerOriginAllowed,
  viewerRequestAllowed,
} from './server-state.js';
import { handleViewerHttpRequest } from './viewer-http-handler.js';
import { matchViewerWsRoute } from './viewer-routes.js';
import { handleWsAttach } from './viewer-ws-handler.js';

function rejectUpgrade(socket: Pick<Duplex, 'write' | 'destroy'>, statusCode: number, payload: object) {
  const statusText = statusCode === 403
    ? 'Forbidden'
    : statusCode === 404
      ? 'Not Found'
      : 'Bad Request';
  const body = JSON.stringify(payload, null, 2);
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: application/json; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n`
    + '\r\n'
    + body,
  );
  socket.destroy();
}

export async function startViewerServer() {
  if (!VIEWER_PORT_SETTING.enabled || viewerServer) {
    return;
  }

  const httpServer = createServer((request, response) => {
    if (!viewerRequestAllowed(request.socket.remoteAddress) || !viewerOriginAllowed(typeof request.headers.origin === 'string' ? request.headers.origin : undefined)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Viewer access denied by policy.' }, null, 2));
      return;
    }
    void handleViewerHttpRequest(request, response).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: message }, null, 2));
        return;
      }

      response.end();
    });
  });

  setViewerServer(httpServer);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(VIEWER_PORT_SETTING.mode === 'fixed' ? VIEWER_PORT_SETTING.port : 0, DEFAULT_VIEWER_HOST, () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      if (address && typeof address === 'object') {
        setActualViewerPort(address.port);
      }
      resolve();
    });
  });
  logServerEvent('viewer_server.started', {
    host: DEFAULT_VIEWER_HOST,
    port: actualViewerPort,
    mode: VIEWER_PORT_SETTING.mode,
  });
  await saveServerInfoState();

  const wss = new WebSocketServer({ noServer: true });
  setViewerWss(wss);

  httpServer.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (!viewerRequestAllowed(request.socket.remoteAddress) || !viewerOriginAllowed(typeof request.headers.origin === 'string' ? request.headers.origin : undefined)) {
        incrementRuntimeMetric('viewerAuthRejected');
        logServerEvent('viewer_auth.rejected', {
          reason: 'viewer_policy_denied',
          transport: 'websocket_upgrade',
        });
        rejectUpgrade(socket, 403, { error: 'Viewer access denied by policy.' });
        return;
      }

      const identity = extractViewerIdentity(request.headers);
      if (AUTH_MODE === 'proxy' && !identity) {
        incrementRuntimeMetric('viewerAuthRejected');
        logServerEvent('viewer_auth.rejected', {
          reason: 'missing_identity_headers',
          transport: 'websocket_upgrade',
        });
        rejectUpgrade(socket, 403, { error: 'Missing trusted viewer identity headers.' });
        return;
      }

      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const route = matchViewerWsRoute(url.pathname);

      if (!route) {
        rejectUpgrade(socket, 404, { error: 'Unknown websocket attach route.' });
        return;
      }

      const rawOffsetParam = url.searchParams.get('rawOffset');
      const rawOffset = rawOffsetParam !== null ? parseInt(rawOffsetParam, 10) : undefined;
      const remoteOwner = route.kind === 'binding'
        ? await resolveRemoteOwnerForBinding(route.ref, `${url.pathname}${url.search}`)
        : await resolveRemoteOwnerForSessionRef(route.ref, `${url.pathname}${url.search}`);
      if (remoteOwner) {
        incrementRuntimeMetric('remoteOwnerWs');
        logServerEvent('viewer_ws.remote_owner', {
          kind: route.kind,
          ref: route.ref,
          ownerNodeId: remoteOwner.ownerNodeId,
          redirectUrl: remoteOwner.redirectUrl,
        });
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        handleWsAttach(
          ws,
          route.kind,
          route.ref,
          Number.isFinite(rawOffset) ? rawOffset : undefined,
          { identity, remoteOwner },
        );
      });
    })().catch(error => {
      rejectUpgrade(socket, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
