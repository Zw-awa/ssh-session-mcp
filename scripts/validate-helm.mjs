/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const chartPath = join(root, 'deploy', 'helm', 'ssh-session-mcp');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function ensureExecutable(name) {
  const probe = spawnSync(name, ['version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (probe.status !== 0) {
    fail(`${name} is required to validate the Helm chart.`);
  }
}

ensureExecutable('helm');
ensureExecutable('kubectl');

const tempDir = mkdtempSync(join(tmpdir(), 'ssh-mcp-helm-'));
const distributedValuesPath = join(tempDir, 'distributed-values.yaml');
writeFileSync(distributedValuesPath, [
  'deploymentMode: distributedV0',
  'replicaCount: 2',
  'env:',
  '  publicBaseUrl: https://ssh-mcp.example.com',
  '  authMode: proxy',
  '  trustProxy: "true"',
  'distributed:',
  '  redis:',
  '    url: redis://redis:6379/0',
].join('\n'));

try {
  run('helm', ['lint', chartPath]);
  const singleRendered = run('helm', ['template', 'ssh-session-mcp', chartPath]);
  const distributedRendered = run('helm', ['template', 'ssh-session-mcp', chartPath, '-f', distributedValuesPath]);

  if (!singleRendered.includes('kind: Deployment') || !distributedRendered.includes('kind: Deployment')) {
    fail('Helm render output is missing Deployment resources.');
  }
  if (!distributedRendered.includes('SSH_MCP_RUNTIME_MODE') || !distributedRendered.includes('SSH_MCP_REDIS_URL')) {
    fail('Distributed Helm render output is missing required distributed environment variables.');
  }

  run('kubectl', ['apply', '--dry-run=client', '-f', '-'], { input: singleRendered });
  run('kubectl', ['apply', '--dry-run=client', '-f', '-'], { input: distributedRendered });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
