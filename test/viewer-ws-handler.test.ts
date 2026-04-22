import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: Array<{ data: unknown; options?: unknown }> = [];
  closeArgs?: { code?: number; reason?: string };

  constructor() {
    super();
    this.on('error', () => {
      // Mirror tolerant test transport behavior: late synthetic error events
      // should not fail the test once attach cleanup has already run.
    });
  }

  send = vi.fn((data: unknown, options?: unknown) => {
    this.sent.push({ data, options });
  });

  close = vi.fn((code?: number, reason?: string) => {
    this.closeArgs = { code, reason };
    this.readyState = 3;
  });

  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === 'close') {
      this.readyState = 3;
    }
    return super.emit(eventName, ...args);
  }
}

function createMockSession(overrides: Partial<Record<string, unknown>> = {}) {
  let rawOutputListener: ((chunk: Buffer) => void) | undefined;
  let eventListener: ((event: { seq: number; at: string; type: string; text: string; actor?: string }) => void) | undefined;
  const unsubOutput = vi.fn(() => {
    rawOutputListener = undefined;
  });
  const unsubEvent = vi.fn(() => {
    eventListener = undefined;
  });
  const session = {
    sessionId: 'demo-session',
    sessionName: 'demo',
    metadata: { sessionRef: 'demo-ref' },
    updatedAt: '2026-04-22T12:00:01.000Z',
    closed: false,
    idleTimeoutMs: 0,
    inputLock: 'none' as 'none' | 'agent' | 'user',
    rawBufferStart: 0,
    rawBuffer: Buffer.from('abcdef'),
    cols: 120,
    rows: 40,
    summary: vi.fn(() => ({
      sessionId: 'demo-session',
      sessionName: 'demo',
      user: 'orangepi',
      host: '192.168.10.58',
      port: 22,
      inputLock: 'none',
    })),
    currentRawBufferEnd: vi.fn(() => 6),
    getConversationEvents: vi.fn(() => [
      { seq: 1, at: '2026-04-22T12:00:00.000Z', type: 'input', text: 'ls', actor: 'user' },
    ]),
    onRawOutput: vi.fn((listener: (chunk: Buffer) => void) => {
      rawOutputListener = listener;
      return unsubOutput;
    }),
    onEvent: vi.fn((listener: (event: { seq: number; at: string; type: string; text: string; actor?: string }) => void) => {
      eventListener = listener;
      return unsubEvent;
    }),
    shouldCloseForIdle: vi.fn(() => false),
    shouldPrune: vi.fn(() => false),
    finalize: vi.fn(),
    close: vi.fn(),
    writeRaw: vi.fn(),
    sendControl: vi.fn(),
    resize: vi.fn(),
    __unsubOutput: unsubOutput,
    __unsubEvent: unsubEvent,
    __emitRawOutput(chunk: Buffer | string) {
      rawOutputListener?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    },
    __emitEvent(event: { seq: number; at: string; type: string; text: string; actor?: string }) {
      eventListener?.(event);
    },
    ...overrides,
  };

  return session;
}

let handleWsAttach: typeof import('../src/viewer-ws-handler.js').handleWsAttach;
let sessions: typeof import('../src/server-state.js').sessions;
let viewerBindings: typeof import('../src/server-state.js').viewerBindings;
let setViewerWss: typeof import('../src/server-state.js').setViewerWss;
let setOperationMode: typeof import('../src/server-state.js').setOperationMode;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-ws-'));
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
  process.env.BOARD_A_PASSWORD = 'dummy-password';

  const serverState = await import('../src/server-state.js');
  sessions = serverState.sessions;
  viewerBindings = serverState.viewerBindings;
  setViewerWss = serverState.setViewerWss;
  setOperationMode = serverState.setOperationMode;

  const wsModule = await import('../src/viewer-ws-handler.js');
  handleWsAttach = wsModule.handleWsAttach;
});

