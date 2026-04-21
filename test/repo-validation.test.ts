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
    'VIEWER_PORT=auto',
  ].join('\n'));

  writeText(root, 'src/index.ts', [
    "server.tool('ssh-quick-connect', '...', {}, async () => ({}));",
    "server.tool('ssh-run', '...', {}, async () => ({}));",
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
      defaultDevice: 'board-a',
      devices: [
        {
          id: 'board-a',
          host: '192.168.10.58',
          user: 'orangepi',
          auth: { passwordEnv: 'BOARD_A_PASSWORD' },
          defaults: { viewerMode: 'browser' },
        },
      ],
    }),
  );
}

describe('repo validation helpers', () => {
  it('extracts unique MCP tool names', () => {
    const source = [
      "server.tool('ssh-run', '...', {}, async () => ({}));",
      "server.tool('ssh-quick-connect', '...', {}, async () => ({}));",
      "server.tool('ssh-run', '...', {}, async () => ({}));",
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
