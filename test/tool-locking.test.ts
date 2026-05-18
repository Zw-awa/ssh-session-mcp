import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let server: typeof import('../src/server-state.js').server;
let registerTools: typeof import('../src/tools.js').registerTools;
let sessions: typeof import('../src/server-state.js').sessions;
let runningCommands: typeof import('../src/server-state.js').runningCommands;
let setViewerWss: typeof import('../src/server-state.js').setViewerWss;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  DEVICE_A_PASSWORD: process.env.DEVICE_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tool-locking-'));
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
  server = serverState.server;
  sessions = serverState.sessions;
  runningCommands = serverState.runningCommands;
  setViewerWss = serverState.setViewerWss;

  const toolsModule = await import('../src/tools.js');
  registerTools = toolsModule.registerTools;
  registerTools();
});

afterEach(() => {
  sessions.clear();
  runningCommands.clear();
  setViewerWss(undefined);
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

function createMockSession(overrides: Partial<Record<string, unknown>> = {}) {
  const session = {
    sessionId: 'demo-session',
    sessionName: 'demo',
    metadata: { sessionRef: 'demo-ref' },
    host: 'DEVICE_A_HOST',
    port: 22,
    user: 'remote-user',
    buffer: '$ ',
    inputLock: 'none' as 'none' | 'agent' | 'user',
    lockPolicy: 'common' as 'common' | 'agent' | 'user' | 'auto',
    userDraftActive: false,
    agentInputActive: false,
    closed: false,
    shouldCloseForIdle: vi.fn(() => false),
    shouldPrune: vi.fn(() => false),
    summary: vi.fn(function (this: any) {
      return {
        sessionId: this.sessionId,
        sessionName: this.sessionName,
        sessionRef: this.metadata.sessionRef,
        instanceId: 'test-instance',
        profileSource: 'manual',
        host: this.host,
        port: this.port,
        user: this.user,
        cols: 120,
        rows: 40,
        term: 'xterm-256color',
        createdAt: '2026-04-22T12:00:00.000Z',
        updatedAt: '2026-04-22T12:00:00.000Z',
        lastActivityAt: '2026-04-22T12:00:00.000Z',
        idleTimeoutMs: 0,
        closed: false,
        bufferStart: 0,
        bufferEnd: 2,
        eventStartSeq: 0,
        eventEndSeq: 0,
        customPolicyRuleCount: 0,
        lockPolicy: this.lockPolicy,
        inputLock: this.effectiveInputLock(),
        userDraftActive: this.userDraftActive,
      };
    }),
    getPolicyRules: vi.fn(() => []),
    currentBufferEnd: vi.fn(() => 2),
    currentEventEnd: vi.fn(() => 0),
    read: vi.fn(() => ({
      requestedOffset: 2,
      effectiveOffset: 2,
      nextOffset: 2,
      availableStart: 0,
      availableEnd: 2,
      truncatedBefore: false,
      truncatedAfter: false,
      output: '',
    })),
    write: vi.fn(),
    waitForCompletion: vi.fn(),
    effectiveInputLock: vi.fn(function (this: any) {
      return this.agentInputActive ? 'agent' : this.inputLock;
    }),
    setAgentInputActive: vi.fn(function (this: any, active: boolean) {
      this.agentInputActive = active;
    }),
    ...overrides,
  };

  return session;
}

function extractJson(text: string) {
  return JSON.parse(text);
}

describe('tool locking', () => {
  it('blocks ssh-run when a background command is already running on the same session', async () => {
    const session = createMockSession();
    sessions.set('demo-session', session as any);
    runningCommands.set('cmd-1', {
      commandId: 'cmd-1',
      sessionId: 'demo-session',
      command: 'tail -f /tmp/x',
      startOffset: 2,
      startedAt: '2026-04-22T12:00:00.000Z',
      startTime: Date.now(),
      status: 'running',
    } as any);

    const result = await server._registeredTools['ssh-run'].callback({
      command: 'echo second',
      session: 'demo-session',
    });
    const payload = extractJson(result.content[0].text);

    expect(payload.error).toBe('AGENT_BUSY');
    expect(result.content.some((item: any) => typeof item.text === 'string' && item.text.includes('commandId=cmd-1'))).toBe(true);
    expect(session.write).not.toHaveBeenCalled();
  });

  it('restores agent-only policy lock after a foreground command completes', async () => {
    const session = createMockSession({
      inputLock: 'agent',
      lockPolicy: 'agent',
      waitForCompletion: vi.fn(async () => ({
        completed: true,
        reason: 'prompt',
        elapsedMs: 10,
      })),
      read: vi.fn(() => ({
        requestedOffset: 2,
        effectiveOffset: 2,
        nextOffset: 5,
        availableStart: 0,
        availableEnd: 5,
        truncatedBefore: false,
        truncatedAfter: false,
        output: 'ok\r',
      })),
    });
    sessions.set('demo-session', session as any);

    const result = await server._registeredTools['ssh-run'].callback({
      command: 'echo ok',
      session: 'demo-session',
      waitMs: 1000,
      idleMs: 10,
      maxChars: 100,
    });
    const payload = extractJson(result.content[0].text);

    expect(payload.sessionRef).toBe('demo-ref');
    expect(session.setAgentInputActive).toHaveBeenCalledWith(true);
    expect(session.setAgentInputActive).toHaveBeenLastCalledWith(false);
    expect(session.effectiveInputLock()).toBe('agent');
  });
});
