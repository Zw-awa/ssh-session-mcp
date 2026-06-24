/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { Socket } from 'node:net';

import type { SessionSummary } from './session.js';
import type { RunningCommand, ViewerAccessPolicy, ViewerBindingState } from './server-state.js';

export type RuntimeMode = 'single-node' | 'distributed';
export type StoreKind = 'memory' | 'redis';
export type AuthMode = 'off' | 'proxy';
export type ViewerRole = 'viewer_read' | 'viewer_write' | 'session_admin';
export type SessionAvailability = 'local' | 'remote' | 'unavailable';

export interface DistributedRuntimeConfig {
  mode: RuntimeMode;
  store: StoreKind;
  redisUrl?: string;
  nodeId: string;
  publicBaseUrl?: string;
  authMode: AuthMode;
  trustProxy: boolean;
  authUserHeader: string;
  authRoleHeader: string;
}

export interface ClusterNodeRecord {
  nodeId: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  publicBaseUrl?: string;
  viewerBaseUrl?: string;
  runtimeMode: RuntimeMode;
}

export interface ClusterSessionRecord {
  summary: SessionSummary;
  ownerNodeId: string;
  routableBaseUrl?: string;
  availability: SessionAvailability;
  updatedAt: string;
}

export interface ClusterBindingRecord extends ViewerBindingState {
  ownerNodeId: string;
  routableBaseUrl?: string;
}

export interface ClusterCommandRecord extends RunningCommand {
  ownerNodeId: string;
  routableBaseUrl?: string;
}

export interface ViewerIdentity {
  user: string;
  roles: ViewerRole[];
}

export interface DistributedStateStore {
  close(): Promise<void>;
  ping(): Promise<boolean>;
  registerNode(record: ClusterNodeRecord, ttlSeconds: number): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  getNode(nodeId: string): Promise<ClusterNodeRecord | undefined>;
  saveSession(record: ClusterSessionRecord): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(): Promise<ClusterSessionRecord[]>;
  getSession(sessionId: string): Promise<ClusterSessionRecord | undefined>;
  saveBinding(record: ClusterBindingRecord): Promise<void>;
  deleteBinding(bindingKey: string): Promise<void>;
  getBinding(bindingKey: string): Promise<ClusterBindingRecord | undefined>;
  listBindings(): Promise<ClusterBindingRecord[]>;
  saveCommand(record: ClusterCommandRecord): Promise<void>;
  deleteCommand(commandId: string): Promise<void>;
  getCommand(commandId: string): Promise<ClusterCommandRecord | undefined>;
  listCommands(): Promise<ClusterCommandRecord[]>;
  loadViewerAccessPolicy(): Promise<ViewerAccessPolicy | undefined>;
  saveViewerAccessPolicy(policy: ViewerAccessPolicy): Promise<void>;
}

const SESSION_INDEX_KEY = 'ssh-session-mcp:sessions:index';
const BINDING_INDEX_KEY = 'ssh-session-mcp:bindings:index';
const COMMAND_INDEX_KEY = 'ssh-session-mcp:commands:index';
const VIEWER_ACCESS_POLICY_KEY = 'ssh-session-mcp:viewer-access-policy';

function nodeKey(nodeId: string) {
  return `ssh-session-mcp:nodes:${nodeId}`;
}

function sessionKey(sessionId: string) {
  return `ssh-session-mcp:sessions:${sessionId}`;
}

function bindingKey(bindingId: string) {
  return `ssh-session-mcp:bindings:${bindingId}`;
}

function commandKey(commandId: string) {
  return `ssh-session-mcp:commands:${commandId}`;
}

function compactJsonParse<T>(raw: string | undefined): T | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeRole(value: string): ViewerRole | undefined {
  const trimmed = value.trim();
  if (trimmed === 'viewer_read' || trimmed === 'viewer_write' || trimmed === 'session_admin') {
    return trimmed;
  }

  return undefined;
}

export function parseViewerRoles(raw: string | undefined): ViewerRole[] {
  if (!raw) {
    return [];
  }

  return [...new Set(raw.split(',').map(part => normalizeRole(part)).filter((role): role is ViewerRole => Boolean(role)))];
}

