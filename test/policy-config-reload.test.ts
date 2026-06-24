/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MODULE_LOAD_TIMEOUT_MS = 60000;

let buildConfiguredSessionPolicyRules: typeof import('../src/server-state.js').buildConfiguredSessionPolicyRules;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
};

describe('configured policy reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-policy-reload-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');

  beforeAll(async () => {
    process.env.SSH_MCP_DISABLE_MAIN = '1';
    process.env.SSH_MCP_CONFIG = configPath;

    writeFileSync(configPath, JSON.stringify({
      policyRules: [
        {
          id: 'warn-terraform-apply',
          pattern: '\\bterraform\\s+apply\\b',
          mode: 'both',
          category: 'dangerous',
          action: 'warn',
          message: 'terraform apply is risky',
        },
      ],
    }, null, 2), 'utf8');

    vi.resetModules();
    const serverState = await import('../src/server-state.js');
    buildConfiguredSessionPolicyRules = serverState.buildConfiguredSessionPolicyRules;
  }, MODULE_LOAD_TIMEOUT_MS);

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reloads the latest default rules from disk on each call', () => {
    const first = buildConfiguredSessionPolicyRules();
    expect(first.map(rule => rule.id)).toEqual(['warn-terraform-apply']);

    writeFileSync(configPath, JSON.stringify({
      policyRules: [
        {
          id: 'block-kubectl-delete',
          pattern: '\\bkubectl\\s+delete\\b',
          mode: 'safe',
          category: 'dangerous',
          action: 'block',
          message: 'kubectl delete blocked',
        },
      ],
    }, null, 2), 'utf8');

    const second = buildConfiguredSessionPolicyRules();
    expect(second.map(rule => rule.id)).toEqual(['block-kubectl-delete']);
  });
});