afterEach(() => {
  sessions.clear();
  viewerBindings.clear();
  setViewerWss(undefined);
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

describe('viewer ws handler', () => {
  it('closes the websocket when the requested session is missing', () => {
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'missing-session');

    expect(ws.close).toHaveBeenCalledWith(4004, expect.stringContaining('Unknown session'));
  });

  it('replays init/raw/event state and cleans up listeners only once', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session', 2);

    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(String(ws.sent[0].data))).toMatchObject({
      type: 'init',
      summary: { sessionId: 'demo-session' },
      rawBufferEnd: 6,
    });
    expect(Buffer.isBuffer(ws.sent[1].data)).toBe(true);
    expect((ws.sent[1].data as Buffer).toString('utf8')).toBe('cdef');
    expect(JSON.parse(String(ws.sent[2].data))).toMatchObject({
      type: 'event',
      text: 'ls',
      actor: 'user',
    });

    ws.emit('close');
    ws.emit('error', new Error('duplicate-close'));

    expect(session.__unsubOutput).toHaveBeenCalledTimes(1);
    expect(session.__unsubEvent).toHaveBeenCalledTimes(1);

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'input',
      data: 'should-not-run',
      records: [],
    })), false);
    session.__emitRawOutput('ignored-after-cleanup');
    session.__emitEvent({
      seq: 9,
      at: '2026-04-22T12:00:09.000Z',
      type: 'input',
      text: 'ignored-after-cleanup',
      actor: 'user',
    });

    expect(session.writeRaw).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(3);
  });

  it('includes the binding key when attaching through a viewer binding', () => {
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
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'binding', 'demo-binding');

    expect(JSON.parse(String(ws.sent[0].data))).toMatchObject({
      type: 'init',
      bindingKey: 'demo-binding',
      summary: { sessionId: 'demo-session' },
    });
    expect((ws.sent[1].data as Buffer).toString('utf8')).toBe('abcdef');
  });

  it('rejects viewer input when the agent lock is active', () => {
    const session = createMockSession({
      inputLock: 'agent',
    });
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'input',
      data: 'ls\r',
      records: [{ actor: 'user', text: 'ls', type: 'input' }],
    })), false);

    expect(session.writeRaw).not.toHaveBeenCalled();
    const rejected = ws.sent
      .map(entry => entry.data)
      .filter(data => typeof data === 'string')
      .map(data => JSON.parse(data as string))
      .find(payload => payload.type === 'lock_rejected');
    expect(rejected).toMatchObject({
      type: 'lock_rejected',
      lock: 'agent',
    });
  });

  it('writes input records after filtering invalid entries', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'input',
      data: 'pwd\r',
      records: [
        { actor: '  codex  ', text: 'pwd', type: 'input' },
        { actor: 'user', text: 123, type: 'input' },
        { actor: 'user', text: 'ctrl_c', type: 'control' },
      ],
    })), false);

    expect(session.writeRaw).toHaveBeenCalledWith('pwd\r', [
      { actor: 'codex', text: 'pwd', type: 'input' },
      { actor: 'user', text: 'ctrl_c', type: 'control' },
    ]);
  });

  it('handles control and resize messages while ignoring unsupported controls', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'control',
      key: 'ctrl_c',
      actor: '  user  ',
    })), false);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'control',
      key: 'not-supported',
      actor: 'user',
    })), false);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      cols: 150,
      rows: 48,
    })), false);

    expect(session.sendControl).toHaveBeenCalledTimes(1);
    expect(session.sendControl).toHaveBeenCalledWith('ctrl_c', 'user');
    expect(session.resize).toHaveBeenCalledWith(150, 48);
  });

  it('rejects control input while agent lock is active', () => {
    const session = createMockSession({
      inputLock: 'agent',
    });
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'control',
      key: 'ctrl_c',
      actor: 'user',
    })), false);

    expect(session.sendControl).not.toHaveBeenCalled();
    const rejected = ws.sent
      .map(entry => entry.data)
      .filter(data => typeof data === 'string')
      .map(data => JSON.parse(data as string))
      .find(payload => payload.type === 'lock_rejected');
    expect(rejected).toMatchObject({
      type: 'lock_rejected',
      message: 'Input locked by AI agent.',
    });
  });

  it('broadcasts lock changes only to viewers attached to the same session', () => {
    const sessionA = createMockSession({
      sessionId: 'session-a',
      summary: vi.fn(() => ({
        sessionId: 'session-a',
        sessionName: 'a',
        user: 'orangepi',
        host: '192.168.10.58',
        port: 22,
        inputLock: 'none',
      })),
    });
    const sessionB = createMockSession({
      sessionId: 'session-b',
      summary: vi.fn(() => ({
        sessionId: 'session-b',
        sessionName: 'b',
        user: 'orangepi',
        host: '192.168.10.59',
        port: 22,
        inputLock: 'none',
      })),
    });
    sessions.set('session-a', sessionA as any);
    sessions.set('session-b', sessionB as any);
    const wsA1 = new FakeWebSocket();
    const wsA2 = new FakeWebSocket();
    const wsB = new FakeWebSocket();

    handleWsAttach(wsA1 as any, 'session', 'session-a');
    handleWsAttach(wsA2 as any, 'session', 'session-a');
    handleWsAttach(wsB as any, 'session', 'session-b');

    setViewerWss({
      clients: new Set([wsA1 as any, wsA2 as any, wsB as any]),
    } as any);

    wsA1.emit('message', Buffer.from(JSON.stringify({
      type: 'lock',
      lock: 'agent',
    })), false);

    expect(sessionA.inputLock).toBe('agent');
    const a1Payloads = wsA1.sent.filter(entry => typeof entry.data === 'string').map(entry => JSON.parse(entry.data as string));
    const a2Payloads = wsA2.sent.filter(entry => typeof entry.data === 'string').map(entry => JSON.parse(entry.data as string));
    const bPayloads = wsB.sent.filter(entry => typeof entry.data === 'string').map(entry => JSON.parse(entry.data as string));
    expect(a1Payloads.some(payload => payload.type === 'lock' && payload.lock === 'agent')).toBe(true);
    expect(a2Payloads.some(payload => payload.type === 'lock' && payload.lock === 'agent')).toBe(true);
    expect(bPayloads.some(payload => payload.type === 'lock')).toBe(false);
  });

  it('ignores unsupported lock values without changing the session lock state', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();
    const peer = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    handleWsAttach(peer as any, 'session', 'demo-session');
    setViewerWss({
      clients: new Set([ws as any, peer as any]),
    } as any);

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'lock',
      lock: 'invalid-lock',
    })), false);

    expect(session.inputLock).toBe('none');
    const peerPayloads = peer.sent
      .map(entry => entry.data)
      .filter(data => typeof data === 'string')
      .map(data => JSON.parse(data as string));
    expect(peerPayloads.some(payload => payload.type === 'lock')).toBe(false);
  });

  it('broadcasts mode changes to other open viewer websocket clients', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();
    const sendA = vi.fn();
    const sendB = vi.fn();

    setViewerWss({
      clients: new Set([
        { readyState: 1, send: sendA },
        { readyState: 0, send: sendB },
      ]),
    } as any);

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'mode',
      mode: 'full',
    })), false);

    expect(sendA).toHaveBeenCalledWith(JSON.stringify({ type: 'mode', mode: 'full' }));
    expect(sendB).not.toHaveBeenCalled();
  });

  it('forwards later raw output and events only while the websocket is open', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    const initialMessageCount = ws.sent.length;

    session.__emitRawOutput('more-output');
    session.__emitEvent({
      seq: 2,
      at: '2026-04-22T12:00:01.000Z',
      type: 'control',
      text: 'ctrl_c',
      actor: 'user',
    });

    expect(ws.sent).toHaveLength(initialMessageCount + 2);

    ws.readyState = 3;
    session.__emitRawOutput('ignored-after-close');
    session.__emitEvent({
      seq: 3,
      at: '2026-04-22T12:00:02.000Z',
      type: 'input',
      text: 'pwd',
      actor: 'user',
    });

    expect(ws.sent).toHaveLength(initialMessageCount + 2);
  });

  it('ignores invalid websocket messages without mutating the session', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from('{invalid-json'), false);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'control',
      key: 'invalid-key',
      actor: 'user',
    })), false);
    ws.emit('message', Buffer.from('ignored-binary'), true);

    expect(session.writeRaw).not.toHaveBeenCalled();
    expect(session.sendControl).not.toHaveBeenCalled();
    expect(session.resize).not.toHaveBeenCalled();
  });
});
