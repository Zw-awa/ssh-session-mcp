import { describe, expect, it } from 'vitest';

import { buildSessionDiagnosticReport } from '../src/diagnostics';

describe('diagnostics', () => {
  it('emits warnings for password prompts, trimmed buffers, and stale agent locks', () => {
    const report = buildSessionDiagnosticReport({
      session: {
        sessionId: 's1',
        sessionName: 'demo',
        host: 'board',
        port: 22,
        user: 'orangepi',
        cols: 120,
        rows: 40,
        term: 'xterm-256color',
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:01:00.000Z',
        lastActivityAt: '2026-04-21T00:01:00.000Z',
        idleTimeoutMs: 1000,
        closed: false,
        bufferStart: 12,
        bufferEnd: 40,
        eventStartSeq: 3,
        eventEndSeq: 8,
        inputLock: 'agent',
      },
      terminalMode: 'password_prompt',
      historyLineStart: 4,
      historyLineEnd: 20,
      historyPendingOutput: false,
      logDir: 'logs/session-mcp',
      logMode: 'meta',
    });

    const codes = report.warnings.map(item => item.code);
    expect(codes).toContain('password_prompt');
    expect(codes).toContain('agent_lock_without_command');
    expect(codes).toContain('buffer_trimmed');
  });
});
