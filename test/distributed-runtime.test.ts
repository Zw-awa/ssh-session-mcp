import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const previousArgv = [...process.argv];
const envKeys = [
  'SSH_MCP_DISABLE_MAIN',
  'SSH_MCP_CONFIG',
  'SSH_MCP_RUNTIME_MODE',
  'SSH_MCP_STORE',
  'SSH_MCP_REDIS_URL',
  'SSH_MCP_NODE_ID',
  'SSH_MCP_PUBLIC_BASE_URL',
  'SSH_MCP_AUTH_MODE',
  'SSH_MCP_TRUST_PROXY',
  'SSH_MCP_AUTH_USER_HEADER',
  'SSH_MCP_AUTH_ROLE_HEADER',
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

async function importServerStateForConfig(config: object, options?: {
  argv?: string[];
  disableMain?: boolean;
  env?: Record<string, string | undefined>;
}) {
  restoreProcessState();
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-distributed-runtime-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  if (options?.disableMain === false) {
    delete process.env.SSH_MCP_DISABLE_MAIN;
  } else {
    process.env.SSH_MCP_DISABLE_MAIN = '1';
  }
  process.env.SSH_MCP_CONFIG = configPath;
  for (const [key, value] of Object.entries(options?.env || {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.argv = ['node', 'server-state.test.ts', ...(options?.argv || [])];

  return import('../src/server-state.js');
}

afterEach(() => {
  restoreProcessState();
  vi.resetModules();
});

describe('distributed runtime config', () => {
  it('loads distributed defaults from config files', async () => {
    const serverState = await importServerStateForConfig({
      defaults: {
        runtimeMode: 'distributed',
        store: 'memory',
        redisUrl: 'redis://127.0.0.1:6379/2',
        nodeId: 'config-node',
        publicBaseUrl: 'https://viewer.example.test',
        authMode: 'proxy',
        trustProxy: true,
        authUserHeader: 'x-test-user',
        authRoleHeader: 'x-test-role',
      },
    });

    expect(serverState.RUNTIME_MODE).toBe('distributed');
    expect(serverState.STORE_KIND).toBe('memory');
    expect(serverState.REDIS_URL).toBe('redis://127.0.0.1:6379/2');
    expect(serverState.NODE_ID).toBe('config-node');
    expect(serverState.PUBLIC_BASE_URL).toBe('https://viewer.example.test');
    expect(serverState.AUTH_MODE).toBe('proxy');
    expect(serverState.TRUST_PROXY).toBe(true);
    expect(serverState.AUTH_USER_HEADER).toBe('x-test-user');
    expect(serverState.AUTH_ROLE_HEADER).toBe('x-test-role');
  });

  it('applies CLI > env > config defaults precedence for distributed settings', async () => {
    const serverState = await importServerStateForConfig({
      defaults: {
        runtimeMode: 'distributed',
        store: 'memory',
        nodeId: 'config-node',
        publicBaseUrl: 'https://config.example.test',
        authMode: 'off',
        trustProxy: true,
        authUserHeader: 'x-config-user',
      },
    }, {
      argv: [
        '--runtimeMode=single-node',
        '--nodeId=cli-node',
        '--trustProxy=false',
      ],
      disableMain: false,
      env: {
        SSH_MCP_STORE: 'redis',
        SSH_MCP_REDIS_URL: 'redis://127.0.0.1:6379/9',
        SSH_MCP_PUBLIC_BASE_URL: 'https://env.example.test',
        SSH_MCP_AUTH_MODE: 'proxy',
        SSH_MCP_AUTH_USER_HEADER: 'x-env-user',
      },
    });

    expect(serverState.RUNTIME_MODE).toBe('single-node');
    expect(serverState.STORE_KIND).toBe('redis');
    expect(serverState.NODE_ID).toBe('cli-node');
    expect(serverState.PUBLIC_BASE_URL).toBe('https://env.example.test');
    expect(serverState.AUTH_MODE).toBe('proxy');
    expect(serverState.TRUST_PROXY).toBe(false);
    expect(serverState.AUTH_USER_HEADER).toBe('x-env-user');
  });

  it('config CLI persists distributed defaults keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-config-cli-'));
    const configPath = join(dir, 'ssh-session-mcp.config.json');
    const cliPath = join(ROOT, 'src', 'config-cli.ts');

    execFileSync(process.execPath, [
      '--import',
      'tsx',
      cliPath,
      'defaults',
      'set',
      'runtimeMode',
      'distributed',
      `--config=${configPath}`,
    ], { cwd: ROOT, env: process.env, stdio: 'pipe' });
    execFileSync(process.execPath, [
      '--import',
      'tsx',
      cliPath,
      'defaults',
      'set',
      'nodeId',
      'cluster-a',
      `--config=${configPath}`,
    ], { cwd: ROOT, env: process.env, stdio: 'pipe' });
    execFileSync(process.execPath, [
      '--import',
      'tsx',
      cliPath,
      'defaults',
      'set',
      'trustProxy',
      'true',
      `--config=${configPath}`,
    ], { cwd: ROOT, env: process.env, stdio: 'pipe' });

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.defaults).toMatchObject({
      runtimeMode: 'distributed',
      nodeId: 'cluster-a',
      trustProxy: true,
    });
  });
});
