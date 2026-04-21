import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import {
  sessions,
  viewerBindings,
  viewerProcesses,
  viewerServer,
  viewerWss,
  actualViewerPort,
  setViewerServer,
  setViewerWss,
  setActualViewerPort,
  resolveSession,
  resolveAttachTarget,
  resolveSessionForBinding,
  getViewerBaseUrl,
  buildViewerBindingUrl,
  buildViewerSessionUrl,
  buildViewerBindingKeyForSession,
  createViewerPayload,
  createViewerBindingPayload,
  createAttachPayload,
  parsePositiveQueryInt,
  parseOptionalNonNegativeQueryInt,
  parseNonNegativeQueryInt,
  parseBooleanQuery,
  readJsonRequestBody,
  sanitizeActor,
  sanitizePositiveInt,
  logSessionEvent,
  logServerEvent,
  broadcastLock,
  OPERATION_MODE,
  setOperationMode,
  DEFAULT_VIEWER_HOST,
  DEFAULT_VIEWER_REFRESH_MS,
  DEFAULT_DASHBOARD_WIDTH,
  DEFAULT_DASHBOARD_HEIGHT,
  DEFAULT_DASHBOARD_LEFT_CHARS,
  DEFAULT_DASHBOARD_RIGHT_EVENTS,
  VIEWER_PORT_SETTING,
  INSTANCE_ID,
  PROFILES,
  escapeHtml,
  sessionDisplayName,
  sweepSessions,
  refreshActiveSession,
  saveServerInfoState,
  type ViewerBindingState,
  type OperationMode,
  type SessionWriteRecord,
  SSHSession,
  McpError,
  ErrorCode,
} from './server-state.js';

import {
  renderViewerHomePage,
  renderViewerErrorPage,
  renderViewerSessionPage,
  renderViewerBindingPage,
  renderXtermTerminalPage,
  renderXtermSessionPage,
  renderXtermBindingPage,
} from './viewer-html.js';

