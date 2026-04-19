import { describe, expect, it } from 'vitest';

import {
  createBufferSnapshot,
  createEventSnapshot,
  getControlSequence,
  normalizeTerminalInput,
  parseArgv,
  renderTerminalDashboard,
  renderViewerTranscript,
  stripAnsi,
  type TranscriptEvent,
} from '../src/index';

describe('buffer snapshots', () => {
  it('returns the latest tail when offset is omitted', () => {
    const snapshot = createBufferSnapshot(0, 'abcdefghijklmnopqrstuvwxyz', undefined, 5, 5);

    expect(snapshot).toEqual({
      requestedOffset: null,
      effectiveOffset: 21,
      nextOffset: 26,
      availableStart: 0,
      availableEnd: 26,
      truncatedBefore: true,
      truncatedAfter: false,
      output: 'vwxyz',
    });
  });

  it('reads incrementally from a given offset', () => {
    const snapshot = createBufferSnapshot(100, 'hello world', 103, 4, 4);

    expect(snapshot).toEqual({
      requestedOffset: 103,
      effectiveOffset: 103,
      nextOffset: 107,
      availableStart: 100,
      availableEnd: 111,
      truncatedBefore: false,
      truncatedAfter: true,
      output: 'lo w',
    });
  });

  it('clips reads when the requested offset fell out of the buffer', () => {
    const snapshot = createBufferSnapshot(200, 'abcdef', 150, 10, 10);

    expect(snapshot).toEqual({
      requestedOffset: 150,
      effectiveOffset: 200,
      nextOffset: 206,
      availableStart: 200,
      availableEnd: 206,
      truncatedBefore: true,
      truncatedAfter: false,
      output: 'abcdef',
    });
  });
});

describe('event snapshots', () => {
  const events: TranscriptEvent[] = [
    { seq: 10, at: '2026-04-15T09:00:00.000Z', type: 'lifecycle', text: 'session opened' },
    { seq: 11, at: '2026-04-15T09:00:01.000Z', type: 'input', text: 'codex\n', actor: 'codex' },
    { seq: 12, at: '2026-04-15T09:00:02.000Z', type: 'output', text: 'ready\n' },
  ];

  it('returns the latest tail when event seq is omitted', () => {
    const snapshot = createEventSnapshot(10, events, undefined, 2, 1000, 2, 1000);

    expect(snapshot.requestedEventSeq).toBeNull();
    expect(snapshot.effectiveEventSeq).toBe(11);
    expect(snapshot.nextEventSeq).toBe(13);
    expect(snapshot.truncatedBefore).toBe(true);
    expect(snapshot.truncatedAfter).toBe(false);
    expect(snapshot.events.map(event => event.seq)).toEqual([11, 12]);
  });

  it('clips reads when the requested event seq fell out of the buffer', () => {
    const snapshot = createEventSnapshot(10, events, 1, 10, 1000, 10, 1000);

    expect(snapshot.effectiveEventSeq).toBe(10);
    expect(snapshot.truncatedBefore).toBe(true);
    expect(snapshot.nextEventSeq).toBe(13);
  });
});

describe('dashboard rendering', () => {
  it('removes ANSI escapes before rendering when requested', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('normalizes newlines to terminal carriage returns', () => {
    expect(normalizeTerminalInput('line1\nline2\r\nline3\rline4')).toBe('line1\rline2\rline3\rline4');
  });

  it('renders a terminal-style dashboard without split borders', () => {
    const dashboard = renderTerminalDashboard({
      title: 'SSH board',
      bodyText: 'line1\nline2\n[user] hello',
      width: 80,
      height: 8,
    });

    expect(dashboard).toContain('SSH board');
    expect(dashboard).toContain('line2');
    expect(dashboard).toContain('[user] hello');
    expect(dashboard).not.toContain('|');
  });

  it('renders transcript markers inline with terminal output', () => {
    const transcript = renderViewerTranscript([
      { seq: 1, at: '2026-04-15T09:00:00.000Z', type: 'lifecycle', text: 'session opened' },
      { seq: 2, at: '2026-04-15T09:00:01.000Z', type: 'input', text: 'ls\n', actor: 'codex' },
      { seq: 3, at: '2026-04-15T09:00:02.000Z', type: 'output', text: 'file1\nfile2\n' },
      { seq: 4, at: '2026-04-15T09:00:03.000Z', type: 'input', text: 'pwd\n', actor: 'user' },
    ], true);

    expect(transcript).toContain('[session] session opened');
    expect(transcript).toContain('[codex] ls');
    expect(transcript).toContain('file1');
    expect(transcript).toContain('[user] pwd');
  });
});

describe('control key sequences', () => {
  it('maps ctrl+c correctly', () => {
    expect(getControlSequence('ctrl_c')).toBe('\x03');
  });

  it('maps arrow keys correctly', () => {
    expect(getControlSequence('up')).toBe('\x1b[A');
    expect(getControlSequence('down')).toBe('\x1b[B');
  });
});

describe('cli config parsing', () => {
  it('parses viewer options from argv', () => {
    const previousArgv = process.argv;
    process.argv = [
      'node',
      'build/index.js',
      '--viewerPort=8765',
      '--viewerHost=127.0.0.1',
      '--viewerRefreshMs=1500',
    ];

    try {
      expect(parseArgv()).toEqual({
        viewerPort: '8765',
        viewerHost: '127.0.0.1',
        viewerRefreshMs: '1500',
      });
    } finally {
      process.argv = previousArgv;
    }
  });
});
