import { describe, expect, it } from 'vitest';

import { buildReadMoreHint, buildReadProgress } from '../src/paging';

describe('paging helpers', () => {
  it('builds a normalized readMore hint', () => {
    expect(buildReadMoreHint({
      session: 'demo',
      offset: 10,
      maxCharsSuggested: 256,
      availableStart: 0,
      availableEnd: 1024,
    })).toEqual({
      session: 'demo',
      offset: 10,
      maxCharsSuggested: 256,
      availableStart: 0,
      availableEnd: 1024,
    });
  });

  it('reports recommended next offset from a buffer snapshot', () => {
    expect(buildReadProgress({
      requestedOffset: 10,
      effectiveOffset: 10,
      nextOffset: 128,
      availableStart: 0,
      availableEnd: 256,
      truncatedBefore: false,
      truncatedAfter: true,
      output: 'x'.repeat(118),
    })).toEqual({
      availableStart: 0,
      availableEnd: 256,
      recommendedNextOffset: 128,
    });
  });
});
