import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface MockResponseState {
  body: string;
  headers: Record<string, string>;
  headersSent: boolean;
  statusCode?: number;
}

function createMockResponse() {
  const state: MockResponseState = {
    body: '',
    headers: {},
    headersSent: false,
  };

  const response = {
    get headersSent() {
      return state.headersSent;
    },
    writeHead(statusCode: number, headers: Record<string, string>) {
      state.statusCode = statusCode;
      state.headers = headers;
      return response;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk !== 'undefined') {
        state.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      }
      state.headersSent = true;
      return response;
    },
  };

  return {
    response: response as any,
    state,
  };
}

class MockRequest extends EventEmitter {
  destroyed = false;
  method: string;
  url: string;
  private readonly body: string;
  private readonly chunks?: Array<string | Buffer>;

  constructor(url: string, options?: {
    body?: string;
    chunks?: Array<string | Buffer>;
    method?: string;
  }) {
    super();
    this.method = options?.method ?? 'GET';
    this.url = url;
    this.body = options?.body ?? '';
    this.chunks = options?.chunks;
  }

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === 'close' || eventName === 'aborted') {
      this.destroyed = true;
    }
    return super.emit(eventName, ...args);
  }

  async *[Symbol.asyncIterator]() {
    if (Array.isArray(this.chunks)) {
      for (const chunk of this.chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      }
      return;
    }
    if (this.body.length > 0) {
      yield Buffer.from(this.body, 'utf8');
    }
  }
}

function createMockRequest(url: string, options?: {
  body?: string;
  chunks?: Array<string | Buffer>;
  method?: string;
}) {
  return new MockRequest(url, options) as any;
}

function createMockSession(overrides: Partial<Record<string, unknown>> = {}) {
  const updatedAt = '2026-04-22T12:00:01.000Z';
  const summary = {
    sessionId: 'demo-session',
    sessionName: 'demo',
    sessionRef: 'demo-ref',
    instanceId: 'test-instance',
    host: '192.168.10.58',
    port: 22,
    user: 'orangepi',
    cols: 120,
    rows: 40,
    term: 'xterm-256color',
    createdAt: '2026-04-22T12:00:00.000Z',
    updatedAt,
    lastActivityAt: updatedAt,
    idleTimeoutMs: 0,
    closed: false,
    bufferStart: 0,
    bufferEnd: 8,
    eventStartSeq: 1,
    eventEndSeq: 2,
    inputLock: 'none' as const,
  };

  const session = {
    sessionId: 'demo-session',
    sessionName: 'demo',
    metadata: { sessionRef: 'demo-ref' },
    updatedAt,
    closed: false,
    host: '192.168.10.58',
    port: 22,
    user: 'orangepi',
    cols: 120,
    rows: 40,
    inputLock: 'none' as 'none' | 'agent' | 'user',
    summary: vi.fn(() => summary),
    currentBufferEnd: vi.fn(() => 8),
    currentEventEnd: vi.fn(() => 2),
    waitForChange: vi.fn(async () => {}),
    read: vi.fn(() => ({
      requestedOffset: 8,
      effectiveOffset: 8,
      nextOffset: 11,
      availableStart: 0,
      availableEnd: 11,
      truncatedBefore: false,
      truncatedAfter: false,
      output: 'abc',
    })),
    readEvents: vi.fn(() => ({
      requestedEventSeq: 2,
      effectiveEventSeq: 2,
      nextEventSeq: 3,
      availableStartSeq: 1,
      availableEndSeq: 3,
      truncatedBefore: false,
      truncatedAfter: false,
      events: [
        { seq: 2, at: '2026-04-22T12:00:02.000Z', type: 'input', text: 'ls', actor: 'user' },
      ],
    })),
    writeRaw: vi.fn(),
    resize: vi.fn(),
    ...overrides,
  };

  return session;
}

