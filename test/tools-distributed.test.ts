import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousArgv = [...process.argv];
const envKeys = [
  'SSH_MCP_DISABLE_MAIN',
  'SSH_MCP_CONFIG',
  'SSH_MCP_STATE_DIR',
  'SSH_MCP_RUNTIME_MODE',
  'SSH_MCP_STORE',
  'SSH_MCP_PUBLIC_BASE_URL',
  'SSH_MCP_NODE_ID',
  'VIEWER_PORT',
] as const;
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]])) as Record<string, string | undefined>;

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

function buildSessionRecord(ownerNodeId: string, overrides: Partial<any> = {}) {
  return {
    summary: {
      sessionId: overrides.summary?.sessionId || `session-${ownerNodeId}`,
      sessionName: overrides.summary?.sessionName || ownerNodeId,
      sessionRef: overrides.summary?.sessionRef || `${ownerNodeId}-ref`,
      instanceId: 'instance-a',
      deviceId: overrides.summary?.deviceId,
      connectionName: overrides.summary?.connectionName,
      profileSource: 'manual',
      ownerNodeId,
      routableBaseUrl: `https://${ownerNodeId}.example.test`,
      distributedMode: 'distributed',
      sessionAvailability: ownerNodeId === 'node-a' ? 'local' : 'remote',
      host: overrides.summary?.host || `device-${ownerNodeId}`,
      port: 22,
      user: 'root',
      cols: 120,
      rows: 40,
      term: 'xterm-256color',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: overrides.summary?.updatedAt || '2026-06-07T00:00:00.000Z',
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
    ownerNodeId,
    routableBaseUrl: `https://${ownerNodeId}.example.test`,
    availability: ownerNodeId === 'node-a' ? 'local' : 'remote',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

async function loadModules() {
  restoreProcessState();
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-tools-distributed-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');
  writeFileSync(configPath, JSON.stringify({
    defaults: {
      runtimeMode: 'distributed',
      store: 'memory',
      publicBaseUrl: 'https://node-a.example.test',
      nodeId: 'node-a',
    },
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.SSH_MCP_STATE_DIR = join(dir, 'state');
  process.env.VIEWER_PORT = '0';
  process.argv = ['node', 'tools-distributed.test.ts'];

  const serverState = await import('../src/server-state.js');
  const toolsModule = await import('../src/tools.js');
  toolsModule.registerTools();
  return {
    serverState,
  };
}

async function cleanupModules(serverState: Awaited<ReturnType<typeof loadModules>>['serverState']) {
  serverState.sessions.clear();
  serverState.runningCommands.clear();
  serverState.viewerBindings.clear();
  serverState.clusterSessions.clear();
  serverState.clusterBindings.clear();
  serverState.clusterCommands.clear();
  await serverState.distributedStateStore?.close();
}

function parseToolJson(result: any) {
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  restoreProcessState();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('distributed tool views', () => {
  it('uses cluster sessions for ssh-session-list', async () => {
    const { serverState } = await loadModules();
    try {
      await serverState.distributedStateStore!.saveSession(buildSessionRecord('node-a', {
        summary: {
          sessionId: 'local-session',
          sessionRef: 'local-ref',
          sessionName: 'local',
          deviceId: 'board-a',
          connectionName: 'main',
          updatedAt: '2026-06-07T00:01:00.000Z',
        },
      }));
      await serverState.distributedStateStore!.saveSession(buildSessionRecord('node-b', {
        summary: {
          sessionId: 'remote-session',
          sessionRef: 'remote-ref',
          sessionName: 'remote',
          deviceId: 'board-a',
          connectionName: 'main',
          updatedAt: '2026-06-07T00:02:00.000Z',
        },
      }));

      const result = await serverState.server._registeredTools['ssh-session-list'].callback({
        includeClosed: false,
        device: 'board-a',
        connectionName: 'main',
      });
      const payload = parseToolJson(result);

      expect(payload.distributedMode).toBe('distributed');
      expect(payload.sessions).toHaveLength(2);
      expect(payload.sessions[0]).toMatchObject({
        sessionId: 'remote-session',
        sessionRef: 'remote-ref',
      });
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('returns owner and routing metadata in ssh-status for remote sessions', async () => {
    const { serverState } = await loadModules();
    try {
      await serverState.distributedStateStore!.saveSession(buildSessionRecord('node-b', {
        summary: {
          sessionId: 'remote-session',
          sessionRef: 'remote-ref',
          sessionName: 'remote',
        },
      }));

      const result = await serverState.server._registeredTools['ssh-status'].callback({});
      const payload = parseToolJson(result);

      expect(payload.distributedMode).toBe('distributed');
      expect(payload.sessions).toHaveLength(1);
      expect(payload.sessions[0]).toMatchObject({
        sessionId: 'remote-session',
        ownerNodeId: 'node-b',
        routableBaseUrl: 'https://node-b.example.test',
        distributedMode: 'distributed',
        sessionAvailability: 'remote',
        terminalMode: 'remote',
        terminalUrl: 'https://node-b.example.test/terminal/session/remote-session',
      });
    } finally {
      await cleanupModules(serverState);
    }
  });

  it('returns remote-owner routing hints from ssh-command-status', async () => {
    const { serverState } = await loadModules();
    try {
      await serverState.distributedStateStore!.saveCommand({
        commandId: 'cmd-remote',
        sessionId: 'remote-session',
        command: 'tail -f /var/log/messages',
        startOffset: 0,
        startedAt: '2026-06-07T00:00:00.000Z',
        startTime: 0,
        status: 'running',
        ownerNodeId: 'node-b',
        routableBaseUrl: 'https://node-b.example.test',
      } as any);

      const result = await serverState.server._registeredTools['ssh-command-status'].callback({
        commandId: 'cmd-remote',
      });
      const payload = parseToolJson(result);

      expect(payload).toMatchObject({
        error: 'REMOTE_OWNER',
        ownerNodeId: 'node-b',
        routableBaseUrl: 'https://node-b.example.test',
        redirectUrl: 'https://node-b.example.test/terminal/session/remote-session',
      });
    } finally {
      await cleanupModules(serverState);
    }
  });
});
