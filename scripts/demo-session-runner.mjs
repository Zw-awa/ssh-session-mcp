#!/usr/bin/env node

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePaneText, renderTerminalDashboard, renderTranscriptEvent, renderViewerTranscript } from '../build/shared.js';
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

function toOptionalNonNegativeInt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function toNonNegativeInt(value, fieldName, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --${fieldName}`);
  }

  return parsed;
}

function sanitizeActor(value, fallback = 'user') {
  const actor = optionalText(value, fallback) || fallback;
  if (actor.length > 40) {
    throw new Error('actor must be 40 characters or fewer');
  }
  return actor;
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

async function readJsonRequestBody(request) {
  let body = '';

  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (body.length > 1024 * 1024) {
      throw new Error('Request body exceeds 1 MiB');
    }
  }

  if (body.trim().length === 0) {
    return {};
  }

  return JSON.parse(body);
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
  const transcriptSnapshot = session.readEvents(
    undefined,
    Math.max(options.rightEvents * 8, options.height * 12, 120),
    Math.max(options.leftChars, options.width * options.height * 2),
  );
  const transcriptText = renderViewerTranscript(transcriptSnapshot.events, options.stripAnsiFromLeft);
  const leftTitleBase = session.sessionName
    ? `SSH ${session.sessionName} ${session.user}@${session.host}:${session.port}`
    : `SSH ${session.user}@${session.host}:${session.port}`;
  const title = session.closed ? `${leftTitleBase} [closed]` : leftTitleBase;

  return {
    terminalText,
    conversationText,
    transcriptText,
    leftTitle: title,
    rightTitle: '',
    dashboard: renderTerminalDashboard({
      title,
      bodyText: transcriptText,
      width: options.width,
      height: options.height,
      emptyPlaceholder: '(no terminal activity yet)',
    }),
  };
}

function createAttachPayload(session, options) {
  const outputSnapshot = session.read(options.outputOffset, options.maxChars);
  const eventSnapshot = session.readEvents(
    options.eventSeq,
    options.maxEvents,
    Math.max(options.maxChars * 4, tuning.defaultDashboardLeftChars),
  );

  return {
    summary: session.summary(),
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
    bindingKey,
    viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
    viewerUrl: buildBindingUrl(viewerHost, viewerPort, bindingKey),
    output: outputSnapshot.output,
    requestedOutputOffset: outputSnapshot.requestedOffset,
    effectiveOutputOffset: outputSnapshot.effectiveOffset,
    nextOutputOffset: outputSnapshot.nextOffset,
    outputAvailableStart: outputSnapshot.availableStart,
    outputAvailableEnd: outputSnapshot.availableEnd,
    outputTruncatedBefore: outputSnapshot.truncatedBefore,
    outputTruncatedAfter: outputSnapshot.truncatedAfter,
    requestedEventSeq: eventSnapshot.requestedEventSeq,
    effectiveEventSeq: eventSnapshot.effectiveEventSeq,
    nextEventSeq: eventSnapshot.nextEventSeq,
    eventAvailableStartSeq: eventSnapshot.availableStartSeq,
    eventAvailableEndSeq: eventSnapshot.availableEndSeq,
    eventTruncatedBefore: eventSnapshot.truncatedBefore,
    eventTruncatedAfter: eventSnapshot.truncatedAfter,
    events: eventSnapshot.events.filter(event => event.type !== 'output'),
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

function renderInteractiveAttachPage(options) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --panel-alt: #0f141b;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #91a0b3;
      --accent: #72d6d1;
      --warn: #ffbc6d;
      --error: #ff6b6b;
      --user: #2f81f7;
      --codex: #ff9f43;
      --claude: #b197fc;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top, #182232 0%, #0d1117 55%, #090c11 100%);
      color: var(--text);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .header, footer {
      padding: 16px 20px;
      background: rgba(22, 27, 34, 0.96);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    footer {
      border-bottom: 0;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 6px;
    }
    .subtitle, .meta {
      color: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .btn, .actor {
      height: 36px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--panel-alt);
      color: var(--text);
      font: inherit;
    }
    .btn {
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn:hover, .actor:focus, .terminal-shell:focus-within {
      border-color: var(--accent);
    }
    .btn.primary {
      background: var(--accent);
      color: #08242a;
      border-color: transparent;
      font-weight: 700;
    }
    .page {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 12px;
      padding: 16px 20px;
      min-height: 0;
    }
    .notice {
      color: var(--warn);
      font-size: 12px;
      background: rgba(255, 188, 109, 0.08);
      border: 1px solid rgba(255, 188, 109, 0.18);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .terminal-shell {
      min-height: 0;
      display: grid;
      grid-template-rows: 1fr auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(6, 10, 15, 0.92);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
    }
    .terminal-wrap {
      min-height: 0;
      overflow: auto;
      padding: 18px;
    }
    .terminal {
      margin: 0;
      min-height: 100%;
      color: var(--text);
      font-size: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      outline: none;
      caret-color: transparent;
    }
    .status {
      padding: 10px 14px;
      border-top: 1px solid var(--line);
      background: #1f2630;
      color: #f5f7fa;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status.user { background: var(--user); }
    .status.codex { background: var(--codex); color: #1a140a; }
    .status.claude { background: var(--claude); }
    .status.session { background: #4b5563; }
    .status.error { background: var(--error); }
    .status.idle { background: #253041; }
    .shortcut-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .shortcut-row code {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--text);
    }
    .home {
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px 20px;
    }
    .home-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(22, 27, 34, 0.92);
      padding: 18px 20px;
    }
    .home-card p {
      color: var(--muted);
      line-height: 1.6;
    }
    .home-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    @media (max-width: 900px) {
      .header {
        flex-direction: column;
      }
      .actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${escapeHtml(options.title)}</div>
      <div class="subtitle">${escapeHtml(options.subtitle)}</div>
      <div class="meta">${escapeHtml(options.meta)}</div>
    </div>
    <div class="actions">
      <a href="${options.baseUrl}" class="btn">Home</a>
      <select id="actor" class="actor">
        <option value="user"${options.actor === 'user' ? ' selected' : ''}>user</option>
        <option value="codex"${options.actor === 'codex' ? ' selected' : ''}>codex</option>
        <option value="claude"${options.actor === 'claude' ? ' selected' : ''}>claude</option>
      </select>
      <button id="focusBtn" class="btn primary" type="button">Focus</button>
      <button data-control="ctrl_c" class="btn" type="button">Ctrl+C</button>
      <button data-control="ctrl_d" class="btn" type="button">Ctrl+D</button>
      <button id="clearBtn" class="btn" type="button">Clear View</button>
    </div>
  </div>

  <div class="page">
    <div class="notice">Browser attach beta: this page shares the same SSH PTY with AI and supports manual input, but it normalizes ANSI/cursor control for web display. For highest terminal fidelity, continue to use the terminal attach viewer.</div>
    <div class="terminal-shell">
      <div class="terminal-wrap" id="terminalWrap">
        <pre id="terminal" class="terminal" tabindex="0">Connecting...</pre>
      </div>
      <div id="statusBar" class="status idle">[browser attach] connecting...</div>
    </div>
    <div class="shortcut-row">
      <span>Shortcuts:</span>
      <code>Enter</code><span>send line</span>
      <code>Tab</code><span>forward tab</span>
      <code>Arrow keys</code><span>forward navigation</span>
      <code>Ctrl+C</code><span>interrupt</span>
      <code>Ctrl+D</code><span>EOF</span>
      <code>Paste</code><span>send clipboard text</span>
    </div>
  </div>

  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)} • Browser attach refresh: ${viewerRefreshMs}ms</footer>

  <script>
    const attachBasePath = ${JSON.stringify(options.attachPath)};
    const refreshMs = ${viewerRefreshMs};
    const actorEl = document.getElementById('actor');
    const focusBtn = document.getElementById('focusBtn');
    const clearBtn = document.getElementById('clearBtn');
    const terminalEl = document.getElementById('terminal');
    const terminalWrapEl = document.getElementById('terminalWrap');
    const statusBarEl = document.getElementById('statusBar');
    const controlButtons = Array.from(document.querySelectorAll('[data-control]'));
    const state = {
      currentLine: '',
      eventSeq: undefined,
      outputOffset: undefined,
      lastEvent: undefined,
      lastStatusText: '[browser attach] connecting...',
      initialized: false,
      polling: false,
      closed: false,
      sendQueue: Promise.resolve(),
      resizeTimer: undefined,
    };
    const ansiPattern = /\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\].*?(?:\\u0007|\\u001B\\\\))/g;

    function stripAnsi(text) {
      return text.replace(ansiPattern, '');
    }

    function normalizeBrowserOutput(text) {
      return stripAnsi(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    }

    function normalizeTransportData(text) {
      return text.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
    }

    function summarizeEvent(event) {
      const compact = String(event.text || '').replace(/\\s+/g, ' ').trim();
      const clipped = compact.length > 96 ? compact.slice(0, 93) + '...' : compact;
      if (event.type === 'input') {
        return '[' + (event.actor || 'agent') + '] ' + (clipped || '<newline>');
      }
      if (event.type === 'control') {
        return '[' + (event.actor || 'agent') + '] <' + (clipped || 'control') + '>';
      }
      return '[session] ' + clipped;
    }

    function eventTheme(event, text) {
      if (text.startsWith('[browser attach] error')) return 'error';
      if (!event) return 'idle';
      if (event.actor === 'user') return 'user';
      if (event.actor === 'codex') return 'codex';
      if (event.actor === 'claude') return 'claude';
      return 'session';
    }

    function setStatus(text, event) {
      state.lastStatusText = text;
      statusBarEl.textContent = text;
      statusBarEl.className = 'status ' + eventTheme(event, text);
    }

    function appendOutput(output) {
      if (!output) return;
      const normalized = normalizeBrowserOutput(output);
      const nearBottom = terminalWrapEl.scrollTop + terminalWrapEl.clientHeight >= terminalWrapEl.scrollHeight - 36;
      if (terminalEl.textContent === 'Connecting...') {
        terminalEl.textContent = '';
      }
      terminalEl.textContent += normalized;
      if (terminalEl.textContent.length > 280000) {
        terminalEl.textContent = terminalEl.textContent.slice(-220000);
      }
      if (nearBottom) {
        terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
      }
    }

    function enqueue(task) {
      state.sendQueue = state.sendQueue.then(task).catch(function (error) {
        setStatus('[browser attach] error: ' + (error && error.message ? error.message : String(error)));
      });
      return state.sendQueue;
    }

    async function postJson(suffix, payload) {
      const response = await fetch(attachBasePath + suffix, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + await response.text());
      }
      return response.json();
    }

    function getActor() {
      return actorEl.value || 'user';
    }

    function focusTerminal() {
      terminalEl.focus();
      terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
    }

    function buildPasteRecords(text) {
      const records = [];
      const normalized = String(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (const character of normalized) {
        if (character === '\\n') {
          records.push({
            actor: getActor(),
            text: state.currentLine.length > 0 ? state.currentLine : '<newline>',
            type: 'input'
          });
          state.currentLine = '';
          continue;
        }
        if (character === '\\t') {
          state.currentLine += '\\t';
          continue;
        }
        if (character >= ' ') {
          state.currentLine += character;
        }
      }
      return records;
    }

    function sendRaw(data, records) {
      return enqueue(function () {
        return postJson('/input', {
          data: data,
          records: records || []
        });
      });
    }

    function sendControl(control, sequence) {
      if (control === 'ctrl_c') {
        state.currentLine = '';
      }
      return sendRaw(sequence, [{
        actor: getActor(),
        text: control,
        type: 'control'
      }]);
    }

    function estimateTerminalSize() {
      const rect = terminalWrapEl.getBoundingClientRect();
      const styles = window.getComputedStyle(terminalEl);
      const fontSize = Number.parseFloat(styles.fontSize || '14') || 14;
      const lineHeight = Number.parseFloat(styles.lineHeight || String(fontSize * 1.45)) || fontSize * 1.45;
      const charWidth = fontSize * 0.62;
      const cols = Math.max(40, Math.floor((rect.width - 36) / charWidth));
      const rows = Math.max(12, Math.floor((rect.height - 36) / lineHeight));
      return { cols, rows };
    }

    function scheduleResize() {
      if (state.resizeTimer) {
        window.clearTimeout(state.resizeTimer);
      }
      state.resizeTimer = window.setTimeout(function () {
        const size = estimateTerminalSize();
        enqueue(function () {
          return postJson('/resize', size);
        });
      }, 120);
    }

    async function pollOnce(waitMs) {
      const url = new URL(attachBasePath, window.location.origin);
      url.searchParams.set('maxChars', '16000');
      url.searchParams.set('maxEvents', '120');
      url.searchParams.set('waitMs', String(waitMs));
      if (typeof state.outputOffset === 'number') {
        url.searchParams.set('outputOffset', String(state.outputOffset));
      }
      if (typeof state.eventSeq === 'number') {
        url.searchParams.set('eventSeq', String(state.eventSeq));
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + await response.text());
      }

      const payload = await response.json();
      appendOutput(payload.output || '');
      if (Array.isArray(payload.events) && payload.events.length > 0) {
        const latestEvent = payload.events[payload.events.length - 1];
        state.lastEvent = latestEvent;
        const time = String(latestEvent.at || '').slice(11, 19);
        setStatus((time ? time + ' ' : '') + summarizeEvent(latestEvent), latestEvent);
      } else if (!state.initialized) {
        setStatus('[browser attach] connected');
      }

      state.outputOffset = payload.nextOutputOffset;
      state.eventSeq = payload.nextEventSeq;
      state.initialized = true;
      state.closed = payload.summary && payload.summary.closed === true;

      if (state.closed && !state.lastStatusText.includes('[closed]')) {
        setStatus('[browser attach] session closed');
      }
    }

    async function pollLoop() {
      if (state.polling) return;
      state.polling = true;
      while (true) {
        try {
          await pollOnce(state.initialized ? refreshMs : 0);
        } catch (error) {
          setStatus('[browser attach] error: ' + (error && error.message ? error.message : String(error)));
          await new Promise(function (resolve) { window.setTimeout(resolve, Math.min(refreshMs, 800)); });
        }
      }
    }

    terminalEl.addEventListener('keydown', function (event) {
      if (event.metaKey) return;

      if (event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
          event.preventDefault();
          void sendControl('ctrl_c', '\\u0003');
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          void sendControl('ctrl_d', '\\u0004');
          return;
        }
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const recordText = state.currentLine.length > 0 ? state.currentLine : '<newline>';
        state.currentLine = '';
        void sendRaw('\\r', [{
          actor: getActor(),
          text: recordText,
          type: 'input'
        }]);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        state.currentLine = state.currentLine.slice(0, -1);
        void sendRaw('\\u007f', []);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        state.currentLine += '\\t';
        void sendRaw('\\t', []);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        void sendRaw('\\u001b[A', []);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        void sendRaw('\\u001b[B', []);
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void sendRaw('\\u001b[D', []);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void sendRaw('\\u001b[C', []);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        void sendRaw('\\u001b', []);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
        event.preventDefault();
        state.currentLine += event.key;
        void sendRaw(event.key, []);
      }
    });

    terminalEl.addEventListener('paste', function (event) {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text');
      const records = buildPasteRecords(text);
      void sendRaw(normalizeTransportData(text), records);
    });

    focusBtn.addEventListener('click', function () {
      focusTerminal();
    });

    clearBtn.addEventListener('click', function () {
      terminalEl.textContent = '';
      focusTerminal();
    });

    controlButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        const control = button.getAttribute('data-control');
        if (control === 'ctrl_c') {
          void sendControl('ctrl_c', '\\u0003');
          return;
        }
        if (control === 'ctrl_d') {
          void sendControl('ctrl_d', '\\u0004');
        }
      });
    });

    actorEl.addEventListener('change', function () {
      setStatus('[browser attach] actor -> ' + getActor());
      focusTerminal();
    });

    window.addEventListener('resize', scheduleResize);
    terminalWrapEl.addEventListener('click', focusTerminal);
    window.addEventListener('load', function () {
      focusTerminal();
      scheduleResize();
      void pollLoop();
    });
  </script>
</body>
</html>`;
}

