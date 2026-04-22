import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  sessions,
  actualViewerPort,
  resolveSession,
  resolveAttachTarget,
  getViewerBaseUrl,
  buildViewerSessionUrl,
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
  DEFAULT_DASHBOARD_WIDTH,
  DEFAULT_DASHBOARD_HEIGHT,
  DEFAULT_DASHBOARD_LEFT_CHARS,
  DEFAULT_DASHBOARD_RIGHT_EVENTS,
  INSTANCE_ID,
  PROFILES,
  sweepSessions,
  refreshActiveSession,
  type SessionWriteRecord,
  McpError,
  ErrorCode,
} from './server-state.js';
import {
  renderViewerHomePage,
  renderViewerBindingPage,
  renderViewerSessionPage,
  renderXtermBindingPage,
  renderXtermSessionPage,
} from './viewer-html.js';
import {
  matchViewerHttpRoute,
  type ViewerAttachKind,
} from './viewer-routes.js';

interface ViewerResponseWriters {
  writeError(statusCode: number, error: unknown): void;
  writeHtml(statusCode: number, html: string): void;
  writeJson(statusCode: number, payload: unknown): void;
  writeText(statusCode: number, text: string): void;
}

function createViewerResponseWriters(response: ServerResponse): ViewerResponseWriters {
  return {
    writeJson(statusCode, payload) {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload, null, 2));
    },
    writeHtml(statusCode, html) {
      response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    },
    writeText(statusCode, text) {
      response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(text);
    },
    writeError(statusCode, error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: message }, null, 2));
    },
  };
}

function isSessionWriteRecordCandidate(value: unknown): value is {
  actor?: string;
  text: string;
  type: 'input' | 'control';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    actor?: unknown;
    text?: unknown;
    type?: unknown;
  };

  return (candidate.type === 'input' || candidate.type === 'control')
    && typeof candidate.text === 'string'
    && (typeof candidate.actor === 'undefined' || typeof candidate.actor === 'string');
}

function parseAttachReadOptions(searchParams: URLSearchParams) {
  return {
    requestedOutputOffset: parseOptionalNonNegativeQueryInt(searchParams.get('outputOffset')),
    requestedEventSeq: parseOptionalNonNegativeQueryInt(searchParams.get('eventSeq')),
    maxChars: parsePositiveQueryInt(searchParams.get('maxChars'), DEFAULT_DASHBOARD_LEFT_CHARS),
    maxEvents: parsePositiveQueryInt(searchParams.get('maxEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS * 4),
    waitMs: parseNonNegativeQueryInt(searchParams.get('waitMs'), 0),
  };
}

function parseViewerSnapshotOptions(searchParams: URLSearchParams) {
  return {
    width: parsePositiveQueryInt(searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH),
    height: parsePositiveQueryInt(searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT),
    leftChars: parsePositiveQueryInt(searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS),
    rightEvents: parsePositiveQueryInt(searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS),
    stripAnsiFromLeft: parseBooleanQuery(searchParams.get('stripAnsiFromLeft'), true),
  };
}

function createRequestAbortScope(request: IncomingMessage) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  request.once('close', abort);
  request.once('aborted', abort);

  return {
    signal: controller.signal,
    cleanup() {
      request.off('close', abort);
      request.off('aborted', abort);
    },
  };
}

function buildHealthPayload() {
  return {
    ok: true,
    instanceId: INSTANCE_ID,
    configPath: PROFILES.path,
    viewerBaseUrl: getViewerBaseUrl(),
    viewerPort: actualViewerPort || undefined,
    sessions: sessions.size,
  };
}

function buildSessionsPayload() {
  sweepSessions();
  return {
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
  };
}

async function handleAttachReadRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  url: URL,
  writers: ViewerResponseWriters,
) {
  try {
    const { binding, session } = resolveAttachTarget(kind, ref);
    const options = parseAttachReadOptions(url.searchParams);
    const baselineOutputOffset = typeof options.requestedOutputOffset === 'number'
      ? options.requestedOutputOffset
      : session.currentBufferEnd();
    const baselineEventSeq = typeof options.requestedEventSeq === 'number'
      ? options.requestedEventSeq
      : session.currentEventEnd();

    if (options.waitMs > 0) {
      const abortScope = createRequestAbortScope(request);
      try {
        await session.waitForChange({
          outputOffset: baselineOutputOffset,
          eventSeq: baselineEventSeq,
          waitMs: options.waitMs,
          signal: abortScope.signal,
        });
      } finally {
        abortScope.cleanup();
      }
    }

    if (request.destroyed) {
      return;
    }

    writers.writeJson(200, createAttachPayload(session, {
      bindingKey: binding?.bindingKey,
      outputOffset: options.requestedOutputOffset,
      eventSeq: options.requestedEventSeq,
      maxChars: options.maxChars,
      maxEvents: options.maxEvents,
    }));
  } catch (error) {
    writers.writeError(404, error);
  }
}

