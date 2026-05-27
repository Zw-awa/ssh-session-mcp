import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let renderViewerHomePage: typeof import('../src/viewer-html.js').renderViewerHomePage;
let renderInteractiveAttachPage: typeof import('../src/viewer-html.js').renderInteractiveAttachPage;
let renderXtermTerminalPage: typeof import('../src/viewer-html.js').renderXtermTerminalPage;
let setActualViewerPort: typeof import('../src/server-state.js').setActualViewerPort;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  VIEWER_PORT: process.env.VIEWER_PORT,
  VIEWER_HOST: process.env.VIEWER_HOST,
  DEVICE_A_PASSWORD: process.env.DEVICE_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-lifecycle-'));
  const configPath = join(dir, 'ssh-session-mcp.config.json');

  writeFileSync(configPath, JSON.stringify({
    defaultDevice: 'DEVICE_A_ID',
    devices: [
      {
        id: 'DEVICE_A_ID',
        host: 'DEVICE_A_HOST',
        user: 'remote-user',
        auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
      },
    ],
  }, null, 2), 'utf8');

  process.env.SSH_MCP_DISABLE_MAIN = '1';
  process.env.SSH_MCP_CONFIG = configPath;
  process.env.VIEWER_PORT = '8793';
  process.env.VIEWER_HOST = '127.0.0.1';
  process.env.DEVICE_A_PASSWORD = 'dummy-password';

  const serverStateModule = await import('../src/server-state.js');
  serverStateModule.setActualViewerPort(8793);
  setActualViewerPort = serverStateModule.setActualViewerPort;

  const viewerHtmlModule = await import('../src/viewer-html.js');
  renderViewerHomePage = viewerHtmlModule.renderViewerHomePage;
  renderInteractiveAttachPage = viewerHtmlModule.renderInteractiveAttachPage;
  renderXtermTerminalPage = viewerHtmlModule.renderXtermTerminalPage;
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

describe('viewer lifecycle contracts', () => {
  it('cleans up the home page auto-refresh timer when the page closes', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('fetch("/api/sessions")');
    expect(html).toContain('scheduleRefresh()');
    expect(html).toContain("window.addEventListener(\"pagehide\"");
  });

  it('stops legacy browser polling and aborts pending fetches on page teardown', () => {
    const html = renderInteractiveAttachPage({
      actor: 'user',
      attachPath: '/api/attach/session/demo-session',
      baseUrl: 'http://127.0.0.1:8793',
      footerLabel: 'Session ID',
      footerValue: 'demo-session',
      meta: 'remote-user@DEVICE_A_HOST:22',
      subtitle: 'Interactive browser attach view',
      title: 'DEVICE_A_LABEL',
    });

    expect(html).toContain('state.stopped = true;');
    expect(html).toContain('state.pollController.abort();');
    expect(html).toContain('while (!state.stopped && !state.closed)');
    expect(html).toContain("listen(window, 'pagehide', shutdown);");
    expect(html).toContain("listen(window, 'beforeunload', shutdown);");
  });

  it('disposes xterm resources and blocks reconnect loops after teardown', () => {
    const html = renderXtermTerminalPage({
      attachKind: 'session',
      attachRef: 'demo-session',
      baseUrl: 'http://127.0.0.1:8793',
      footerLabel: 'Session ID',
      footerValue: 'demo-session',
      meta: 'remote-user@DEVICE_A_HOST:22',
      operationMode: 'safe',
      subtitle: 'Shared SSH Terminal',
      title: 'DEVICE_A_LABEL',
    });

    expect(html).toContain('destroyed = true;');
    expect(html).toContain('closeSocket();');
    expect(html).toContain('terminal.dispose();');
    expect(html).toContain("listen(window, 'pagehide', shutdown);");
    expect(html).toContain("listen(window, 'beforeunload', shutdown);");
  });
});
