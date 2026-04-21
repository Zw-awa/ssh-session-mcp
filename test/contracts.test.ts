import { describe, expect, it } from 'vitest';

import { withToolContract } from '../src/contracts';

describe('withToolContract', () => {
  it('adds normalized contract fields without losing existing payload data', () => {
    const payload = withToolContract(
      {
        session: 'board-a/main',
        exitCode: 0,
      },
      {
        resultStatus: 'success',
        summary: 'Command completed.',
        nextAction: 'Continue with ssh-run.',
        evidence: [' session=board-a/main ', undefined, '', 'exitCode=0'],
      },
    );

    expect(payload.session).toBe('board-a/main');
    expect(payload.exitCode).toBe(0);
    expect(payload.resultStatus).toBe('success');
    expect(payload.summary).toBe('Command completed.');
    expect(payload.nextAction).toBe('Continue with ssh-run.');
    expect(payload.evidence).toEqual(['session=board-a/main', 'exitCode=0']);
  });

  it('drops empty evidence arrays', () => {
    const payload = withToolContract(
      { status: 'completed' },
      {
        resultStatus: 'partial_success',
        summary: 'No evidence attached.',
        evidence: [' ', undefined],
      },
    );

    expect(payload.evidence).toBeUndefined();
  });
});
