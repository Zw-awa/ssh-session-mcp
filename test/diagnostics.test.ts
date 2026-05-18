import { describe, expect, it } from 'vitest';

import { buildSessionDiagnosticReport } from '../src/diagnostics';

describe('diagnostics', () => {
  it('emits warnings for password prompts, trimmed buffers, and stale agent locks', () => {
    const report = buildSessionDiagnosticReport({
      session: {
        sessionId: 's1',
        sessionName: 'demo',
        sessionRef: 'demo-ref',
        instanceId: 'instance-a',
        profileSource: 'manual',
        host: 'board',
        port: 22,
        user: 'remote-user',
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
        lockPolicy: 'common',
        inputLock: 'agent',
        userDraftActive: false,
        customPolicyRuleCount: 0,
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
    expect(report.policy.defaultRuleCount).toBe(0);
    expect(report.policy.sessionOverrideRuleCount).toBe(0);
  });

  it('does not flag agent-only policy mode as a stale agent lock', () => {
    const report = buildSessionDiagnosticReport({
      session: {
        sessionId: 's-agent',
        sessionName: 'demo',
        sessionRef: 'demo-ref',
        instanceId: 'instance-a',
        profileSource: 'manual',
        host: 'board',
        port: 22,
        user: 'remote-user',
        cols: 120,
        rows: 40,
        term: 'xterm-256color',
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:01:00.000Z',
        lastActivityAt: '2026-04-21T00:01:00.000Z',
        idleTimeoutMs: 1000,
        closed: false,
        bufferStart: 0,
        bufferEnd: 40,
        eventStartSeq: 0,
        eventEndSeq: 8,
        lockPolicy: 'agent',
        inputLock: 'agent',
        userDraftActive: false,
        customPolicyRuleCount: 0,
      },
      terminalMode: 'shell',
      historyLineStart: 1,
      historyLineEnd: 20,
      historyPendingOutput: false,
      logDir: 'logs/session-mcp',
      logMode: 'meta',
    });

    const codes = report.warnings.map(item => item.code);
    expect(codes).not.toContain('agent_lock_without_command');
  });

  it('emits an auto lock warning when a browser draft is active', () => {
    const report = buildSessionDiagnosticReport({
      session: {
        sessionId: 's2',
        sessionName: 'demo',
        sessionRef: 'demo-ref',
        instanceId: 'instance-a',
        profileSource: 'manual',
        host: 'board',
        port: 22,
        user: 'remote-user',
        cols: 120,
        rows: 40,
        term: 'xterm-256color',
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:01:00.000Z',
        lastActivityAt: '2026-04-21T00:01:00.000Z',
        idleTimeoutMs: 1000,
        closed: false,
        bufferStart: 0,
        bufferEnd: 40,
        eventStartSeq: 0,
        eventEndSeq: 8,
        lockPolicy: 'auto',
        inputLock: 'user',
        userDraftActive: true,
        userDraftUpdatedAt: '2026-04-21T00:01:00.000Z',
      },
      terminalMode: 'shell',
      historyLineStart: 1,
      historyLineEnd: 20,
      historyPendingOutput: false,
      logDir: 'logs/session-mcp',
      logMode: 'meta',
      policy: {
        activeRuleCount: 2,
        defaultRuleCount: 1,
        rules: [
          {
            id: 'warn-terraform-apply',
            enabled: true,
            pattern: '\\bterraform\\s+apply\\b',
            mode: 'both',
            category: 'dangerous',
            action: 'warn',
            message: 'terraform apply is risky',
            source: 'default',
          },
          {
            id: 'block-kubectl-delete',
            enabled: true,
            pattern: '\\bkubectl\\s+delete\\b',
            mode: 'safe',
            category: 'dangerous',
            action: 'block',
            message: 'kubectl delete blocked',
            source: 'session',
          },
        ],
        sessionOverrideRuleCount: 1,
        sessionOverrideRules: [
          {
            id: 'block-kubectl-delete',
            enabled: true,
            pattern: '\\bkubectl\\s+delete\\b',
            mode: 'safe',
            category: 'dangerous',
            action: 'block',
            message: 'kubectl delete blocked',
            source: 'session',
          },
        ],
        sessionRuleCount: 2,
      },
    });

    const codes = report.warnings.map(item => item.code);
    expect(codes).toContain('auto_lock_draft_active');
    expect(report.policy.activeRuleCount).toBe(2);
    expect(report.policy.defaultRuleCount).toBe(1);
    expect(report.policy.sessionOverrideRuleCount).toBe(1);
    expect(report.policy.sessionOverrideRules.map(rule => rule.id)).toEqual(['block-kubectl-delete']);
  });
});