function renderBindingPage(bindingKey, viewerHost, viewerPort, viewerRefreshMs) {
  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/binding/${encodeURIComponent(bindingKey)}`,
    baseUrl: viewerBaseUrl(viewerHost, viewerPort),
    footerLabel: 'Binding key',
    footerValue: bindingKey,
    meta: [
      `target: ${sshUser}@${sshHost}:${sshPort}`,
      `sessionId: ${sessionId}`,
      `bindingKey: ${bindingKey}`,
      `viewerRefreshMs: ${viewerRefreshMs}`,
    ].join('\n'),
    subtitle: 'Interactive browser attach view',
    title: sessionName,
  });
}

function renderHomePage(bindingKey, viewerHost, viewerPort) {
  const bindingUrl = buildBindingUrl(viewerHost, viewerPort, bindingKey);
  const sessionUrl = buildSessionUrl(viewerHost, viewerPort, sessionId);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #91a0b3;
      --accent: #72d6d1;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top, #182232 0%, #0d1117 55%, #090c11 100%);
      color: var(--text);
    }
    .home {
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px 20px;
    }
    .home-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(22, 27, 34, 0.92);
      padding: 18px 20px;
    }
    .title {
      font-size: 24px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 8px;
    }
    p, li {
      color: var(--muted);
      line-height: 1.6;
    }
    .home-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .btn {
      height: 38px;
      padding: 0 14px;
      border-radius: 8px;
      border: 1px solid var(--line);
      color: var(--text);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      background: rgba(15, 20, 27, 0.92);
    }
    .btn.primary {
      background: var(--accent);
      border-color: transparent;
      color: #08242a;
      font-weight: 700;
    }
    code {
      color: var(--text);
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="home">
    <div class="home-card">
      <div class="title">SSH Session MCP Viewer</div>
      <p>当前 helper runner 已经连到同一个 SSH PTY。你可以用浏览器页手动输入，也可以让 AI 继续通过 attach API 或 MCP 工具往同一条会话里写命令。</p>
      <p>目标：<code>${escapeHtml(`${sshUser}@${sshHost}:${sshPort}`)}</code></p>
      <p>会话：<code>${escapeHtml(sessionName)}</code></p>
      <div class="home-actions">
        <a href="${escapeHtml(bindingUrl)}" class="btn primary">Open Shared Terminal</a>
        <a href="${escapeHtml(sessionUrl)}" class="btn">Session Alias</a>
      </div>
    </div>
  </div>
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

function writeText(response, statusCode, text) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
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
    void (async () => {
      const url = new URL(request.url || '/', viewerBaseUrl(viewerHost, viewerPort));
      const isBindingPath = pathname => pathname === '/api/viewer-binding/' + encodeURIComponent(bindingKey) || pathname === '/api/viewer-binding/' + bindingKey;
      const isBindingPagePath = pathname => pathname === '/binding/' + encodeURIComponent(bindingKey) || pathname === '/binding/' + bindingKey;
      const isSessionPagePath = pathname => pathname === '/session/' + encodeURIComponent(sessionId) || pathname === '/session/' + sessionId;
      const isAttachBindingPath = pathname => pathname === '/api/attach/binding/' + encodeURIComponent(bindingKey) || pathname === '/api/attach/binding/' + bindingKey;
      const isAttachSessionPath = pathname => pathname === '/api/attach/session/' + encodeURIComponent(sessionId) || pathname === '/api/attach/session/' + sessionId || pathname === '/api/attach/session/' + encodeURIComponent(sessionName) || pathname === '/api/attach/session/' + sessionName;
      const isAttachBindingInputPath = pathname => pathname === '/api/attach/binding/' + encodeURIComponent(bindingKey) + '/input' || pathname === '/api/attach/binding/' + bindingKey + '/input';
      const isAttachSessionInputPath = pathname => pathname === '/api/attach/session/' + encodeURIComponent(sessionId) + '/input' || pathname === '/api/attach/session/' + sessionId + '/input' || pathname === '/api/attach/session/' + encodeURIComponent(sessionName) + '/input' || pathname === '/api/attach/session/' + sessionName + '/input';
      const isAttachBindingResizePath = pathname => pathname === '/api/attach/binding/' + encodeURIComponent(bindingKey) + '/resize' || pathname === '/api/attach/binding/' + bindingKey + '/resize';
      const isAttachSessionResizePath = pathname => pathname === '/api/attach/session/' + encodeURIComponent(sessionId) + '/resize' || pathname === '/api/attach/session/' + sessionId + '/resize' || pathname === '/api/attach/session/' + encodeURIComponent(sessionName) + '/resize' || pathname === '/api/attach/session/' + sessionName + '/resize';

      if (url.pathname === '/health') {
        writeJson(response, 200, {
          ok: true,
          viewerBaseUrl: viewerBaseUrl(viewerHost, viewerPort),
          bindingKey,
          session: session.summary(),
        });
        return;
      }

      if (request.method === 'GET' && (isAttachBindingPath(url.pathname) || isAttachSessionPath(url.pathname))) {
        const requestedOutputOffset = toOptionalNonNegativeInt(url.searchParams.get('outputOffset'));
        const requestedEventSeq = toOptionalNonNegativeInt(url.searchParams.get('eventSeq'));
        const maxChars = toPositiveInt(url.searchParams.get('maxChars'), 'maxChars', tuning.defaultDashboardLeftChars);
        const maxEvents = toPositiveInt(url.searchParams.get('maxEvents'), 'maxEvents', tuning.defaultDashboardRightEvents * 4);
        const waitMs = toNonNegativeInt(url.searchParams.get('waitMs'), 'waitMs', 0);
        const baselineOutputOffset = typeof requestedOutputOffset === 'number' ? requestedOutputOffset : session.currentBufferEnd();
        const baselineEventSeq = typeof requestedEventSeq === 'number' ? requestedEventSeq : session.currentEventEnd();

        if (waitMs > 0) {
          await session.waitForChange({
            outputOffset: baselineOutputOffset,
            eventSeq: baselineEventSeq,
            waitMs,
          });
        }

        writeJson(response, 200, createAttachPayload(session, {
          outputOffset: requestedOutputOffset,
          eventSeq: requestedEventSeq,
          maxChars,
          maxEvents,
        }));
        return;
      }

      if (request.method === 'POST' && (isAttachBindingInputPath(url.pathname) || isAttachSessionInputPath(url.pathname))) {
        try {
          const body = await readJsonRequestBody(request);
          const rawData = typeof body.data === 'string' ? body.data : undefined;
          if (!rawData || rawData.length === 0) {
            throw new Error('data must be a non-empty string');
          }

          const records = [];
          if (Array.isArray(body.records)) {
            for (const value of body.records) {
              if (!value || typeof value !== 'object') {
                continue;
              }

              const candidate = value;
              if ((candidate.type !== 'input' && candidate.type !== 'control') || typeof candidate.text !== 'string') {
                continue;
              }

              records.push({
                actor: sanitizeActor(typeof candidate.actor === 'string' ? candidate.actor : undefined, 'user'),
                text: candidate.text,
                type: candidate.type,
              });
            }
          }

          session.writeRaw(rawData, records);
          writeJson(response, 200, {
            ok: true,
            recordedEvents: records.length,
            summary: session.summary(),
            nextOutputOffset: session.currentBufferEnd(),
            nextEventSeq: session.currentEventEnd(),
          });
        } catch (error) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (request.method === 'POST' && (isAttachBindingResizePath(url.pathname) || isAttachSessionResizePath(url.pathname))) {
        try {
          const body = await readJsonRequestBody(request);
          const cols = typeof body.cols === 'number' ? body.cols : Number(body.cols);
          const rows = typeof body.rows === 'number' ? body.rows : Number(body.rows);
          if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
            throw new Error('cols and rows must be positive integers');
          }

          session.resize(cols, rows);
          writeJson(response, 200, {
            ok: true,
            summary: session.summary(),
            cols,
            rows,
          });
        } catch (error) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (isBindingPath(url.pathname)) {
        writeJson(response, 200, createViewerBindingPayload({
          session,
          bindingKey,
          viewerHost,
          viewerPort,
          viewerRefreshMs,
        }));
        return;
      }

      if (isBindingPagePath(url.pathname)) {
        writeHtml(response, 200, renderBindingPage(bindingKey, viewerHost, viewerPort, viewerRefreshMs));
        return;
      }

      if (isSessionPagePath(url.pathname)) {
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
    })().catch(error => {
      writeText(response, 500, error instanceof Error ? error.message : String(error));
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
