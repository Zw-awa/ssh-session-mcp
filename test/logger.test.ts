/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { resolveLoggerConfig, SessionLogger, summarizeCommandMeta } from '../src/logger';

describe('logger', () => {
  it('keeps logging disabled by default', () => {
    expect(resolveLoggerConfig(undefined, undefined).mode).toBe('off');
  });

  it('supports stderr logging mode for container-friendly structured logs', () => {
    expect(resolveLoggerConfig('stderr', undefined).mode).toBe('stderr');
  });

  it('writes JSONL records in meta mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-logger-'));
    const logger = new SessionLogger({ dir, mode: 'meta' });

    await logger.logServer('server.started', { port: 8793 });
    await logger.logSession('abc', 'command.started', summarizeCommandMeta('python main.py --secret token'));

    const serverLog = join(dir, 'server.jsonl');
    const sessionLog = join(dir, 'sessions', 'abc.jsonl');

    expect(existsSync(serverLog)).toBe(true);
    expect(existsSync(sessionLog)).toBe(true);
    expect(readFileSync(sessionLog, 'utf8')).not.toContain('python main.py --secret token');
    expect(readFileSync(sessionLog, 'utf8')).toContain('"commandProgram":"python"');
  });
});
