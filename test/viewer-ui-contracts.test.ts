/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MODULE_LOAD_TIMEOUT_MS = 60000;

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
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-viewer-ui-'));
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
}, MODULE_LOAD_TIMEOUT_MS);

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

  it('keeps viewer access policy fields inside their grid columns', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('* { box-sizing: border-box; }');
    expect(html).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(html).toContain('min-width: 0;');
    expect(html).toContain('max-width: 100%;');
  });

  it('keeps the empty sessions state stable across auto-refresh', () => {
    const html = renderViewerHomePage();

    expect(html).toContain("if (!root.querySelector('.empty-state'))");
    expect(html).toContain("root.innerHTML = '<div class=\"empty-state\">No active SSH sessions</div>';");
    expect(html).not.toContain('.empty-state {\n      text-align: center;\n      padding: 40px 20px;\n      color: var(--muted);\n      font-style: italic;\n      animation:');
  });

  it('does not animate active session badges during auto-refresh', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('.badge-active { background: #1f7a43; color: #dfffe7; }');
    expect(html).not.toContain('.badge-active { background: #1f7a43; color: #dfffe7; animation:');
  });

  it('opens terminal links in the same tab so Home returns to the same viewer page', () => {
    const html = renderViewerHomePage();

    expect(html).toContain('data-role="terminal-link" href="/terminal/session/');
    expect(html).not.toContain('data-role="terminal-link" target="_blank"');
  });

  it('treats xterm common mode as an unlocked mode instead of coercing it to user lock', () => {
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

    expect(html).toContain('function getLockMode()');
    expect(html).toContain("function getInputActor()");
    expect(html).toContain("if (lockMode === 'common')");
    expect(html).toContain("sendJson({ type: 'lock', lock: 'none' });");
    expect(html).toContain('<option value="auto" selected>auto</option>');
    expect(html).toContain("sendJson({ type: 'draft_state', active: active });");
    expect(html).toContain('function updateLockPolicy(policy)');
    expect(html).toContain("if (s.lockPolicy) { updateLockPolicy(s.lockPolicy); }");
    expect(html).toContain("if (msg.lockPolicy) { updateLockPolicy(msg.lockPolicy); }");
    expect(html).not.toContain("var actor = getActor();");
  });

  it('keeps xterm select arrows from animating across the toolbar', () => {
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

    expect(html).toContain('transition: background-color 0.2s var(--ease), border-color 0.2s var(--ease), color 0.2s var(--ease), transform 0.2s var(--ease);');
    expect(html).toContain('background-position: right 8px center;');
    expect(html).toContain('background-size: 8px 5px;');
  });

  it('keeps the legacy browser attach page polling loop and retry backoff intact', () => {
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

    expect(html).toContain("if (state.polling) return;");
    expect(html).toContain("await pollOnce(state.initialized ? refreshMs : 0);");
    expect(html).toContain("Math.min(refreshMs, 800)");
    expect(html).toContain("listen(window, 'load', handleWindowLoad);");
    expect(html).toContain("scheduleResize();");
  });

  it('keeps xterm websocket reconnect and raw-offset resume behavior intact', () => {
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

    expect(html).toContain("rawOffset=' + knownRawChars");
    expect(html).toContain("knownRawChars += offsetDecoder.decode(chunk, { stream: true }).length;");
    expect(html).toContain('reconnectAttempt += 1;');
    expect(html).toContain('maxReconnectAttempts');
    expect(html).toContain('Math.pow(1.5, reconnectAttempt - 1)');
    expect(html).toContain("ws.binaryType = 'arraybuffer';");
  });
});