export function handleWsAttach(ws: WebSocket, kind: 'session' | 'binding', ref: string, rawOffset?: number) {
  let session: SSHSession;
  let bindingKey: string | undefined;

  try {
    const target = resolveAttachTarget(kind, ref);
    session = target.session;
    bindingKey = target.binding?.bindingKey;
  } catch (err) {
    ws.close(4004, err instanceof Error ? err.message : 'session not found');
    return;
  }

  const currentRawEnd = session.currentRawBufferEnd();

  ws.send(JSON.stringify({
    type: 'init',
    summary: session.summary(),
    bindingKey,
    rawBufferEnd: currentRawEnd,
  }));

  if (typeof rawOffset === 'number' && rawOffset >= session.rawBufferStart && rawOffset < currentRawEnd) {
    const slice = session.rawBuffer.slice(rawOffset - session.rawBufferStart);
    if (slice.length > 0) {
      ws.send(Buffer.from(slice), { binary: true });
    }
  } else if (typeof rawOffset !== 'number' || rawOffset < session.rawBufferStart) {
    if (session.rawBuffer.length > 0) {
      ws.send(Buffer.from(session.rawBuffer), { binary: true });
    }
  }

  const recentEvents = session.getConversationEvents(50);
  for (const event of recentEvents) {
    ws.send(JSON.stringify({ type: 'event', seq: event.seq, at: event.at, eventType: event.type, text: event.text, actor: event.actor }));
  }

  const unsubOutput = session.onRawOutput((chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  const unsubEvent = session.onEvent((event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', seq: event.seq, at: event.at, eventType: event.type, text: event.text, actor: event.actor }));
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'lock' && typeof msg.lock === 'string') {
        const validLocks = ['none', 'agent', 'user'];
        if (validLocks.includes(msg.lock)) {
          session.inputLock = msg.lock as 'none' | 'agent' | 'user';
          broadcastLock(session);
        }
        return;
      }

      if (msg.type === 'mode' && typeof msg.mode === 'string') {
        const validModes = ['safe', 'full'];
        if (validModes.includes(msg.mode)) {
          setOperationMode(msg.mode as OperationMode);
          logServerEvent('operation_mode.changed', { mode: OPERATION_MODE, sessionId: session.sessionId });
          // Broadcast mode change to all WS clients
          if (viewerWss) {
            const modeMsg = JSON.stringify({ type: 'mode', mode: OPERATION_MODE });
            for (const client of viewerWss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                try { client.send(modeMsg); } catch { /* ignore */ }
              }
            }
          }
        }
        return;
      }

      if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length > 0) {
        // Check lock: browser input is always 'user' source
        if (session.inputLock === 'agent') {
          ws.send(JSON.stringify({ type: 'lock_rejected', lock: session.inputLock, message: 'Input locked by AI agent. Switch to "common" or "user" mode to type.' }));
          return;
        }
        const records: SessionWriteRecord[] = [];
        if (Array.isArray(msg.records)) {
          for (const r of msg.records) {
            if (r && (r.type === 'input' || r.type === 'control') && typeof r.text === 'string') {
              records.push({ actor: sanitizeActor(r.actor, 'user'), text: r.text, type: r.type });
            }
          }
        }
        session.writeRaw(msg.data, records);
        logSessionEvent(session.sessionId, 'session.input', {
          actor: records[0]?.actor || 'user',
          sentChars: msg.data.length,
        });
      }

      if (msg.type === 'control' && typeof msg.key === 'string') {
        if (session.inputLock === 'agent') {
          ws.send(JSON.stringify({ type: 'lock_rejected', lock: session.inputLock, message: 'Input locked by AI agent.' }));
          return;
        }
        session.sendControl(msg.key as any, sanitizeActor(msg.actor, 'user'));
        logSessionEvent(session.sessionId, 'session.control', {
          actor: sanitizeActor(msg.actor, 'user'),
          control: msg.key,
        });
      }

      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        session.resize(
          sanitizePositiveInt(msg.cols, 'cols', session.cols),
          sanitizePositiveInt(msg.rows, 'rows', session.rows),
        );
      }
    } catch {
      // ignore invalid messages
    }
  });

  const cleanup = () => {
    unsubOutput();
    unsubEvent();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

export async function startViewerServer() {
  if (!VIEWER_PORT_SETTING.enabled || viewerServer) {
    return;
  }

  const httpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const writeJson = (statusCode: number, payload: unknown) => {
        response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(payload, null, 2));
      };
      const writeHtml = (statusCode: number, html: string) => {
        response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      };
      const writeText = (statusCode: number, text: string) => {
        response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(text);
      };
      const writeError = (statusCode: number, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(statusCode, { error: message });
      };

      const attachPrefixes = {
        binding: '/api/attach/binding/',
        session: '/api/attach/session/',
      } as const;

      const tryMatchAttachRoute = (kind: 'binding' | 'session', suffix: '' | '/input' | '/resize') => {
        const prefix = `${attachPrefixes[kind]}`;
        if (!url.pathname.startsWith(prefix)) {
          return undefined;
        }

        const rest = url.pathname.slice(prefix.length);
        if (!rest) {
          return undefined;
        }

        if (!suffix) {
          if (rest.endsWith('/input') || rest.endsWith('/resize')) {
            return undefined;
          }

          return decodeURIComponent(rest);
        }

        if (!rest.endsWith(suffix)) {
          return undefined;
        }

        return decodeURIComponent(rest.slice(0, -suffix.length));
      };

      if (url.pathname === '/health') {
        writeJson(200, {
          ok: true,
          instanceId: INSTANCE_ID,
          configPath: PROFILES.path,
          viewerBaseUrl: getViewerBaseUrl(),
          viewerPort: actualViewerPort || undefined,
          sessions: sessions.size,
        });
        return;
      }

      if (url.pathname === '/api/sessions') {
        sweepSessions();
        writeJson(200, {
          instanceId: INSTANCE_ID,
          activeSessionRef: refreshActiveSession()?.metadata.sessionRef || null,
          viewerBaseUrl: getViewerBaseUrl(),
          viewerPort: actualViewerPort || undefined,
          sessions: [...sessions.values()]
            .map(session => ({
              ...session.summary(),
              viewerUrl: buildViewerSessionUrl(session),
            }))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        });
        return;
      }

      for (const kind of ['session', 'binding'] as const) {
        const attachRef = tryMatchAttachRoute(kind, '');
        if (request.method === 'GET' && attachRef) {
          try {
            const { binding, session } = resolveAttachTarget(kind, attachRef);
            const requestedOutputOffset = parseOptionalNonNegativeQueryInt(url.searchParams.get('outputOffset'));
            const requestedEventSeq = parseOptionalNonNegativeQueryInt(url.searchParams.get('eventSeq'));
            const maxChars = parsePositiveQueryInt(url.searchParams.get('maxChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
            const maxEvents = parsePositiveQueryInt(url.searchParams.get('maxEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS * 4);
            const waitMs = parseNonNegativeQueryInt(url.searchParams.get('waitMs'), 0);
            const baselineOutputOffset = typeof requestedOutputOffset === 'number' ? requestedOutputOffset : session.currentBufferEnd();
            const baselineEventSeq = typeof requestedEventSeq === 'number' ? requestedEventSeq : session.currentEventEnd();

            if (waitMs > 0) {
              await session.waitForChange({
                outputOffset: baselineOutputOffset,
                eventSeq: baselineEventSeq,
                waitMs,
              });
            }

            writeJson(200, createAttachPayload(session, {
              bindingKey: binding?.bindingKey,
              outputOffset: requestedOutputOffset,
              eventSeq: requestedEventSeq,
              maxChars,
              maxEvents,
            }));
          } catch (error) {
            writeError(404, error);
          }
          return;
        }

        const inputRef = tryMatchAttachRoute(kind, '/input');
        if (request.method === 'POST' && inputRef) {
          try {
            const { session } = resolveAttachTarget(kind, inputRef);
            const body = await readJsonRequestBody(request);
            const rawData = typeof body.data === 'string' ? body.data : undefined;

            if (!rawData || rawData.length === 0) {
              throw new McpError(ErrorCode.InvalidRequest, 'data must be a non-empty string');
            }

            const records: SessionWriteRecord[] = [];

            if (Array.isArray(body.records)) {
              for (const value of body.records) {
                if (!value || typeof value !== 'object') {
                  continue;
                }

                const candidate = value as Record<string, unknown>;
                if ((candidate.type !== 'input' && candidate.type !== 'control') || typeof candidate.text !== 'string') {
                  continue;
                }

                records.push({
                  actor: sanitizeActor(typeof candidate.actor === 'string' ? candidate.actor : undefined, 'user'),
                  text: candidate.text,
                  type: candidate.type,
                });
              }
            } else if ((body.recordType === 'input' || body.recordType === 'control') && typeof body.displayText === 'string') {
              records.push({
                actor: sanitizeActor(typeof body.actor === 'string' ? body.actor : undefined, 'user'),
                text: body.displayText,
                type: body.recordType,
              });
            }

            session.writeRaw(rawData, records);
            writeJson(200, {
              ok: true,
              ...session.summary(),
              recordedEvents: records.length,
              nextOutputOffset: session.currentBufferEnd(),
              nextEventSeq: session.currentEventEnd(),
            });
          } catch (error) {
            writeError(400, error);
          }
          return;
        }

        const resizeRef = tryMatchAttachRoute(kind, '/resize');
        if (request.method === 'POST' && resizeRef) {
          try {
            const { session } = resolveAttachTarget(kind, resizeRef);
            const body = await readJsonRequestBody(request);
            const cols = typeof body.cols === 'number' ? body.cols : Number(body.cols);
            const rows = typeof body.rows === 'number' ? body.rows : Number(body.rows);
            const resolvedCols = sanitizePositiveInt(cols, 'cols', session.cols);
            const resolvedRows = sanitizePositiveInt(rows, 'rows', session.rows);

            session.resize(resolvedCols, resolvedRows);
            writeJson(200, {
              ok: true,
              ...session.summary(),
              cols: resolvedCols,
              rows: resolvedRows,
            });
          } catch (error) {
            writeError(400, error);
          }
          return;
        }
      }

      if (url.pathname.startsWith('/api/session/')) {
        try {
          const sessionRef = decodeURIComponent(url.pathname.slice('/api/session/'.length));
          const session = resolveSession(sessionRef);
          const width = parsePositiveQueryInt(url.searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH);
          const height = parsePositiveQueryInt(url.searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT);
          const leftChars = parsePositiveQueryInt(url.searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
          const rightEvents = parsePositiveQueryInt(url.searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS);
          const stripAnsiFromLeft = parseBooleanQuery(url.searchParams.get('stripAnsiFromLeft'), true);

          writeJson(200, createViewerPayload(session, {
            width,
            height,
            leftChars,
            rightEvents,
            stripAnsiFromLeft,
          }));
        } catch (error) {
          writeError(404, error);
        }
        return;
      }

      if (url.pathname.startsWith('/api/viewer-binding/')) {
        try {
          const bindingKey = decodeURIComponent(url.pathname.slice('/api/viewer-binding/'.length));
          const width = parsePositiveQueryInt(url.searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH);
          const height = parsePositiveQueryInt(url.searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT);
          const leftChars = parsePositiveQueryInt(url.searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
          const rightEvents = parsePositiveQueryInt(url.searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS);
          const stripAnsiFromLeft = parseBooleanQuery(url.searchParams.get('stripAnsiFromLeft'), true);

          writeJson(200, createViewerBindingPayload(bindingKey, {
            width,
            height,
            leftChars,
            rightEvents,
            stripAnsiFromLeft,
          }));
        } catch (error) {
          writeError(404, error);
        }
        return;
      }

      if (url.pathname.startsWith('/terminal/session/')) {
        const sessionRef = decodeURIComponent(url.pathname.slice('/terminal/session/'.length));
        writeHtml(200, renderXtermSessionPage(sessionRef));
        return;
      }

      if (url.pathname.startsWith('/terminal/binding/')) {
        const bindingKey = decodeURIComponent(url.pathname.slice('/terminal/binding/'.length));
        writeHtml(200, renderXtermBindingPage(bindingKey));
        return;
      }

      // PREPARE_DEPRECATION: Keep legacy polling browser routes reachable during migration.
      // New browser entrypoints should prefer /terminal/session/* and /terminal/binding/*.
      if (url.pathname.startsWith('/session/')) {
        const sessionRef = decodeURIComponent(url.pathname.slice('/session/'.length));
        writeHtml(200, renderViewerSessionPage(sessionRef));
        return;
      }

      if (url.pathname.startsWith('/binding/')) {
        const bindingKey = decodeURIComponent(url.pathname.slice('/binding/'.length));
        writeHtml(200, renderViewerBindingPage(bindingKey));
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        writeHtml(200, renderViewerHomePage());
        return;
      }

      writeText(404, 'Not found');
    })().catch(error => {
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
    const sessionMatch = url.pathname.match(/^\/ws\/attach\/session\/(.+)$/);
    const bindingMatch = url.pathname.match(/^\/ws\/attach\/binding\/(.+)$/);

    if (!sessionMatch && !bindingMatch) {
      socket.destroy();
      return;
    }

    const kind: 'session' | 'binding' = sessionMatch ? 'session' : 'binding';
    const ref = decodeURIComponent((sessionMatch || bindingMatch)![1]);
    const rawOffsetParam = url.searchParams.get('rawOffset');
    const rawOffset = rawOffsetParam !== null ? parseInt(rawOffsetParam, 10) : undefined;

    wss.handleUpgrade(request, socket as any, head, (ws) => {
      handleWsAttach(ws, kind, ref, Number.isFinite(rawOffset) ? rawOffset : undefined);
    });
  });
}