export function hasViewerRole(identity: ViewerIdentity | undefined, role: ViewerRole) {
  if (!identity) {
    return false;
  }

  if (identity.roles.includes('session_admin')) {
    return true;
  }

  return identity.roles.includes(role);
}

class MemoryDistributedStateStore implements DistributedStateStore {
  private readonly nodes = new Map<string, ClusterNodeRecord>();
  private readonly sessions = new Map<string, ClusterSessionRecord>();
  private readonly bindings = new Map<string, ClusterBindingRecord>();
  private readonly commands = new Map<string, ClusterCommandRecord>();
  private viewerAccessPolicy?: ViewerAccessPolicy;

  async close() {}

  async ping() {
    return true;
  }

  async registerNode(record: ClusterNodeRecord) {
    this.nodes.set(record.nodeId, record);
  }

  async removeNode(nodeId: string) {
    this.nodes.delete(nodeId);
  }

  async getNode(nodeId: string) {
    return this.nodes.get(nodeId);
  }

  async saveSession(record: ClusterSessionRecord) {
    this.sessions.set(record.summary.sessionId, record);
  }

  async deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async listSessions() {
    return [...this.sessions.values()];
  }

  async getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  async saveBinding(record: ClusterBindingRecord) {
    this.bindings.set(record.bindingKey, record);
  }

  async deleteBinding(bindingKeyValue: string) {
    this.bindings.delete(bindingKeyValue);
  }

  async getBinding(bindingKeyValue: string) {
    return this.bindings.get(bindingKeyValue);
  }

  async listBindings() {
    return [...this.bindings.values()];
  }

  async saveCommand(record: ClusterCommandRecord) {
    this.commands.set(record.commandId, record);
  }

  async deleteCommand(commandIdValue: string) {
    this.commands.delete(commandIdValue);
  }

  async getCommand(commandIdValue: string) {
    return this.commands.get(commandIdValue);
  }

  async listCommands() {
    return [...this.commands.values()];
  }

  async loadViewerAccessPolicy() {
    return this.viewerAccessPolicy;
  }

  async saveViewerAccessPolicy(policy: ViewerAccessPolicy) {
    this.viewerAccessPolicy = policy;
  }
}

interface RedisTarget {
  host: string;
  port: number;
  db: number;
  password?: string;
}

function parseRedisUrl(raw: string): RedisTarget {
  const url = new URL(raw);
  if (url.protocol !== 'redis:') {
    throw new Error('Only redis:// URLs are supported for SSH_MCP_REDIS_URL');
  }

  const dbText = url.pathname.replace(/^\//, '').trim();
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? parseInt(url.port, 10) : 6379,
    db: dbText ? parseInt(dbText, 10) : 0,
    password: url.password || undefined,
  };
}

function encodeRedisCommand(parts: Array<string | number>) {
  const encoded = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const text = String(part);
    encoded.push(`$${Buffer.byteLength(text, 'utf8')}\r\n${text}\r\n`);
  }
  return encoded.join('');
}

function parseRedisBulk(payload: string, start: number) {
  const lengthEnd = payload.indexOf('\r\n', start + 1);
  if (lengthEnd === -1) {
    return undefined;
  }
  const size = parseInt(payload.slice(start + 1, lengthEnd), 10);
  if (Number.isNaN(size)) {
    throw new Error('Invalid Redis bulk length');
  }
  if (size === -1) {
    return { next: lengthEnd + 2, value: null };
  }

  const valueStart = lengthEnd + 2;
  const valueEnd = valueStart + size;
  if (payload.length < valueEnd + 2) {
    return undefined;
  }

  return {
    next: valueEnd + 2,
    value: payload.slice(valueStart, valueEnd),
  };
}

function parseRedisInteger(payload: string, start: number) {
  const end = payload.indexOf('\r\n', start + 1);
  if (end === -1) {
    return undefined;
  }
  return {
    next: end + 2,
    value: parseInt(payload.slice(start + 1, end), 10),
  };
}

function parseRedisSimple(payload: string, start: number) {
  const end = payload.indexOf('\r\n', start + 1);
  if (end === -1) {
    return undefined;
  }
  return {
    next: end + 2,
    value: payload.slice(start + 1, end),
  };
}