async function handleAttachInputRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  writers: ViewerResponseWriters,
) {
  try {
    const { session } = resolveAttachTarget(kind, ref);
    const body = await readJsonRequestBody(request);
    const rawData = typeof body.data === 'string' ? body.data : undefined;

    if (!rawData || rawData.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'data must be a non-empty string');
    }

    if (session.inputLock === 'agent') {
      throw new McpError(ErrorCode.InvalidRequest, 'Input locked by AI agent. Switch the terminal back to common or user mode before typing here.');
    }

    const records: SessionWriteRecord[] = [];

    if (Array.isArray(body.records)) {
      for (const value of body.records) {
        if (!isSessionWriteRecordCandidate(value)) {
          continue;
        }

        records.push({
          actor: sanitizeActor(value.actor, 'user'),
          text: value.text,
          type: value.type,
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
    logSessionEvent(session.sessionId, 'session.input', {
      actor: records[0]?.actor || 'user',
      sentChars: rawData.length,
    });
    writers.writeJson(200, {
      ok: true,
      ...session.summary(),
      recordedEvents: records.length,
      nextOutputOffset: session.currentBufferEnd(),
      nextEventSeq: session.currentEventEnd(),
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

async function handleAttachResizeRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  writers: ViewerResponseWriters,
) {
  try {
    const { session } = resolveAttachTarget(kind, ref);
    const body = await readJsonRequestBody(request);
    const cols = typeof body.cols === 'number' ? body.cols : Number(body.cols);
    const rows = typeof body.rows === 'number' ? body.rows : Number(body.rows);
    const resolvedCols = sanitizePositiveInt(cols, 'cols', session.cols);
    const resolvedRows = sanitizePositiveInt(rows, 'rows', session.rows);

    session.resize(resolvedCols, resolvedRows);
    writers.writeJson(200, {
      ok: true,
      ...session.summary(),
      cols: resolvedCols,
      rows: resolvedRows,
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

function handleSessionApiRequest(sessionRef: string, url: URL, writers: ViewerResponseWriters) {
  try {
    const session = resolveSession(sessionRef);
    writers.writeJson(200, createViewerPayload(session, parseViewerSnapshotOptions(url.searchParams)));
  } catch (error) {
    writers.writeError(404, error);
  }
}

function handleViewerBindingApiRequest(bindingKey: string, url: URL, writers: ViewerResponseWriters) {
  try {
    writers.writeJson(200, createViewerBindingPayload(bindingKey, parseViewerSnapshotOptions(url.searchParams)));
  } catch (error) {
    writers.writeError(404, error);
  }
}

export async function handleViewerHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const route = matchViewerHttpRoute(request.method, url.pathname);
  const writers = createViewerResponseWriters(response);

  switch (route.type) {
    case 'health':
      writers.writeJson(200, buildHealthPayload());
      return;
    case 'sessions-api':
      writers.writeJson(200, buildSessionsPayload());
      return;
    case 'attach-read':
      await handleAttachReadRequest(request, route.kind, route.ref, url, writers);
      return;
    case 'attach-input':
      await handleAttachInputRequest(request, route.kind, route.ref, writers);
      return;
    case 'attach-resize':
      await handleAttachResizeRequest(request, route.kind, route.ref, writers);
      return;
    case 'session-api':
      handleSessionApiRequest(route.sessionRef, url, writers);
      return;
    case 'viewer-binding-api':
      handleViewerBindingApiRequest(route.bindingKey, url, writers);
      return;
    case 'terminal-session-page':
      writers.writeHtml(200, renderXtermSessionPage(route.sessionRef));
      return;
    case 'terminal-binding-page':
      writers.writeHtml(200, renderXtermBindingPage(route.bindingKey));
      return;
    case 'legacy-session-page':
      writers.writeHtml(200, renderViewerSessionPage(route.sessionRef));
      return;
    case 'legacy-binding-page':
      writers.writeHtml(200, renderViewerBindingPage(route.bindingKey));
      return;
    case 'home-page':
      writers.writeHtml(200, renderViewerHomePage());
      return;
    case 'not-found':
      writers.writeText(404, 'Not found');
      return;
  }
}
