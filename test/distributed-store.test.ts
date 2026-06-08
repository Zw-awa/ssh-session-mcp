import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDistributedStateStore,
  type ClusterCommandRecord,
  type ClusterSessionRecord,
  type DistributedStateStore,
  type ViewerAccessPolicy,
} from '../src/distributed.js';

function buildSessionRecord(overrides: Partial<ClusterSessionRecord> = {}): ClusterSessionRecord {
  return {
    summary: {
      sessionId: 'session-1',
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
    ownerNodeId: 'node-a',
    routableBaseUrl: 'https://node-a.example.test',
    availability: 'local',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

function buildCommandRecord(overrides: Partial<ClusterCommandRecord> = {}): ClusterCommandRecord {
  return {
    commandId: 'cmd-1',
    sessionId: 'session-1',
    command: 'echo ok',
    startOffset: 0,
    startedAt: '2026-06-07T00:00:00.000Z',
    startTime: 0,
    status: 'running',
    ownerNodeId: 'node-a',
    routableBaseUrl: 'https://node-a.example.test',
    ...overrides,
  };
}

describe('distributed state stores', () => {
  let storesToClose: DistributedStateStore[] = [];

  afterEach(async () => {
    for (const store of storesToClose) {
      await store.close();
    }
    storesToClose = [];
  });

  it('supports memory store CRUD', async () => {
    const store = createDistributedStateStore({
      mode: 'distributed',
      store: 'memory',
      nodeId: 'node-a',
      authMode: 'off',
      trustProxy: false,
      authUserHeader: 'x-user',
      authRoleHeader: 'x-role',
    });
    storesToClose.push(store!);

    const session = buildSessionRecord();
    const command = buildCommandRecord();
    const policy: ViewerAccessPolicy = {
      mode: 'allow_all',
      ipAllowlist: [],
      ipDenylist: [],
      allowedOrigins: [],
      updatedAt: '2026-06-07T00:00:00.000Z',
    };

    await store!.registerNode({
      nodeId: 'node-a',
      instanceId: 'instance-a',
      pid: 123,
      startedAt: '2026-06-07T00:00:00.000Z',
      lastSeenAt: '2026-06-07T00:00:00.000Z',
      runtimeMode: 'distributed',
    }, 15);
    await store!.saveSession(session);
    await store!.saveCommand(command);
    await store!.saveViewerAccessPolicy(policy);

    expect(await store!.ping()).toBe(true);
    expect(await store!.getNode('node-a')).toMatchObject({ nodeId: 'node-a' });
    expect(await store!.listSessions()).toHaveLength(1);
    expect(await store!.getSession('session-1')).toMatchObject({ ownerNodeId: 'node-a' });
    expect(await store!.getCommand('cmd-1')).toMatchObject({ sessionId: 'session-1' });
    expect(await store!.loadViewerAccessPolicy()).toEqual(policy);

    await store!.deleteSession('session-1');
    await store!.deleteCommand('cmd-1');

    expect(await store!.listSessions()).toEqual([]);
    expect(await store!.getCommand('cmd-1')).toBeUndefined();
  });

  it('reconnects after a failed ping and can talk to a later Redis server on the same port', async () => {
    let connectionCount = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
      });
      connectionCount += 1;
      if (connectionCount === 1) {
        socket.destroy();
        return;
      }

      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('*1\r\n$4\r\nPING\r\n')) {
          buffer = '';
          socket.write('+PONG\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to allocate test port');
    }

    const store = createDistributedStateStore({
      mode: 'distributed',
      store: 'redis',
      redisUrl: `redis://127.0.0.1:${address.port}/0`,
      nodeId: 'node-a',
      authMode: 'off',
      trustProxy: false,
      authUserHeader: 'x-user',
      authRoleHeader: 'x-role',
    });
    storesToClose.push(store!);

    try {
      expect(await store!.ping()).toBe(false);
      expect(await store!.ping()).toBe(true);
    } finally {
      await store!.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10000);

  it('returns false when Redis AUTH initialization fails', async () => {
    const server = createServer(socket => {
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.startsWith('*2\r\n$4\r\nAUTH\r\n')) {
          socket.write('-ERR invalid password\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to allocate redis stub');
    }

    const store = createDistributedStateStore({
      mode: 'distributed',
      store: 'redis',
      redisUrl: `redis://:bad@127.0.0.1:${address.port}/0`,
      nodeId: 'node-a',
      authMode: 'off',
      trustProxy: false,
      authUserHeader: 'x-user',
      authRoleHeader: 'x-role',
    });
    storesToClose.push(store!);

    try {
      expect(await store!.ping()).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