function parseRedisArray(payload: string, start: number): { next: number; value: unknown[] | null } | undefined {
  const end = payload.indexOf('\r\n', start + 1);
  if (end === -1) {
    return undefined;
  }

  const size = parseInt(payload.slice(start + 1, end), 10);
  if (Number.isNaN(size)) {
    throw new Error('Invalid Redis array length');
  }
  if (size === -1) {
    return {
      next: end + 2,
      value: null,
    };
  }

  let next = end + 2;
  const values: unknown[] = [];
  for (let index = 0; index < size; index += 1) {
    const parsed = parseRedisResponse(payload, next);
    if (!parsed) {
      return undefined;
    }
    next = parsed.next;
    values.push(parsed.value);
  }

  return {
    next,
    value: values,
  };
}

function parseRedisResponse(payload: string, start = 0): { next: number; value: unknown } | undefined {
  const type = payload[start];
  if (!type) {
    return undefined;
  }

  if (type === '+') {
    return parseRedisSimple(payload, start);
  }

  if (type === ':') {
    return parseRedisInteger(payload, start);
  }

  if (type === '$') {
    return parseRedisBulk(payload, start);
  }

  if (type === '*') {
    return parseRedisArray(payload, start);
  }

  if (type === '-') {
    const parsed = parseRedisSimple(payload, start);
    if (!parsed) {
      return undefined;
    }
    throw new Error(`Redis error: ${parsed.value}`);
  }

  throw new Error(`Unknown Redis response prefix: ${type}`);
}

class RedisDistributedStateStore implements DistributedStateStore {
  private readonly target: RedisTarget;
  private socket: Socket | undefined;
  private buffer = '';
  private readonly pending = new Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private connecting?: Promise<void>;

  constructor(redisUrl: string) {
    this.target = parseRedisUrl(redisUrl);
  }

