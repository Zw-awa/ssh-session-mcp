import { describe, expect, it } from 'vitest';

import { SessionHistory } from '../src/history';

describe('SessionHistory', () => {
  it('flushes pending output before non-output events', () => {
    const history = new SessionHistory(10);
    history.appendOutput('board$ ');
    history.appendEvent('input', 'ls', 'codex', '2026-04-21T00:00:00.000Z');

    const snapshot = history.read(undefined, 10);

    expect(snapshot.lines.map(line => line.text)).toEqual(['board$ ', 'ls']);
    expect(snapshot.view).toContain('[codex] ls');
  });

  it('keeps partial output visible as a virtual line', () => {
    const history = new SessionHistory(10);
    history.appendOutput('partial');

    const snapshot = history.read(undefined, 10);

    expect(snapshot.availableStart).toBe(1);
    expect(snapshot.availableEnd).toBe(2);
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0].text).toBe('partial');
  });

  it('trims oldest lines when the ring buffer is full', () => {
    const history = new SessionHistory(3);
    history.appendOutput('a\nb\nc\nd\n');

    const snapshot = history.read(undefined, 10);

    expect(snapshot.availableStart).toBe(2);
    expect(snapshot.availableEnd).toBe(5);
    expect(snapshot.lines.map(line => line.text)).toEqual(['b', 'c', 'd']);
  });
});
