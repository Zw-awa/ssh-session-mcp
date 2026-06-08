import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const previousArgv = [...process.argv];
const envKeys = [
  'SSH_MCP_DISABLE_MAIN',
  'SSH_MCP_CONFIG',
  'SSH_MCP_STATE_DIR',
  'SSH_MCP_RUNTIME_MODE',
  'SSH_MCP_STORE',
  'SSH_MCP_AUTH_MODE',
  'SSH_MCP_TRUST_PROXY',
  'SSH_MCP_PUBLIC_BASE_URL',
  'SSH_MCP_NODE_ID',
  'SSH_MCP_AUTH_USER_HEADER',
  'SSH_MCP_AUTH_ROLE_HEADER',
  'VIEWER_PORT',
  'VIEWER_HOST',
] as const;
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]])) as Record<string, string | undefined>;

interface MockResponseState {
  body: string;
  headers: Record<string, string>;
  headersSent: boolean;
  statusCode?: number;
}

function restoreProcessState() {
  process.argv = [...previousArgv];
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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
  headers: Record<string, string>;
  private readonly body: string;

  constructor(url: string, options?: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  }) {
    super();
    this.method = options?.method ?? 'GET';
    this.url = url;
    this.headers = options?.headers || {};
    this.body = options?.body ?? '';
  }

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === 'close' || eventName === 'aborted') {
      this.destroyed = true;
    }
    return super.emit(eventName, ...args);
  }

  async *[Symbol.asyncIterator]() {
    if (this.body.length > 0) {
      yield Buffer.from(this.body, 'utf8');
    }
  }
}

function createMockRequest(url: string, options?: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
}) {
  return new MockRequest(url, options) as any;
}

function buildClusterSessionRecord(overrides: Partial<any> = {}) {
  return {
    summary: {
      sessionId: 'demo-session',
      sessionName: 'demo',
      sessionRef: 'demo-ref',
      instanceId: 'instance-a',
      profileSource: 'manual',
      ownerNodeId: 'node-b',
      routableBaseUrl: 'https://node-b.example.test',
      distributedMode: 'distributed',
      sessionAvailability: 'remote',
      host: 'device-a',
      port: 22,
      user: 'root',
      cols: 120,
      rows: 40,
      term: 'xterm-256color',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:00.000Z',
      lastActivityAt: '2026-06-07T00:00:00.000Z',
      idleTimeoutMs: 0,
      closed: false,
      bufferStart: 0,
      bufferEnd: 0,
      eventStartSeq: 0,
      eventEndSeq: 0,
      customPolicyRuleCount: 0,
      operationMode: 'safe',
      lockPolicy: 'common',
      inputLock: 'none',
      userDraftActive: false,
    },
    ownerNodeId: 'node-b',
    routableBaseUrl: 'https://node-b.example.test',
    availability: 'remote',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

function createMockSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: 'demo-session',
    sessionName: 'demo',
    metadata: {
      sessionRef: 'demo-ref',
      ownerNodeId: 'node-a',
      routableBaseUrl: 'https://node-a.example.test',
      distributedMode: 'distributed',
      sessionAvailability: 'local',
    },
    updatedAt: '2026-06-07T00:00:01.000Z',
    lastActivityAt: '2026-06-07T00:00:01.000Z',
    closed: false,
    idleTimeoutMs: 0,
    host: 'device-a',
    port: 22,
    user: 'root',
    cols: 120,
    rows: 40,
    rawBufferStart: 0,
    rawBuffer: Buffer.from('abc'),
    buffer: '$ ',
    operationMode: 'safe',
    inputLock: 'none' as const,
    summary: vi.fn(() => ({
      sessionId: 'demo-session',
      sessionName: 'demo',
      sessionRef: 'demo-ref',
      instanceId: 'instance-a',
      profileSource: 'manual',
      ownerNodeId: 'node-a',
      routableBaseUrl: 'https://node-a.example.test',
      distributedMode: 'distributed',
      sessionAvailability: 'local',
      host: 'device-a',
      port: 22,
      user: 'root',
      cols: 120,
      rows: 40,
      term: 'xterm-256color',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:01.000Z',
      lastActivityAt: '2026-06-07T00:00:01.000Z',
      idleTimeoutMs: 0,
      closed: false,
      bufferStart: 0,
      bufferEnd: 3,
      eventStartSeq: 0,
      eventEndSeq: 0,
      customPolicyRuleCount: 0,
      operationMode: 'safe',
      lockPolicy: 'common',
      inputLock: 'none',
      userDraftActive: false,
    })),
    currentBufferEnd: vi.fn(() => 3),
    currentEventEnd: vi.fn(() => 0),
    read: vi.fn(() => ({
      requestedOffset: 0,
      effectiveOffset: 0,
      nextOffset: 3,
      availableStart: 0,
      availableEnd: 3,
      truncatedBefore: false,
      truncatedAfter: false,
      output: 'abc',
    })),
    readEvents: vi.fn(() => ({
      requestedEventSeq: 0,
      effectiveEventSeq: 0,
      nextEventSeq: 0,
      availableStartSeq: 0,
      availableEndSeq: 0,
      truncatedBefore: false,
      truncatedAfter: false,
      events: [],
    })),
    getConversationEvents: vi.fn(() => []),
    waitForChange: vi.fn(async () => {}),
    effectiveInputLock: vi.fn(() => 'none'),
    writeRaw: vi.fn(),
    resize: vi.fn(),
    setOperationMode: vi.fn(function (this: any, mode: 'safe' | 'full') {
      this.operationMode = mode;
    }),
    close: vi.fn(),
    shouldCloseForIdle: vi.fn(() => false),
    shouldPrune: vi.fn(() => false),
    ...overrides,
  };
}

