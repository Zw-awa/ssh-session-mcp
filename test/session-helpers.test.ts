import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBufferSnapshot,
  createEventSnapshot,
  getControlSequence,
  normalizeTerminalInput,
  renderTerminalDashboard,
  renderViewerTranscript,
  stripAnsi,
  type TranscriptEvent,
} from '../src/shared';
import {
  extractExitCodeFromText,
  findSentinelOutputInText,
  normalizeCompletionText,
} from '../src/session';

let buildSentinelCommandSuffix: typeof import('../src/index').buildSentinelCommandSuffix;
let appendSentinelToCommand: typeof import('../src/index').appendSentinelToCommand;
let parseArgv: typeof import('../src/index').parseArgv;
let stripSentinelFromOutput: typeof import('../src/index').stripSentinelFromOutput;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-session-helpers-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');

  writeFileSync(configPath, JSON.stringify({
    defaultDevice: 'board-a',
    devices: [
      {
        id: 'board-a',
        host: '192.168.10.58',
        user: 'orangepi',
        auth: { passwordEnv: 'BOARD_A_PASSWORD' },
      },
    ],
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.BOARD_A_PASSWORD = 'dummy-password';

  const indexModule = await import('../src/index');
  appendSentinelToCommand = indexModule.appendSentinelToCommand;
  buildSentinelCommandSuffix = indexModule.buildSentinelCommandSuffix;
  parseArgv = indexModule.parseArgv;
  stripSentinelFromOutput = indexModule.stripSentinelFromOutput;
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

describe('sentinel helpers', () => {
  it('normalizes CR-only completion text to logical lines', () => {
    expect(normalizeCompletionText('line1\rline2\rprompt$ ')).toBe('line1\nline2\nprompt$ ');
  });

  it('builds a shell-safe sentinel suffix', () => {
    const suffix = buildSentinelCommandSuffix('___MCP_DONE_deadbeef_');

    expect(suffix).toContain('printf');
    expect(suffix).toContain('\\n');
    expect(suffix).toContain('${__MCP_EC}');
    expect(suffix).not.toContain('$__MCP_EC___');
  });

  it('appends sentinel trailers on a new line for multi-line commands', () => {
    const rendered = appendSentinelToCommand("python - <<'PY'\nprint('ok')\nPY", '___MCP_DONE_deadbeef_');

    expect(rendered.commandWithSentinel).toContain("PY\n__MCP_EC=$?; printf");
    expect(rendered.sentinelSuffix).toBe('\n__MCP_EC=$?; printf "%s%s___\\n" "___MCP_DONE_deadbeef_" "\\${__MCP_EC}"'.replace('\\${', '\${'));
  });

  it('strips multi-line sentinel trailers from CR-delimited PTY output', () => {
    const marker = '___MCP_DONE_deadbeef_';
    const rendered = appendSentinelToCommand("python - <<'PY'\nprint('ok')\nPY", marker);
    const output = [
      rendered.commandWithSentinel.replace(/\n/g, '\r'),
      '\rok\r',
      `${marker}0___`,
    ].join('');

    const cleaned = stripSentinelFromOutput(output, marker, rendered.sentinelSuffix);

    expect(cleaned).toContain("python - <<'PY'");
    expect(cleaned).toContain("print('ok')");
    expect(cleaned).not.toContain('__MCP_EC=$?');
    expect(cleaned).not.toContain(marker);
  });

  it('removes sentinel artifacts without dropping real PTY output', () => {
    const marker = '___MCP_DONE_deadbeef_';
    const suffix = buildSentinelCommandSuffix(marker);
    const output = [
      `timeout 3 python main.py${suffix}\r`,
      'single detector ready\r',
      'fps=2.4 target=none rpm=(0.0,0.0)\r',
      `${marker}124___`,
    ].join('');

    const cleaned = stripSentinelFromOutput(output, marker, suffix);

    expect(cleaned).toContain('timeout 3 python main.py');
    expect(cleaned).toContain('single detector ready');
    expect(cleaned).toContain('fps=2.4 target=none rpm=(0.0,0.0)');
    expect(cleaned).not.toContain(marker);
    expect(cleaned).not.toContain('__MCP_EC=');
  });

  it('finds the emitted sentinel in CR-only PTY output', () => {
    const marker = '___MCP_DONE_deadbeef_';
    const text = `cmd; __MCP_EC=$?; printf "%s%s___\\n" "${marker}" "\${__MCP_EC}"\rline1\r${marker}124___`;

    expect(findSentinelOutputInText(text, marker)).toBeGreaterThanOrEqual(0);
    expect(extractExitCodeFromText(text, marker)).toBe(124);
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
