import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';

import {
  viewerServer,
  actualViewerPort,
  setViewerServer,
  setViewerWss,
  setActualViewerPort,
  logServerEvent,
  DEFAULT_VIEWER_HOST,
  VIEWER_PORT_SETTING,
  saveServerInfoState,
} from './server-state.js';
import { handleViewerHttpRequest } from './viewer-http-handler.js';
import { matchViewerWsRoute } from './viewer-routes.js';
import { handleWsAttach } from './viewer-ws-handler.js';

export async function startViewerServer() {
  if (!VIEWER_PORT_SETTING.enabled || viewerServer) {
    return;
  }

  const httpServer = createServer((request, response) => {
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
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const route = matchViewerWsRoute(url.pathname);

    if (!route) {
      socket.destroy();
      return;
    }

    const rawOffsetParam = url.searchParams.get('rawOffset');
    const rawOffset = rawOffsetParam !== null ? parseInt(rawOffsetParam, 10) : undefined;

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleWsAttach(ws, route.kind, route.ref, Number.isFinite(rawOffset) ? rawOffset : undefined);
    });
  });
}