  private resetConnection(error?: Error) {
    const resolvedError = error || new Error('Redis connection closed');
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = undefined;
    this.connecting = undefined;
    this.buffer = '';
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(resolvedError);
    }
  }

  private sendCommand(name: string, ...args: Array<string | number>) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Redis connection is not available'));
    }

    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(encodeRedisCommand([name, ...args]));
    });
  }

  private async ensureConnected() {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      let settled = false;
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      socket.setNoDelay(true);
      socket.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        this.flushPending();
      });
      socket.on('error', (error) => {
        const resolvedError = error instanceof Error ? error : new Error(String(error));
        this.resetConnection(resolvedError);
        settleReject(resolvedError);
      });
      socket.on('close', () => {
        const resolvedError = new Error('Redis connection closed');
        this.resetConnection(resolvedError);
        settleReject(resolvedError);
      });
      socket.connect(this.target.port, this.target.host, async () => {
        this.socket = socket;
        try {
          if (this.target.password) {
            await this.sendCommand('AUTH', this.target.password);
          }
          if (this.target.db > 0) {
            await this.sendCommand('SELECT', this.target.db);
          }
          settleResolve();
        } catch (error) {
          const resolvedError = error instanceof Error ? error : new Error(String(error));
          this.resetConnection(resolvedError);
          settleReject(resolvedError);
        } finally {
          this.connecting = undefined;
        }
      });
    });

    return this.connecting;
  }

  private flushPending() {
    while (this.pending.length > 0) {
      let parsed;
      try {
        parsed = parseRedisResponse(this.buffer);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const nextPending = this.pending.shift();
        if (nextPending) {
          nextPending.reject(err);
        }
        this.buffer = '';
        continue;
      }

      if (!parsed) {
        return;
      }

      this.buffer = this.buffer.slice(parsed.next);
      const nextPending = this.pending.shift();
      if (nextPending) {
        nextPending.resolve(parsed.value);
      }
    }
  }

  private async command(name: string, ...args: Array<string | number>) {
    await this.ensureConnected();
    return this.sendCommand(name, ...args);
  }

  private async setJson(key: string, value: unknown, ttlSeconds?: number) {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.command('SET', key, payload, 'EX', ttlSeconds);
      return;
    }
    await this.command('SET', key, payload);
  }

  private async getJson<T>(key: string) {
    const payload = await this.command('GET', key);
    return compactJsonParse<T>(typeof payload === 'string' ? payload : undefined);
  }

  private async deleteIndexed(indexKey: string, itemKey: string, id: string) {
    await this.command('DEL', itemKey);
    await this.command('SREM', indexKey, id);
  }

  private async listIndexed<T>(indexKey: string, itemKeyFactory: (id: string) => string) {
    const ids = await this.command('SMEMBERS', indexKey);
    if (!Array.isArray(ids)) {
      return [] as T[];
    }

    const results = await Promise.all(ids
      .filter((id): id is string => typeof id === 'string')
      .map(async id => this.getJson<T>(itemKeyFactory(id))));

    const narrowed: T[] = [];
    for (const value of results) {
      if (value !== undefined) {
        narrowed.push(value);
      }
    }
    return narrowed;
  }

  async close() {
    this.resetConnection(new Error('Redis connection closed'));
  }

  async ping() {
    try {
      const value = await this.command('PING');
      return value === 'PONG';
    } catch {
      return false;
    }
  }

  async registerNode(record: ClusterNodeRecord, ttlSeconds: number) {
    await this.setJson(nodeKey(record.nodeId), record, ttlSeconds);
  }

  async removeNode(nodeId: string) {
    await this.command('DEL', nodeKey(nodeId));
  }

  async getNode(nodeId: string) {
    return this.getJson<ClusterNodeRecord>(nodeKey(nodeId));
  }

  async saveSession(record: ClusterSessionRecord) {
    await this.setJson(sessionKey(record.summary.sessionId), record);
    await this.command('SADD', SESSION_INDEX_KEY, record.summary.sessionId);
  }

  async deleteSession(sessionId: string) {
    await this.deleteIndexed(SESSION_INDEX_KEY, sessionKey(sessionId), sessionId);
  }

  async listSessions() {
    return this.listIndexed<ClusterSessionRecord>(SESSION_INDEX_KEY, sessionKey);
  }

  async getSession(sessionId: string) {
    return this.getJson<ClusterSessionRecord>(sessionKey(sessionId));
  }

  async saveBinding(record: ClusterBindingRecord) {
    await this.setJson(bindingKey(record.bindingKey), record);
    await this.command('SADD', BINDING_INDEX_KEY, record.bindingKey);
  }

  async deleteBinding(bindingKeyValue: string) {
    await this.deleteIndexed(BINDING_INDEX_KEY, bindingKey(bindingKeyValue), bindingKeyValue);
  }

  async getBinding(bindingKeyValue: string) {
    return this.getJson<ClusterBindingRecord>(bindingKey(bindingKeyValue));
  }

  async listBindings() {
    return this.listIndexed<ClusterBindingRecord>(BINDING_INDEX_KEY, bindingKey);
  }

  async saveCommand(record: ClusterCommandRecord) {
    await this.setJson(commandKey(record.commandId), record);
    await this.command('SADD', COMMAND_INDEX_KEY, record.commandId);
  }

  async deleteCommand(commandIdValue: string) {
    await this.deleteIndexed(COMMAND_INDEX_KEY, commandKey(commandIdValue), commandIdValue);
  }

  async getCommand(commandIdValue: string) {
    return this.getJson<ClusterCommandRecord>(commandKey(commandIdValue));
  }

  async listCommands() {
    return this.listIndexed<ClusterCommandRecord>(COMMAND_INDEX_KEY, commandKey);
  }

  async loadViewerAccessPolicy() {
    return this.getJson<ViewerAccessPolicy>(VIEWER_ACCESS_POLICY_KEY);
  }

  async saveViewerAccessPolicy(policy: ViewerAccessPolicy) {
    await this.setJson(VIEWER_ACCESS_POLICY_KEY, policy);
  }
}

export function createDistributedStateStore(config: DistributedRuntimeConfig): DistributedStateStore | undefined {
  if (config.mode !== 'distributed') {
    return undefined;
  }

  if (config.store === 'memory') {
    return new MemoryDistributedStateStore();
  }

  if (!config.redisUrl) {
    throw new Error('SSH_MCP_REDIS_URL is required when SSH_MCP_STORE=redis');
  }

  return new RedisDistributedStateStore(config.redisUrl);
}
