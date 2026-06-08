import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const MODULE_LOAD_TIMEOUT_MS = 60000;

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: Array<{ data: unknown; options?: unknown }> = [];
  closeArgs?: { code?: number; reason?: string };

  constructor() {
    super();
    this.on('error', () => {
      // Ignore synthetic late errors in tests after cleanup has completed.
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
    lockPolicy: 'common' as 'common' | 'agent' | 'user' | 'auto',
    inputLock: 'none' as 'none' | 'agent' | 'user',
    userDraftActive: false,
    agentInputActive: false,
    rawBufferStart: 0,
    rawBuffer: Buffer.from('abcdef'),
    cols: 120,
    rows: 40,
    summary: vi.fn(() => ({
      sessionId: 'demo-session',
        sessionName: 'demo',
        user: 'remote-user',
        host: 'DEVICE_A_HOST',
        port: 22,
        lockPolicy: 'common',
        inputLock: 'none',
        userDraftActive: false,
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
    effectiveInputLock: vi.fn(function (this: any) {
      return this.agentInputActive ? 'agent' : this.inputLock;
    }),
    setLockPolicy: vi.fn(function (this: any, policy: 'common' | 'agent' | 'user' | 'auto') {
      this.lockPolicy = policy;
      this.inputLock = policy === 'common' ? 'none' : (policy === 'auto' ? (this.userDraftActive ? 'user' : 'none') : policy);
    }),
    setUserDraftActive: vi.fn(function (this: any, active: boolean) {
      this.userDraftActive = active;
      if (this.lockPolicy === 'auto') {
        this.inputLock = active ? 'user' : 'none';
      }
    }),
    setViewerDraftState: vi.fn(function (this: any, _viewerId: string, active: boolean) {
      this.userDraftActive = active;
      if (this.lockPolicy === 'auto') {
        this.inputLock = active ? 'user' : 'none';
      }
    }),
    clearViewerDraftState: vi.fn(function (this: any, _viewerId: string) {
      this.userDraftActive = false;
      if (this.lockPolicy === 'auto') {
        this.inputLock = 'none';
      }
    }),
    clearUserDraft: vi.fn(function (this: any) {
      this.userDraftActive = false;
      if (this.lockPolicy === 'auto') {
        this.inputLock = 'none';
      }
    }),
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
let viewerClientSessions: typeof import('../src/server-state.js').viewerClientSessions;
let setViewerWss: typeof import('../src/server-state.js').setViewerWss;
let setOperationMode: typeof import('../src/server-state.js').setOperationMode;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  DEVICE_A_PASSWORD: process.env.DEVICE_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-ws-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');

  writeFileSync(configPath, JSON.stringify({
    defaultDevice: 'DEVICE_A_ID',
    devices: [
      {
        id: 'DEVICE_A_ID',
        host: 'DEVICE_A_HOST',
        user: 'remote-user',
        auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
      },
    ],
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.DEVICE_A_PASSWORD = 'dummy-password';

  const serverState = await import('../src/server-state.js');
  sessions = serverState.sessions;
  viewerBindings = serverState.viewerBindings;
  viewerClientSessions = serverState.viewerClientSessions;
  setViewerWss = serverState.setViewerWss;
  setOperationMode = serverState.setOperationMode;

  const wsModule = await import('../src/viewer-ws-handler.js');
  handleWsAttach = wsModule.handleWsAttach;
}, MODULE_LOAD_TIMEOUT_MS);

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

  it('closes with 4009 when the session belongs to a remote owner', () => {
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session', undefined, {
      remoteOwner: {
        ownerNodeId: 'node-b',
        routableBaseUrl: 'https://node-b.example.test',
        redirectUrl: 'https://node-b.example.test/terminal/session/demo-session',
        availability: 'remote',
        sessionId: 'demo-session',
      },
    });

    expect(ws.close).toHaveBeenCalledWith(4009, 'remote owner node-b');
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
      host: 'DEVICE_A_HOST',
      port: 22,
      user: 'remote-user',
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

  it('rejects write actions for viewer_read identities', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();

    handleWsAttach(ws as any, 'session', 'demo-session', undefined, {
      identity: {
        user: 'viewer-read',
        roles: ['viewer_read'],
      },
    });
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'input',
      data: 'pwd\r',
      records: [],
    })), false);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      cols: 140,
      rows: 50,
    })), false);

    expect(session.writeRaw).not.toHaveBeenCalled();
    expect(session.resize).not.toHaveBeenCalled();
    const forbiddenMessages = ws.sent
      .map(entry => entry.data)
      .filter(data => typeof data === 'string')
      .map(data => JSON.parse(data as string))
      .filter(payload => payload.type === 'forbidden');
    expect(forbiddenMessages).toEqual([
      { type: 'forbidden', error: 'VIEWER_ROLE_REQUIRED', requiredRole: 'viewer_write' },
      { type: 'forbidden', error: 'VIEWER_ROLE_REQUIRED', requiredRole: 'viewer_write' },
    ]);
  });

  it('allows viewer_write input and session_admin mode changes', () => {
    const session = createMockSession({
      setOperationMode: vi.fn(function (this: any, mode: 'safe' | 'full') {
        this.operationMode = mode;
      }),
    });
    sessions.set('demo-session', session as any);

    const writerWs = new FakeWebSocket();
    handleWsAttach(writerWs as any, 'session', 'demo-session', undefined, {
      identity: {
        user: 'writer',
        roles: ['viewer_write'],
      },
    });
    writerWs.emit('message', Buffer.from(JSON.stringify({
      type: 'input',
      data: 'pwd\r',
      records: [],
    })), false);
    expect(session.writeRaw).toHaveBeenCalled();

    const adminWs = new FakeWebSocket();
    handleWsAttach(adminWs as any, 'session', 'demo-session', undefined, {
      identity: {
        user: 'admin',
        roles: ['session_admin'],
      },
    });
    adminWs.emit('message', Buffer.from(JSON.stringify({
      type: 'mode',
      mode: 'full',
    })), false);

    expect(session.setOperationMode).toHaveBeenCalledWith('full');
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
      setLockPolicy: vi.fn(function (this: any, policy: 'common' | 'agent' | 'user' | 'auto') {
        this.inputLock = policy === 'common' ? 'none' : (policy === 'auto' ? 'none' : policy);
      }),
      summary: vi.fn(() => ({
        sessionId: 'session-a',
        sessionName: 'a',
        user: 'remote-user',
        host: 'DEVICE_A_HOST',
        port: 22,
        lockPolicy: 'common',
        inputLock: 'none',
        userDraftActive: false,
      })),
    });
    const sessionB = createMockSession({
      sessionId: 'session-b',
      setLockPolicy: vi.fn(function (this: any, policy: 'common' | 'agent' | 'user' | 'auto') {
        this.inputLock = policy === 'common' ? 'none' : (policy === 'auto' ? 'none' : policy);
      }),
      summary: vi.fn(() => ({
        sessionId: 'session-b',
        sessionName: 'b',
        user: 'remote-user',
        host: 'DEVICE_B_HOST',
        port: 22,
        lockPolicy: 'common',
        inputLock: 'none',
        userDraftActive: false,
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

  it('tracks draft state and clears it on socket cleanup', () => {
    const session = createMockSession({
      lockPolicy: 'auto',
      userDraftActive: false,
      setLockPolicy: vi.fn(function (this: any, policy: 'common' | 'agent' | 'user' | 'auto') {
        this.lockPolicy = policy;
        this.inputLock = policy === 'auto' ? 'none' : (policy === 'common' ? 'none' : policy);
      }),
      setViewerDraftState: vi.fn(function (this: any, _viewerId: string, active: boolean) {
        this.userDraftActive = active;
        if (this.lockPolicy === 'auto') {
          this.inputLock = active ? 'user' : 'none';
        }
      }),
      clearViewerDraftState: vi.fn(function (this: any, _viewerId: string) {
        this.userDraftActive = false;
        if (this.lockPolicy === 'auto') {
          this.inputLock = 'none';
        }
      }),
    });
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();
    setViewerWss({
      clients: new Set([ws as any]),
    } as any);

    handleWsAttach(ws as any, 'session', 'demo-session');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'lock',
      lock: 'auto',
    })), false);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'draft_state',
      active: true,
    })), false);

    expect(session.setLockPolicy).toHaveBeenCalledWith('auto');
    expect(session.inputLock).toBe('user');
    expect(session.userDraftActive).toBe(true);

    ws.emit('close');

    expect(session.inputLock).toBe('none');
    expect(session.userDraftActive).toBe(false);
  });

  it('keeps auto draft lock active until the last drafting viewer disconnects', () => {
    const session = createMockSession({
      lockPolicy: 'auto',
      userDraftActive: false,
      setViewerDraftState: vi.fn(function (this: any, viewerId: string, active: boolean) {
        this.__draftViewers = this.__draftViewers || new Set();
        if (active) this.__draftViewers.add(viewerId);
        else this.__draftViewers.delete(viewerId);
        this.userDraftActive = this.__draftViewers.size > 0;
        this.inputLock = this.userDraftActive ? 'user' : 'none';
      }),
      clearViewerDraftState: vi.fn(function (this: any, viewerId: string) {
        this.__draftViewers = this.__draftViewers || new Set();
        this.__draftViewers.delete(viewerId);
        this.userDraftActive = this.__draftViewers.size > 0;
        this.inputLock = this.userDraftActive ? 'user' : 'none';
      }),
    });
    sessions.set('demo-session', session as any);
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    setViewerWss({
      clients: new Set([wsA as any, wsB as any]),
    } as any);

    handleWsAttach(wsA as any, 'session', 'demo-session');
    handleWsAttach(wsB as any, 'session', 'demo-session');

    wsA.emit('message', Buffer.from(JSON.stringify({ type: 'lock', lock: 'auto' })), false);
    wsA.emit('message', Buffer.from(JSON.stringify({ type: 'draft_state', active: true })), false);
    wsB.emit('message', Buffer.from(JSON.stringify({ type: 'draft_state', active: true })), false);
    wsA.emit('close');

    expect(session.userDraftActive).toBe(true);
    expect(session.inputLock).toBe('user');

    wsB.emit('close');

    expect(session.userDraftActive).toBe(false);
    expect(session.inputLock).toBe('none');
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

  it('broadcasts mode changes only to viewers attached to the same session', () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    const ws = new FakeWebSocket();
    const sendA = vi.fn();
    const sendB = vi.fn();

    // Register both clients in viewerClientSessions so broadcastModeChange can filter
    const clientA = { readyState: 1, send: sendA };
    const clientB = { readyState: 0, send: sendB };
    setViewerWss({
      clients: new Set([clientA, clientB]),
    } as any);
    // Client A belongs to this session, client B does not
    viewerClientSessions.set(clientA as any, 'demo-session');

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
