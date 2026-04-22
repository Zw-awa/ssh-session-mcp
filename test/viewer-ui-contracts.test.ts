import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let renderViewerHomePage: typeof import('../src/viewer-html').renderViewerHomePage;
let renderXtermTerminalPage: typeof import('../src/viewer-html').renderXtermTerminalPage;
let setActualViewerPort: typeof import('../src/server-state').setActualViewerPort;

const previousEnv = {
  SSH_MCP_DISABLE_MAIN: process.env.SSH_MCP_DISABLE_MAIN,
  SSH_MCP_CONFIG: process.env.SSH_MCP_CONFIG,
  VIEWER_PORT: process.env.VIEWER_PORT,
  VIEWER_HOST: process.env.VIEWER_HOST,
  BOARD_A_PASSWORD: process.env.BOARD_A_PASSWORD,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-ui-'));
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

  const serverStateModule = await import('../src/server-state');
  serverStateModule.setActualViewerPort(8793);
  setActualViewerPort = serverStateModule.setActualViewerPort;

  const viewerHtmlModule = await import('../src/viewer-html');
  renderViewerHomePage = viewerHtmlModule.renderViewerHomePage;
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

describe('viewer UI contracts', () => {
  it('keeps the home page layout responsive for narrow screens', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('@media (max-width: 900px)');
    expect(html).toContain('.session-header');
    expect(html).toContain('flex-direction: column;');
    expect(html).toContain('overflow-wrap: anywhere;');
  });

  it('treats xterm common mode as an unlocked mode instead of coercing it to user lock', () => {
    const html = renderXtermTerminalPage({
      attachKind: 'session',
      attachRef: 'demo-session',
      baseUrl: 'http://127.0.0.1:8793',
      footerLabel: 'Session ID',
      footerValue: 'demo-session',
      meta: 'orangepi@192.168.10.58:22',
      subtitle: 'Shared SSH Terminal',
      title: 'orange-board',
    });

    expect(html).toContain('function getLockMode()');
    expect(html).toContain("function getInputActor()");
    expect(html).toContain("if (lockMode === 'common')");
    expect(html).toContain("sendJson({ type: 'lock', lock: 'none' });");
    expect(html).not.toContain("var actor = getActor();");
  });
});
