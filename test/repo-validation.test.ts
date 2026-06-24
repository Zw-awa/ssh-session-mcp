/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { extractMcpToolNames, findMissingToolMentions, validateRepository } from '../src/repo-validation';

function writeText(root: string, relativePath: string, content: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function writeValidRepositoryFixture(root: string) {
  writeText(root, '.env.example', [
    'SSH_MCP_INSTANCE=agent-a',
    'SSH_MCP_CONFIG=./ssh-session-mcp.config.json',
    '# SSH_MCP_STATE_DIR=.ssh-session-mcp-state',
    '# SSH_PASSWORD_FILE=/run/secrets/ssh_password',
    '# SSH_KEY_FILE=/run/secrets/ssh_private_key',
    'VIEWER_PORT=auto',
  ].join('\n'));

  writeText(root, '.dockerignore', 'node_modules/\n');
  writeText(root, 'Dockerfile', 'FROM node:20-bookworm-slim\n');
  writeText(root, 'docker-compose.yml', 'services:\n  app:\n    image: example\n');
  writeText(root, 'docker-compose.env.yml', 'services:\n  app:\n    image: example\n');

  writeText(root, 'src/index.ts', 'export {};\n');
  writeText(root, 'src/tools.ts', [
    "server.registerTool('ssh-quick-connect', { description: '...', inputSchema: {} }, async () => ({}));",
    "server.registerTool('ssh-run', { description: '...', inputSchema: {} }, async () => ({}));",
  ].join('\n'));

  writeText(root, 'README.md', [
    '中文文档: [简体中文](README.zh-CN.md)',
    '`ssh-quick-connect`',
    '`ssh-run`',
  ].join('\n'));

  writeText(root, 'README.zh-CN.md', [
    'English: [README.md](README.md)',
    '`ssh-quick-connect`',
    '`ssh-run`',
  ].join('\n'));

  writeText(root, 'AI_AGENT_GUIDE.md', [
    '`ssh-quick-connect`',
    '`ssh-run`',
  ].join('\n'));

  writeText(root, 'docs/contracts.md', '# contracts\n');
  writeText(root, 'docs/docker.md', '# docker\n');
  writeText(root, 'docs/kubernetes.md', '# kubernetes\n');
  writeText(root, 'docs/ingress-proxy-auth.md', '# ingress proxy auth\n');
  writeText(root, 'docs/failure-taxonomy.md', '# failure taxonomy\n');
  writeText(root, 'docs/platform-compatibility.md', '# compatibility\n');
  writeText(root, 'docs/acceptance-scenarios.md', [
    'single-device-default-connection',
    'dual-device-single-instance-switch',
    'single-device-multi-connection-selection',
    'multi-ai-multi-instance-isolation',
    'viewer-port-auto-allocation',
    'runtime-state-cleanup-on-exit',
    'input-lock-user-blocks-agent',
    'ambiguous-active-session-blocks-default-targeting',
  ].join('\n'));

  writeText(
    root,
    'docs/examples/ssh-session-mcp.config.example.json',
    JSON.stringify({
      defaults: {
        viewerHost: '127.0.0.1',
        viewerPort: 'auto',
        viewerMode: 'browser',
        viewerSingletonScope: 'connection',
        mode: 'safe',
        logMode: 'meta',
      },
      defaultDevice: 'DEVICE_A_ID',
      devices: [
        {
          id: 'DEVICE_A_ID',
          host: 'DEVICE_A_HOST',
          user: 'remote-user',
          auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
          defaults: { viewerMode: 'browser' },
        },
      ],
    }),
  );

  writeText(
    root,
    'docs/examples/ssh-session-mcp.config.docker.example.json',
    JSON.stringify({
      defaults: {
        viewerHost: '0.0.0.0',
        viewerPort: 8793,
        viewerMode: 'browser',
        viewerSingletonScope: 'connection',
        mode: 'safe',
        logMode: 'meta',
      },
      defaultDevice: 'DEVICE_A_ID',
      devices: [
        {
          id: 'DEVICE_A_ID',
          host: 'DEVICE_A_HOST',
          user: 'remote-user',
          auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
          defaults: { viewerMode: 'browser' },
        },
      ],
    }),
  );

  writeText(root, 'docs/examples/ssh-session-mcp.k8s.single-instance.yaml', 'apiVersion: v1\nkind: ConfigMap\n');
  writeText(root, 'docs/examples/ssh-session-mcp.k8s.distributed.example.yaml', 'apiVersion: apps/v1\nkind: Deployment\n');
  writeText(root, 'deploy/helm/ssh-session-mcp/Chart.yaml', 'apiVersion: v2\nname: ssh-session-mcp\nversion: 0.1.0\n');
  writeText(root, 'deploy/helm/ssh-session-mcp/values.yaml', 'deploymentMode: singleNode\n');
  writeText(root, 'deploy/helm/ssh-session-mcp/values-single-node.yaml', 'deploymentMode: singleNode\n');
  writeText(root, 'deploy/helm/ssh-session-mcp/values-distributed-v0.yaml', 'deploymentMode: distributedV0\n');
  writeText(root, 'scripts/validate-helm.mjs', 'console.log("ok");\n');
  writeText(root, 'scripts/install-trivy.sh', '#!/usr/bin/env bash\necho ok\n');
}

describe('repo validation helpers', () => {
  it('extracts unique MCP tool names', () => {
    const source = [
      "server.registerTool('ssh-run', { description: '...', inputSchema: {} }, async () => ({}));",
      "server.registerTool('ssh-quick-connect', { description: '...', inputSchema: {} }, async () => ({}));",
      "server.registerTool('ssh-run', { description: '...', inputSchema: {} }, async () => ({}));",
    ].join('\n');

    expect(extractMcpToolNames(source)).toEqual(['ssh-quick-connect', 'ssh-run']);
  });

  it('detects missing tool mentions in docs', () => {
    const missing = findMissingToolMentions('`ssh-run` only', ['ssh-run', 'ssh-quick-connect']);
    expect(missing).toEqual(['ssh-quick-connect']);
  });

  it('passes for a repository fixture that satisfies required docs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-validate-ok-'));
    writeValidRepositoryFixture(root);

    expect(validateRepository(root)).toEqual([]);
  });

  it('fails when a required document omits tool references', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-validate-bad-'));
    writeValidRepositoryFixture(root);
    writeText(root, 'AI_AGENT_GUIDE.md', '`ssh-quick-connect` only\n');

    const failures = validateRepository(root);
    expect(failures.some(failure => failure.includes('AI_AGENT_GUIDE.md is missing MCP tool references: ssh-run'))).toBe(true);
  });
});