async function loadModules(options?: {
  viewerPort?: string;
}) {
  restoreProcessState();
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-distributed-viewer-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');
  writeFileSync(configPath, JSON.stringify({
    defaults: {
      runtimeMode: 'distributed',
      store: 'memory',
      authMode: 'proxy',
      trustProxy: true,
      publicBaseUrl: 'https://node-a.example.test',
      nodeId: 'node-a',
      authUserHeader: 'x-ssh-session-mcp-user',
      authRoleHeader: 'x-ssh-session-mcp-role',
    },
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.SSH_MCP_STATE_DIR = join(dir, 'state');
  process.env.VIEWER_PORT = options?.viewerPort ?? '0';
  process.env.VIEWER_HOST = '127.0.0.1';
  process.argv = ['node', 'distributed-viewer.test.ts'];

  const serverState = await import('../src/server-state.js');
  const handlerModule = await import('../src/viewer-http-handler.js');
  const viewerServerModule = await import('../src/viewer-server.js');
  return {
    dir,
    serverState,
    handleViewerHttpRequest: handlerModule.handleViewerHttpRequest,
    startViewerServer: viewerServerModule.startViewerServer,
  };
}

async function cleanupModules(serverState: Awaited<ReturnType<typeof loadModules>>['serverState']) {
  serverState.sessions.clear();
  serverState.viewerBindings.clear();
  serverState.clusterSessions.clear();
  serverState.clusterBindings.clear();
  serverState.clusterCommands.clear();
  await serverState.distributedStateStore?.close();
  serverState.setViewerWss(undefined);
  if (serverState.viewerServer) {
    await new Promise<void>(resolve => serverState.viewerServer?.close(() => resolve()));
    serverState.setViewerServer(undefined);
  }
  serverState.setActualViewerPort(0);
}

afterEach(() => {
  restoreProcessState();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('distributed viewer behavior', () => {
  it('returns 403 when proxy auth headers are missing', async () => {
    const { serverState, handleViewerHttpRequest } = await loadModules();
    try {
      const { response, state } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/sessions'), response);

      expect(state.statusCode).toBe(403);
      expect(JSON.parse(state.body).error).toContain('Missing trusted viewer identity headers.');
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('enforces viewer_read, viewer_write, and session_admin roles over HTTP', async () => {
    const { serverState, handleViewerHttpRequest } = await loadModules();
    const session = createMockSession();
    serverState.sessions.set('demo-session', session as any);

    try {
      const readHeaders = {
        'x-ssh-session-mcp-user': 'alice',
        'x-ssh-session-mcp-role': 'viewer_read',
      };
      const writeHeaders = {
        'x-ssh-session-mcp-user': 'bob',
        'x-ssh-session-mcp-role': 'viewer_write',
      };
      const adminHeaders = {
        'x-ssh-session-mcp-user': 'carol',
        'x-ssh-session-mcp-role': 'session_admin',
      };

      const { response: readResponse, state: readState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/session/demo-session', { headers: readHeaders }), readResponse);
      expect(readState.statusCode).toBe(200);

      const { response: deniedWriteResponse, state: deniedWriteState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        headers: readHeaders,
        body: JSON.stringify({ data: 'pwd\r' }),
      }), deniedWriteResponse);
      expect(deniedWriteState.statusCode).toBe(403);
      expect(session.writeRaw).not.toHaveBeenCalled();

      const { response: writeResponse, state: writeState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/attach/session/demo-session/input', {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify({ data: 'pwd\r' }),
      }), writeResponse);
      expect(writeState.statusCode).toBe(200);
      expect(session.writeRaw).toHaveBeenCalledWith('pwd\r', []);

      const { response: deniedAdminResponse, state: deniedAdminState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/session/demo-session/mode', {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify({ mode: 'full' }),
      }), deniedAdminResponse);
      expect(deniedAdminState.statusCode).toBe(403);

      const { response: adminResponse, state: adminState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/session/demo-session/mode', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ mode: 'full' }),
      }), adminResponse);
      expect(adminState.statusCode).toBe(200);
      expect(session.setOperationMode).toHaveBeenCalledWith('full');
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('returns unified remote-owner payloads for API and page routes', async () => {
    const { serverState, handleViewerHttpRequest } = await loadModules();
    await serverState.distributedStateStore!.saveSession(buildClusterSessionRecord());

    try {
      const headers = {
        'x-ssh-session-mcp-user': 'alice',
        'x-ssh-session-mcp-role': 'viewer_read',
      };

      const { response: apiResponse, state: apiState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/api/session/demo-session', { headers }), apiResponse);
      expect(apiState.statusCode).toBe(409);
      expect(JSON.parse(apiState.body)).toMatchObject({
        error: 'REMOTE_OWNER',
        ownerNodeId: 'node-b',
        routableBaseUrl: 'https://node-b.example.test',
        redirectUrl: 'https://node-b.example.test/api/session/demo-session',
        availability: 'remote',
        sessionId: 'demo-session',
      });

      const { response: pageResponse, state: pageState } = createMockResponse();
      await handleViewerHttpRequest(createMockRequest('/terminal/session/demo-session', { headers }), pageResponse);
      expect(pageState.statusCode).toBe(409);
      expect(pageState.headers['content-type']).toContain('text/html');
      expect(pageState.body).toContain('Remote Session Owner');
      expect(pageState.body).toContain('node-b');
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('rejects websocket upgrades without trusted proxy headers', async () => {
    const { serverState, startViewerServer } = await loadModules({ viewerPort: 'auto' });

    try {
      await startViewerServer();
      const ws = new WebSocket(`ws://127.0.0.1:${serverState.actualViewerPort}/ws/attach/session/demo-session`);

      const responsePromise = once(ws as any, 'unexpected-response');
      const [, response] = await responsePromise;
      expect((response as any).statusCode).toBe(403);
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('closes websocket attaches with code 4009 for remote owners', async () => {
    const { serverState, startViewerServer } = await loadModules({ viewerPort: 'auto' });
    await serverState.distributedStateStore!.saveSession(buildClusterSessionRecord());

    try {
      await startViewerServer();
      const ws = new WebSocket(`ws://127.0.0.1:${serverState.actualViewerPort}/ws/attach/session/demo-session`, {
        headers: {
          'x-ssh-session-mcp-user': 'alice',
          'x-ssh-session-mcp-role': 'viewer_read',
        },
      });

      const [code, reason] = await once(ws as any, 'close');
      expect(code).toBe(4009);
      expect(String(reason)).toContain('remote owner node-b');
    } finally {
      await cleanupModules(serverState);
    }
  });
});