let handleViewerHttpRequest: typeof import('../src/viewer-http-handler.js').handleViewerHttpRequest;
let sessions: typeof import('../src/server-state.js').sessions;
let viewerBindings: typeof import('../src/server-state.js').viewerBindings;
let setActualViewerPort: typeof import('../src/server-state.js').setActualViewerPort;
let setOperationMode: typeof import('../src/server-state.js').setOperationMode;
let setViewerWss: typeof import('../src/server-state.js').setViewerWss;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  VIEWER_PORT: process.env.VIEWER_PORT,
  VIEWER_HOST: process.env.VIEWER_HOST,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-http-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');

  writeFileSync(configPath, JSON.stringify({
    defaultDevice: 'board-a',
    devices: [
      {
        id: 'board-a',
        host: '192.168.10.58',
        user: 'orangepi',
        auth: { passwordEnv: 'BOARD_A_PASSWORD' },
      },
    ],
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.VIEWER_PORT = '8793';
  process.env.VIEWER_HOST = '127.0.0.1';
  process.env.BOARD_A_PASSWORD = 'dummy-password';

  const serverState = await import('../src/server-state.js');
  sessions = serverState.sessions;
  viewerBindings = serverState.viewerBindings;
  setActualViewerPort = serverState.setActualViewerPort;
  setOperationMode = serverState.setOperationMode;
  setViewerWss = serverState.setViewerWss;

  const handlerModule = await import('../src/viewer-http-handler.js');
  handleViewerHttpRequest = handlerModule.handleViewerHttpRequest;
});

afterEach(() => {
  sessions.clear();
  viewerBindings.clear();
  setViewerWss(undefined);
  setActualViewerPort(0);
  setOperationMode('safe');
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('viewer http handler', () => {
  it('returns health metadata with the active viewer base url', async () => {
    setActualViewerPort(8793);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(createMockRequest('/health'), response);

    expect(state.statusCode).toBe(200);
    expect(state.headers['content-type']).toContain('application/json');
    expect(JSON.parse(state.body)).toMatchObject({
      ok: true,
      viewerBaseUrl: 'http://127.0.0.1:8793',
      viewerPort: 8793,
      sessions: 0,
    });
  });

  it('waits for attach output using the current buffer/event end when offsets are omitted', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session?waitMs=25&maxChars=12&maxEvents=3'),
      response,
    );

    expect(session.waitForChange).toHaveBeenCalledWith({
      outputOffset: 8,
      eventSeq: 2,
      waitMs: 25,
    });
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      summary: { sessionId: 'demo-session' },
      output: 'abc',
      nextOutputOffset: 11,
      nextEventSeq: 3,
    });
  });

  it('aborts long-poll waiting and removes request listeners when the client disconnects', async () => {
    const request = createMockRequest('/api/attach/session/demo-session?waitMs=9999');
    const session = createMockSession({
      waitForChange: vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<void>(resolve => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      })),
    });
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    const pending = handleViewerHttpRequest(request, response);
    expect(request.listenerCount('close')).toBe(1);
    expect(request.listenerCount('aborted')).toBe(1);

    request.emit('close');
    await pending;

    expect(session.waitForChange).toHaveBeenCalledWith({
      outputOffset: 8,
      eventSeq: 2,
      waitMs: 9999,
      signal: expect.any(AbortSignal),
    });
    expect(request.listenerCount('close')).toBe(0);
    expect(request.listenerCount('aborted')).toBe(0);
    expect(state.headersSent).toBe(false);
  });

  it('returns sorted session summaries and the refreshed active session from /api/sessions', async () => {
    setActualViewerPort(8793);
    const older = createMockSession({
      sessionId: 'session-old',
      sessionName: 'old',
      metadata: { sessionRef: 'old-ref' },
      updatedAt: '2026-04-22T12:00:00.000Z',
      summary: vi.fn(() => ({
        ...createMockSession().summary(),
        sessionId: 'session-old',
        sessionName: 'old',
        sessionRef: 'old-ref',
        updatedAt: '2026-04-22T12:00:00.000Z',
      })),
    });
    const newer = createMockSession({
      sessionId: 'session-new',
      sessionName: 'new',
      metadata: { sessionRef: 'new-ref' },
      updatedAt: '2026-04-22T12:05:00.000Z',
      summary: vi.fn(() => ({
        ...createMockSession().summary(),
        sessionId: 'session-new',
        sessionName: 'new',
        sessionRef: 'new-ref',
        updatedAt: '2026-04-22T12:05:00.000Z',
      })),
    });
    sessions.set('session-old', older as any);
    sessions.set('session-new', newer as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(createMockRequest('/api/sessions'), response);

    const payload = JSON.parse(state.body);
    expect(payload.activeSessionRef).toBe('new-ref');
    expect(payload.viewerBaseUrl).toBe('http://127.0.0.1:8793');
    expect(payload.sessions).toHaveLength(2);
    expect(payload.sessions[0]).toMatchObject({
      sessionId: 'session-new',
      viewerUrl: 'http://127.0.0.1:8793/session/session-new',
    });
    expect(payload.sessions[1]).toMatchObject({
      sessionId: 'session-old',
    });
  });

  it('returns attach payloads through binding routes without waiting when waitMs is omitted', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    viewerBindings.set('demo-binding', {
      bindingKey: 'demo-binding',
      connectionKey: 'conn-demo',
      host: '192.168.10.58',
      port: 22,
      user: 'orangepi',
      sessionId: 'demo-session',
      scope: 'connection',
      updatedAt: '2026-04-22T12:00:00.000Z',
    });
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/binding/demo-binding?outputOffset=4&eventSeq=1&maxChars=9&maxEvents=2'),
      response,
    );

    expect(session.waitForChange).not.toHaveBeenCalled();
    expect(JSON.parse(state.body)).toMatchObject({
      bindingKey: 'demo-binding',
      summary: { sessionId: 'demo-session' },
    });
  });

  it('returns 404 for attach reads targeting an unknown session', async () => {
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/missing-session'),
      response,
    );

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toContain('Unknown session');
  });

  it('rejects attach input when the session is locked by the agent', async () => {
    const session = createMockSession({
      inputLock: 'agent',
    });
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        body: JSON.stringify({ data: 'ls\r' }),
      }),
      response,
    );

    expect(session.writeRaw).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toContain('Input locked by AI agent');
  });

  it('accepts legacy attach input payloads via displayText/recordType fallback', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        body: JSON.stringify({
          data: 'pwd\r',
          actor: '  codex  ',
          displayText: 'pwd',
          recordType: 'input',
        }),
      }),
      response,
    );

    expect(session.writeRaw).toHaveBeenCalledWith('pwd\r', [
      { actor: 'codex', text: 'pwd', type: 'input' },
    ]);
    expect(JSON.parse(state.body)).toMatchObject({
      ok: true,
      recordedEvents: 1,
      nextOutputOffset: 8,
      nextEventSeq: 2,
    });
  });

  it('rejects attach input with an empty data field', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        body: JSON.stringify({ data: '' }),
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toContain('data must be a non-empty string');
    expect(session.writeRaw).not.toHaveBeenCalled();
  });

  it('rejects malformed attach input JSON bodies', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        body: '{"data":',
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toContain('Invalid JSON body');
    expect(session.writeRaw).not.toHaveBeenCalled();
  });

  it('rejects attach input request bodies larger than 1 MiB', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        chunks: ['{"data":"', 'x'.repeat(1024 * 1024), '"}'],
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toContain('Request body exceeds 1 MiB');
    expect(session.writeRaw).not.toHaveBeenCalled();
  });

  it('resizes the target session with sanitized numeric values', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/resize', {
        method: 'POST',
        body: JSON.stringify({ cols: '140', rows: '55' }),
      }),
      response,
    );

    expect(session.resize).toHaveBeenCalledWith(140, 55);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      ok: true,
      cols: 140,
      rows: 55,
    });
  });

  it('rejects invalid resize values instead of mutating the session', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/attach/session/demo-session/resize', {
        method: 'POST',
        body: JSON.stringify({ cols: 0, rows: -1 }),
      }),
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).error).toContain('positive integer');
    expect(session.resize).not.toHaveBeenCalled();
  });

  it('returns a session dashboard payload with parsed query options', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/session/demo-session?width=80&height=20&leftChars=50&rightEvents=5&stripAnsiFromLeft=false'),
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      summary: { sessionId: 'demo-session' },
      dashboardWidth: 80,
      dashboardHeight: 20,
      dashboardLeftChars: 50,
      dashboardRightEvents: 5,
      stripAnsiFromLeft: false,
    });
  });

  it('returns 404 for missing session dashboard requests', async () => {
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(createMockRequest('/api/session/missing-session'), response);

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).error).toContain('Unknown session');
  });

  it('returns an unattached binding placeholder payload instead of failing', async () => {
    setActualViewerPort(8793);
    const { response, state } = createMockResponse();

    await handleViewerHttpRequest(
      createMockRequest('/api/viewer-binding/missing-binding?width=70&height=18'),
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      bindingKey: 'missing-binding',
      summary: null,
      binding: null,
      viewerBaseUrl: 'http://127.0.0.1:8793',
      dashboardWidth: 70,
      dashboardHeight: 18,
    });
  });

  it('renders HTML for viewer pages and plain text for unknown routes', async () => {
    const { response: homeResponse, state: homeState } = createMockResponse();
    await handleViewerHttpRequest(createMockRequest('/'), homeResponse);
    expect(homeState.statusCode).toBe(200);
    expect(homeState.headers['content-type']).toContain('text/html');
    expect(homeState.body).toContain('SSH Session MCP Viewer');

    const { response: terminalResponse, state: terminalState } = createMockResponse();
    await handleViewerHttpRequest(createMockRequest('/terminal/session/missing-session'), terminalResponse);
    expect(terminalState.statusCode).toBe(200);
    expect(terminalState.headers['content-type']).toContain('text/html');
    expect(terminalState.body).toContain('Session not found');

    const { response: missingResponse, state: missingState } = createMockResponse();
    await handleViewerHttpRequest(createMockRequest('/definitely-missing'), missingResponse);
    expect(missingState.statusCode).toBe(404);
    expect(missingState.headers['content-type']).toContain('text/plain');
    expect(missingState.body).toBe('Not found');
  });
});
