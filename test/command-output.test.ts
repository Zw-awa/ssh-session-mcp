import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let buildSentinelCommandSuffix: typeof import('../src/server-state.js').buildSentinelCommandSuffix;
let broadcastLock: typeof import('../src/server-state.js').broadcastLock;
let cleanBufferSnapshot: typeof import('../src/server-state.js').cleanBufferSnapshot;
let resolveCompletedCommandOutput: typeof import('../src/server-state.js').resolveCompletedCommandOutput;
let sessions: typeof import('../src/server-state.js').sessions;
let setViewerWss: typeof import('../src/server-state.js').setViewerWss;
let viewerClientSessions: typeof import('../src/server-state.js').viewerClientSessions;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-command-output-'));
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
  buildSentinelCommandSuffix = serverState.buildSentinelCommandSuffix;
  broadcastLock = serverState.broadcastLock;
  cleanBufferSnapshot = serverState.cleanBufferSnapshot;
  resolveCompletedCommandOutput = serverState.resolveCompletedCommandOutput;
  sessions = serverState.sessions;
  setViewerWss = serverState.setViewerWss;
  viewerClientSessions = serverState.viewerClientSessions;
});

afterEach(() => {
  sessions.clear();
  setViewerWss(undefined);
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

describe('command output handling', () => {
  it('cleans sentinel artifacts without losing snapshot truncation metadata', () => {
    const marker = '___MCP_DONE_deadbeef_';
    const suffix = buildSentinelCommandSuffix(marker);

    const cleaned = cleanBufferSnapshot({
      requestedOffset: 10,
      effectiveOffset: 10,
      nextOffset: 74,
      availableStart: 10,
      availableEnd: 120,
      truncatedBefore: false,
      truncatedAfter: true,
      output: `python demo.py${suffix}\rready\r${marker}0___`,
    }, 'python demo.py', {
      sentinelMarker: marker,
      sentinelSuffix: suffix,
    });

    expect(cleaned.output).toContain('python demo.py');
    expect(cleaned.output).toContain('ready');
    expect(cleaned.output).not.toContain(marker);
    expect(cleaned.output).not.toContain('__MCP_EC=');
    expect(cleaned.truncatedAfter).toBe(true);
    expect(cleaned.availableEnd).toBe(120);
  });

  it('prefers the live session buffer when resolving completed async command output', () => {
    const entry = {
      commandId: 'cmd-1',
      sessionId: 'session-1',
      command: 'echo ok',
      startOffset: 5,
      startedAt: '2026-04-22T12:00:00.000Z',
      startTime: 0,
      status: 'completed',
      output: 'stale cached output',
      outputAvailableStart: 5,
      outputAvailableEnd: 23,
      outputTruncatedBefore: false,
      outputTruncatedAfter: false,
    } as const;

    sessions.set('session-1', {
      read: vi.fn(() => ({
        requestedOffset: 5,
        effectiveOffset: 5,
        nextOffset: 21,
        availableStart: 5,
        availableEnd: 48,
        truncatedBefore: false,
        truncatedAfter: true,
        output: 'echo ok\rok\rmore',
      })),
    } as any);

    const resolved = resolveCompletedCommandOutput(entry, 16);

    expect(resolved.output).toContain('echo ok');
    expect(resolved.output).toContain('ok');
    expect(resolved.availableEnd).toBe(48);
    expect(resolved.truncatedAfter).toBe(true);
  });
});

describe('viewer lock broadcast', () => {
  it('only broadcasts lock changes to viewers attached to the same session', () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const clientA = { readyState: 1, send: sendA };
    const clientB = { readyState: 1, send: sendB };

    viewerClientSessions.set(clientA as any, 'session-a');
    viewerClientSessions.set(clientB as any, 'session-b');

    setViewerWss({
      clients: new Set([
        clientA as any,
        clientB as any,
      ]),
    } as any);

    broadcastLock({
      sessionId: 'session-a',
      inputLock: 'agent',
    } as any);

    expect(sendA).toHaveBeenCalledWith(JSON.stringify({ type: 'lock', lock: 'agent' }));
    expect(sendB).not.toHaveBeenCalled();
  });
});
