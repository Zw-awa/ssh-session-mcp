#!/usr/bin/env node

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { renderSplitDashboard, normalizePaneText, renderTranscriptEvent } from '../build/shared.js';
import { SSHConnection, SSHSession } from '../build/session.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_STATE_FILE = path.join(REPO_ROOT, '.demo-viewer-state.json');
const DEFAULT_VIEWER_HOST = '127.0.0.1';
const DEFAULT_VIEWER_PORT = 8793;
const DEFAULT_VIEWER_REFRESH_MS = 1000;
const DEFAULT_SESSION_NAME = 'ssh-session-mcp-demo';
const DEFAULT_STARTUP_INPUT = 'hostname && whoami && pwd';
const DEFAULT_STARTUP_ACTOR = 'codex';
const DEFAULT_TERM = 'xterm-256color';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const SSH_CONNECT_TIMEOUT_MS = 30000;

const tuning = {
  maxBufferChars: 200000,
  defaultReadChars: 4000,
  maxTranscriptEvents: 2000,
  maxTranscriptChars: 200000,
  maxTranscriptEventChars: 40000,
  defaultDashboardRightEvents: 40,
  defaultDashboardLeftChars: 12000,
};

function parseArgv(argv) {
  const config = {};

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      continue;
    }

    const equalIndex = raw.indexOf('=');
    if (equalIndex >= 0) {
      config[raw.slice(2, equalIndex)] = raw.slice(equalIndex + 1);
      continue;
    }

    const key = raw.slice(2);
    const next = argv[index + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      config[key] = next;
      index += 1;
    } else {
      config[key] = 'true';
    }
  }

  return config;
}

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required --${fieldName}`);
  }

  return value.trim();
}

function optionalText(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toPositiveInt(value, fieldName, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${fieldName}`);
  }

  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function decodeBase64Text(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  return Buffer.from(value, 'base64').toString('utf8');
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function viewerBaseUrl(host, port) {
  return `http://${host}:${port}`;
}

function buildBindingKey(user, host, port) {
  return `connection:${user}@${host}:${port}`;
}

function buildBindingUrl(host, port, bindingKey) {
  return `${viewerBaseUrl(host, port)}/binding/${encodeURIComponent(bindingKey)}`;
}

function buildSessionUrl(host, port, sessionId) {
  return `${viewerBaseUrl(host, port)}/session/${encodeURIComponent(sessionId)}`;
}

function createViewerPayload(session, options) {
  const outputSnapshot = session.read(undefined, options.leftChars);
  const conversationEvents = session.getConversationEvents(options.rightEvents);
  const terminalText = normalizePaneText(outputSnapshot.output, options.stripAnsiFromLeft);
  const conversationText = conversationEvents.map(renderTranscriptEvent).join('\n\n');
  const leftTitleBase = session.sessionName
    ? `SSH ${session.sessionName} ${session.user}@${session.host}:${session.port}`
    : `SSH ${session.user}@${session.host}:${session.port}`;
  const leftTitle = session.closed ? `${leftTitleBase} [closed]` : leftTitleBase;
  const rightTitle = 'Inputs (user / agent)';

  return {
    terminalText,
    conversationText,
    leftTitle,
    rightTitle,
    dashboard: renderSplitDashboard({
      leftTitle,
      rightTitle,
      leftText: terminalText,
      rightText: conversationText,
      width: options.width,
      height: options.height,
    }),
  };
}

function createViewerBindingPayload({ session, bindingKey, viewerHost, viewerPort, viewerRefreshMs }) {
  const payload = createViewerPayload(session, {
    width: 160,
    height: 28,
    leftChars: 12000,
    rightEvents: 40,
    stripAnsiFromLeft: true,
  });

  return {
    bindingKey,
    binding: {
      bindingKey,
      connectionKey: `${session.user}@${session.host}:${session.port}`,
      host: session.host,
      port: session.port,
      user: session.user,
      sessionId: session.sessionId,
      scope: 'connection',
      updatedAt: session.updatedAt,
    },
    summary: {
      ...session.summary(),
      viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
      viewerUrl: buildBindingUrl(viewerHost, viewerPort, bindingKey),
      sessionViewerUrl: buildSessionUrl(viewerHost, viewerPort, session.sessionId),
      viewerRefreshMs,
    },
    viewerUrl: buildBindingUrl(viewerHost, viewerPort, bindingKey),
    viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
    dashboard: payload.dashboard,
    terminalText: payload.terminalText,
    conversationText: payload.conversationText,
  };
}

function renderBindingPage(bindingKey, viewerHost, viewerPort, viewerRefreshMs) {
  const apiPath = `/api/viewer-binding/${encodeURIComponent(bindingKey)}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(bindingKey)} - SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f141b;
      --panel: #151d27;
      --line: #2f3b4d;
      --text: #e6edf6;
      --muted: #95a4b7;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top, #152032 0%, #0d1218 55%, #090c11 100%); color: var(--text); }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 20px; }
    .meta { color: var(--muted); margin-bottom: 12px; white-space: pre-wrap; }
    pre {
      margin: 0;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(21, 29, 39, 0.92);
      overflow: auto;
      min-height: 70vh;
      line-height: 1.25;
    }
    a { color: #79c0ff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="meta" id="meta">loading...</div>
    <pre id="dashboard">loading...</pre>
  </div>
  <script>
    const metaEl = document.getElementById('meta');
    const dashboardEl = document.getElementById('dashboard');
    const apiUrl = new URL(${JSON.stringify(apiPath)}, window.location.origin);
    let lastDashboard = '';

    async function refresh() {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(await response.text());
      }

      const payload = await response.json();
      const summary = payload.summary || {};
      const binding = payload.binding || {};
      const meta = [
        'bindingKey: ' + (binding.bindingKey || ${JSON.stringify(bindingKey)}),
        'target: ' + ((binding.user && binding.host) ? (binding.user + '@' + binding.host + ':' + binding.port) : 'unknown'),
        'sessionId: ' + (binding.sessionId || ''),
        'viewerUrl: ' + (payload.viewerUrl || ''),
        'updatedAt: ' + (binding.updatedAt || summary.updatedAt || ''),
        'refreshMs: ' + ${JSON.stringify(viewerRefreshMs)}
      ].join('\\n');

      metaEl.textContent = meta;
      if (payload.dashboard !== lastDashboard) {
        dashboardEl.textContent = payload.dashboard || '';
        lastDashboard = payload.dashboard || '';
      }
    }

    async function loop() {
      try {
        await refresh();
      } catch (error) {
        metaEl.textContent = String(error);
      } finally {
        window.setTimeout(loop, ${JSON.stringify(viewerRefreshMs)});
      }
    }

    loop();
  </script>
</body>
</html>`;
}

function renderHomePage(bindingKey, viewerHost, viewerPort) {
  const bindingUrl = buildBindingUrl(viewerHost, viewerPort, bindingKey);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Session MCP Viewer</title>
  <style>
    body {
      margin: 0;
      padding: 32px;
      background: #0d1117;
      color: #e6edf3;
      font: 16px/1.5 Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    a { color: #79c0ff; }
  </style>
</head>
<body>
  <h1>SSH Session MCP Viewer</h1>
  <p>绑定页面：<a href="${escapeHtml(bindingUrl)}">${escapeHtml(bindingUrl)}</a></p>
</body>
</html>`;
}

const rawArgs = parseArgv(process.argv.slice(2));
const stateFile = path.resolve(optionalText(rawArgs.stateFile, DEFAULT_STATE_FILE));
const viewerHost = optionalText(rawArgs.viewerHost, DEFAULT_VIEWER_HOST);
const viewerPort = toPositiveInt(rawArgs.viewerPort, 'viewerPort', DEFAULT_VIEWER_PORT);
const viewerRefreshMs = toPositiveInt(rawArgs.viewerRefreshMs, 'viewerRefreshMs', DEFAULT_VIEWER_REFRESH_MS);
const sessionName = optionalText(rawArgs.sessionName, DEFAULT_SESSION_NAME);
const startupInput = decodeBase64Text(rawArgs.startupInputBase64, optionalText(rawArgs.startupInput, DEFAULT_STARTUP_INPUT));
const startupInputActor = optionalText(rawArgs.startupInputActor, DEFAULT_STARTUP_ACTOR);
const sshHost = requireText(rawArgs.host, 'host');
const sshUser = requireText(rawArgs.user, 'user');
const sshPort = toPositiveInt(rawArgs.port, 'port', 22);
const sshPassword = optionalText(rawArgs.password, undefined);
const sshKeyPath = optionalText(rawArgs.key, undefined);

if (!sshPassword && !sshKeyPath) {
  throw new Error('Either --password or --key is required');
}

let privateKey;
if (sshKeyPath) {
  privateKey = await fs.readFile(path.resolve(REPO_ROOT, sshKeyPath), 'utf8');
}

const bindingKey = buildBindingKey(sshUser, sshHost, sshPort);
const sessionId = randomUUID();

let session;
let httpServer;
let shuttingDown = false;
let runnerState = {
  kind: 'ssh-session-mcp-demo-runner-state',
  status: 'starting',
  runnerPid: process.pid,
  serverPid: process.pid,
  repoRoot: REPO_ROOT,
  stateFile,
  startedAt: nowIso(),
  lastHeartbeatAt: null,
  stopReason: null,
  host: sshHost,
  port: sshPort,
  user: sshUser,
  sessionName,
  viewerHost,
  viewerPort,
  viewerRefreshMs,
  viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
  sessionId,
  viewerBindingKey: bindingKey,
  viewerBindingUrl: buildBindingUrl(viewerHost, viewerPort, bindingKey),
  viewerUrl: buildSessionUrl(viewerHost, viewerPort, sessionId),
  startupInput,
  startupInputActor,
};

async function persistState(extra = {}) {
  runnerState = {
    ...runnerState,
    ...extra,
  };

  await writeJsonFile(stateFile, runnerState);
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  try {
    await persistState({
      status: 'stopping',
      stopReason: reason,
      stoppedAt: nowIso(),
    });
  } catch {
    // ignore
  }

  try {
    session?.close(reason);
  } catch {
    // ignore
  }

  try {
    await new Promise(resolve => {
      if (!httpServer) {
        resolve();
        return;
      }

      httpServer.close(() => resolve());
    });
  } catch {
    // ignore
  }

  try {
    await persistState({
      status: 'stopped',
      stopReason: reason,
      stoppedAt: nowIso(),
    });
  } catch {
    // ignore
  }

  process.exit(exitCode);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function writeHtml(response, statusCode, html) {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

process.on('SIGINT', () => {
  void shutdown('runner received SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('runner received SIGTERM');
});

process.on('uncaughtException', error => {
  console.error('[runner] uncaught exception:', error);
  void shutdown(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`, 1);
});

process.on('unhandledRejection', error => {
  console.error('[runner] unhandled rejection:', error);
  void shutdown(`unhandledRejection: ${error instanceof Error ? error.message : String(error)}`, 1);
});

async function main() {
  await persistState();

  const connection = new SSHConnection({
    host: sshHost,
    port: sshPort,
    username: sshUser,
    password: sshPassword,
    privateKey,
  }, SSH_CONNECT_TIMEOUT_MS);

  await connection.connect();

  const stream = await new Promise((resolve, reject) => {
    connection.getClient().shell({
      term: DEFAULT_TERM,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    }, (error, clientStream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(clientStream);
    });
  });

  session = new SSHSession(
    sessionId,
    sessionName,
    sshHost,
    sshPort,
    sshUser,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    DEFAULT_TERM,
    0,
    0,
    tuning,
    connection,
    stream,
  );

  if (startupInput) {
    session.write(startupInput, startupInputActor);
  }

  await delay(600);

  httpServer = createServer((request, response) => {
    const url = new URL(request.url || '/', viewerBaseUrl(viewerHost, viewerPort));

    if (url.pathname === '/health') {
      writeJson(response, 200, {
        ok: true,
        viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
        bindingKey,
        session: session.summary(),
      });
      return;
    }

    if (url.pathname === '/api/viewer-binding/' + encodeURIComponent(bindingKey) || url.pathname === '/api/viewer-binding/' + bindingKey) {
      writeJson(response, 200, createViewerBindingPayload({
        session,
        bindingKey,
        viewerHost,
        viewerPort,
        viewerRefreshMs,
      }));
      return;
    }

    if (url.pathname === '/binding/' + encodeURIComponent(bindingKey) || url.pathname === '/binding/' + bindingKey) {
      writeHtml(response, 200, renderBindingPage(bindingKey, viewerHost, viewerPort, viewerRefreshMs));
      return;
    }

    if (url.pathname === '/session/' + encodeURIComponent(sessionId) || url.pathname === '/session/' + sessionId) {
      response.writeHead(302, { location: `/binding/${encodeURIComponent(bindingKey)}` });
      response.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      writeHtml(response, 200, renderHomePage(bindingKey, viewerHost, viewerPort));
      return;
    }

    writeJson(response, 404, {
      error: 'Not found',
      path: url.pathname,
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(viewerPort, viewerHost, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  await persistState({
    status: 'running',
    openedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
  });

  console.log(JSON.stringify(runnerState, null, 2));

  const heartbeatTimer = setInterval(async () => {
    try {
      const extra = {
        lastHeartbeatAt: nowIso(),
      };

      if (session.closed) {
        await persistState({
          ...extra,
          status: 'error',
          stopReason: session.closeReason || 'SSH session closed unexpectedly',
        });
        await shutdown(session.closeReason || 'SSH session closed unexpectedly', 1);
        return;
      }

      await persistState(extra);
    } catch (error) {
      console.error('[runner] heartbeat failed:', error);
      await shutdown(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, 1);
    }
  }, 15000);

  process.on('exit', () => {
    clearInterval(heartbeatTimer);
  });

  await new Promise(() => {});
}

main().catch(async error => {
  console.error('[runner] fatal:', error);
  try {
    await persistState({
      status: 'error',
      stopReason: error instanceof Error ? error.message : String(error),
      stoppedAt: nowIso(),
    });
  } catch {
    // ignore
  }
  process.exit(1);
});
