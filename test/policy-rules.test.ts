import { describe, expect, it } from 'vitest';

import { SSHSession, type SessionMetadata, type SessionTuning } from '../src/session.js';
import type { CustomPolicyRule } from '../src/validation.js';
import type { SSHConnection } from '../src/session.js';

function createSession() {
  const metadata: SessionMetadata = {
    instanceId: 'test-instance',
    sessionRef: 'policy/demo',
    profileSource: 'manual',
  };
  const tuning: SessionTuning = {
    maxBufferChars: 200000,
    defaultReadChars: 4000,
    maxTranscriptEvents: 2000,
    maxTranscriptChars: 200000,
    maxTranscriptEventChars: 40000,
    defaultDashboardRightEvents: 40,
    defaultDashboardLeftChars: 12000,
    maxHistoryLines: 4000,
  };
  const mockStream = {
    on: () => {},
    write: () => true,
    end: () => {},
    setWindow: () => {},
    stderr: { on: () => {} },
  };

  return new SSHSession(
    'policy-session',
    'policy-session',
    metadata,
    '192.168.1.1',
    22,
    'testuser',
    120,
    40,
    'xterm-256color',
    0,
    300000,
    tuning,
    null as unknown as SSHConnection,
    mockStream as unknown as any,
  );
}

describe('session custom policy rules', () => {
  it('inherits default rules and can reset back to them', () => {
    const session = createSession();
    const inherited: CustomPolicyRule[] = [
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
    ];

    session.setInheritedPolicyRules(inherited);
    expect(session.getPolicyRules()).toHaveLength(1);
    expect(session.summary().customPolicyRuleCount).toBe(1);

    session.upsertPolicyRule({
      id: 'block-kubectl-delete',
      enabled: true,
      pattern: '\\bkubectl\\s+delete\\b',
      mode: 'safe',
      category: 'dangerous',
      action: 'block',
      message: 'kubectl delete blocked',
    });

    expect(session.getPolicyRules().map(rule => rule.id).sort()).toEqual([
      'block-kubectl-delete',
      'warn-terraform-apply',
    ]);

    session.resetPolicyRules();

    expect(session.getPolicyRules().map(rule => rule.id)).toEqual(['warn-terraform-apply']);
  });

  it('removes session-level rules by id', () => {
    const session = createSession();
    session.setInheritedPolicyRules([]);
    session.upsertPolicyRule({
      id: 'block-kubectl-delete',
      enabled: true,
      pattern: '\\bkubectl\\s+delete\\b',
      mode: 'safe',
      category: 'dangerous',
      action: 'block',
      message: 'kubectl delete blocked',
    });

    session.removePolicyRule('block-kubectl-delete');

    expect(session.getPolicyRules()).toEqual([]);
  });

  it('restores an inherited default rule when a same-id session override is removed', () => {
    const session = createSession();
    session.setInheritedPolicyRules([
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
    ]);

    session.upsertPolicyRule({
      id: 'warn-terraform-apply',
      enabled: true,
      pattern: '\\bterraform\\s+apply\\b',
      mode: 'both',
      category: 'dangerous',
      action: 'block',
      message: 'session override',
    });

    const result = session.removePolicyRule('warn-terraform-apply');

    expect(result).toEqual({ removed: true, reason: 'restored_default' });
    expect(session.getPolicyRules()).toEqual([
      expect.objectContaining({
        id: 'warn-terraform-apply',
        action: 'warn',
        source: 'default',
      }),
    ]);
  });

  it('refuses to remove an inherited default rule directly', () => {
    const session = createSession();
    session.setInheritedPolicyRules([
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
    ]);

    const result = session.removePolicyRule('warn-terraform-apply');

    expect(result).toEqual({ removed: false, reason: 'default_rule_protected' });
    expect(session.getPolicyRules()).toEqual([
      expect.objectContaining({
        id: 'warn-terraform-apply',
        source: 'default',
      }),
    ]);
  });
});
