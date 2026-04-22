import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let renderViewerHomePage: typeof import('../src/viewer-html.js').renderViewerHomePage;
let setActualViewerPort: typeof import('../src/server-state.js').setActualViewerPort;

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

  const viewerHtmlModule = await import('../src/viewer-html.js');
  renderViewerHomePage = viewerHtmlModule.renderViewerHomePage;
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
