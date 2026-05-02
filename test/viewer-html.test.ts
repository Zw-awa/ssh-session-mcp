import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SSHSession, type SessionMetadata, type SessionTuning } from '../src/session.js';
import type { SSHConnection } from '../src/session.js';

let renderViewerHomePage: typeof import('../src/viewer-html.js').renderViewerHomePage;
let renderXtermSessionPage: typeof import('../src/viewer-html.js').renderXtermSessionPage;
let renderXtermBindingPage: typeof import('../src/viewer-html.js').renderXtermBindingPage;
let setActualViewerPort: typeof import('../src/server-state.js').setActualViewerPort;
let sessions: typeof import('../src/server-state.js').sessions;
let viewerBindings: typeof import('../src/server-state.js').viewerBindings;
let upsertViewerBinding: typeof import('../src/server-state.js').upsertViewerBinding;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  VIEWER_PORT: process.env.VIEWER_PORT,
  VIEWER_HOST: process.env.VIEWER_HOST,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-html-'));
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
  process.env.VIEWER_PORT = '8793';
  process.env.VIEWER_HOST = '127.0.0.1';
  process.env.BOARD_A_PASSWORD = 'dummy-password';

  const serverStateModule = await import('../src/server-state.js');
  serverStateModule.setActualViewerPort(8793);
  setActualViewerPort = serverStateModule.setActualViewerPort;
  sessions = serverStateModule.sessions;
  viewerBindings = serverStateModule.viewerBindings;
  upsertViewerBinding = serverStateModule.upsertViewerBinding;

  const viewerHtmlModule = await import('../src/viewer-html.js');
  renderViewerHomePage = viewerHtmlModule.renderViewerHomePage;
  renderXtermSessionPage = viewerHtmlModule.renderXtermSessionPage;
  renderXtermBindingPage = viewerHtmlModule.renderXtermBindingPage;
});

afterAll(() => {
  setActualViewerPort?.(0);

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('renderViewerHomePage', () => {
  it('renders footer values with real interpolation instead of literal template placeholders', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('SSH Session MCP • Auto‑refresh: 1000ms');
    expect(html).toContain('<code>http://127.0.0.1:8793</code>');
    expect(html).toContain('const refreshTimer = setTimeout(() => location.reload(), 1000);');
    expect(html).toContain("window.addEventListener('pagehide', () => clearTimeout(refreshTimer), { once: true });");
    expect(html).not.toContain('${refreshMs}');
    expect(html).not.toContain('${baseUrl}');
  });
});

function createFakeSession() {
  const metadata: SessionMetadata = {
    instanceId: 'test-instance',
    sessionRef: 'test/demo',
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
    'demo-session', 'demo-session', metadata,
    '192.168.1.1', 22, 'testuser',
    120, 40, 'xterm-256color',
    0, 300000, tuning,
    null as unknown as SSHConnection,
    mockStream as unknown as any,
  );
}

describe('renderXtermSessionPage', () => {
  it('returns an error page when session does not exist', () => {
    sessions.clear();
    const html = renderXtermSessionPage('nonexistent');
    expect(html).toContain('Session not found');
    expect(html).not.toContain('xterm');
  });

  it('renders xterm terminal page with guard flags when session exists', () => {
    const session = createFakeSession();
    sessions.clear();
    sessions.set('demo-session', session);

    const html = renderXtermSessionPage('demo-session');
    expect(html).toContain('xterm.min.js');
    expect(html).toContain('settingModeFromServer');
    expect(html).toContain('settingLockFromServer');
  });
});

describe('xterm script guard flags', () => {
  it('includes mode change guard to prevent broadcast feedback loop', () => {
    const session = createFakeSession();
    sessions.clear();
    sessions.set('demo-session', session);

    const html = renderXtermSessionPage('demo-session');
    expect(html).toContain('settingModeFromServer = true');
    expect(html).toContain('settingModeFromServer = false');
    expect(html).toContain('if (destroyed || settingModeFromServer) return;');
  });

  it('includes lock change guard to prevent broadcast feedback loop', () => {
    const session = createFakeSession();
    sessions.clear();
    sessions.set('demo-session', session);

    const html = renderXtermSessionPage('demo-session');
    expect(html).toContain('settingLockFromServer = true');
    expect(html).toContain('settingLockFromServer = false');
    expect(html).toContain('if (destroyed || settingLockFromServer) return;');
  });

  it('stops reconnecting on 4004 close code (session not found)', () => {
    const session = createFakeSession();
    sessions.clear();
    sessions.set('demo-session', session);

    const html = renderXtermSessionPage('demo-session');
    expect(html).toContain('evt.code === 4004');
    expect(html).toContain('Session not found');
    expect(html).toContain('setTimeout(connect, 2000)');
  });
});

describe('renderXtermBindingPage', () => {
  it('returns an error page when binding does not exist', () => {
    viewerBindings.clear();
    const html = renderXtermBindingPage('nonexistent-binding');
    expect(html).toContain('Binding not found');
    expect(html).not.toContain('xterm');
  });
});
