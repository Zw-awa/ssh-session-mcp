import {
  sessions,
  escapeHtml,
  sessionDisplayName,
  getViewerBaseUrl,
  buildViewerBindingKeyForSession,
  buildViewerBindingUrl,
  buildViewerSessionUrl,
  resolveSession,
  viewerBindings,
  DEFAULT_VIEWER_REFRESH_MS,
  OPERATION_MODE,
  type SSHSession,
} from './server-state.js';

export function renderViewerHomePage() {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --panel-alt: #0f1319;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --warn: #ffb84d;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    header {
      margin-bottom: 30px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 24px;
      color: var(--accent);
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
    }
    .sessions {
      display: grid;
      gap: 15px;
    }
    .session-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      transition: border-color 0.2s;
    }
    .session-card:hover {
      border-color: var(--accent);
    }
    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 15px;
    }
    .session-title {
      font-weight: bold;
      font-size: 16px;
      color: var(--accent);
      overflow-wrap: anywhere;
    }
    .session-meta {
      font-size: 13px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .session-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 6px 12px;
      background: var(--panel-alt);
      border: 1px solid var(--line);
      border-radius: 4px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover {
      background: var(--line);
      border-color: var(--accent);
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
    }
    .btn-primary:hover {
      background: #5bc4c0;
      border-color: #5bc4c0;
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--muted);
      font-style: italic;
    }
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
    footer code {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    @media (max-width: 900px) {
      .session-header {
        flex-direction: column;
        align-items: flex-start;
      }
      .session-actions {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>SSH Session MCP Viewer</h1>
    <div class="subtitle">Real‑time SSH session monitoring</div>
  </header>

  <main>
    <div class="sessions">
      ${(() => {
        const sessionList = [...sessions.values()]
          .filter(s => !s.closed)
          .map(s => s.summary())
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        
        if (sessionList.length === 0) {
          return '<div class="empty-state">No active SSH sessions</div>';
        }
        
        return sessionList.map(session => {
          // PREPARE_DEPRECATION: Session View / Binding View keep old polling pages reachable during transition.
          const sessionUrl = `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
          const terminalUrl = `${baseUrl}/terminal/session/${encodeURIComponent(session.sessionId)}`;
          const bindingKey = buildViewerBindingKeyForSession(session, 'connection');
          const bindingUrl = `${baseUrl}/binding/${encodeURIComponent(bindingKey)}`;
          return `
            <div class="session-card">
              <div class="session-header">
                <div>
                  <div class="session-title">${escapeHtml(sessionDisplayName(session))}</div>
                  <div class="session-meta">${session.user}@${session.host}:${session.port}${session.deviceId ? ` • device=${escapeHtml(session.deviceId)}` : ''}${session.connectionName ? ` • connection=${escapeHtml(session.connectionName)}` : ''}</div>
                </div>
                <div class="session-actions">
                  <a href="${terminalUrl}" class="btn btn-primary" target="_blank">Terminal</a>
                  <a href="${sessionUrl}" class="btn" target="_blank">Session View</a>
                  <a href="${bindingUrl}" class="btn" target="_blank">Binding View</a>
                </div>
              </div>
              <div class="session-meta">
                Created: ${new Date(session.createdAt).toLocaleString()}
                • Last activity: ${new Date(session.updatedAt).toLocaleString()}
                ${session.idleExpiresAt ? `• Idle expires: ${new Date(session.idleExpiresAt).toLocaleString()}` : ''}
              </div>
            </div>
          `;
        }).join('');
      })()}
    </div>
  </main>

  <footer>
    <div>SSH Session MCP • Auto‑refresh: ${refreshMs}ms</div>
    <div>Viewer base URL: <code>${escapeHtml(baseUrl)}</code></div>
  </footer>

  <script>
    setTimeout(() => location.reload(), ${refreshMs});
  </script>
</body>
</html>`;
}

export function renderViewerErrorPage(options: {
  baseUrl: string;
  detail: string;
  footerLabel: string;
  footerValue: string;
  title: string;
}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --error: #ff6b6b;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .header, footer {
      padding: 16px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    footer {
      border-bottom: 0;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .body {
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .error {
      max-width: 720px;
      width: 100%;
      background: #0b0f15;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }
    .title {
      color: var(--error);
      font-size: 20px;
      margin-bottom: 12px;
    }
    .detail {
      color: var(--muted);
      white-space: pre-wrap;
      margin-bottom: 20px;
    }
    .btn {
      display: inline-block;
      padding: 8px 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="header">SSH Session MCP Viewer</div>
  <div class="body">
    <div class="error">
      <div class="title">${escapeHtml(options.title)}</div>
      <div class="detail">${escapeHtml(options.detail)}</div>
      <a class="btn" href="${options.baseUrl}">Return to Home</a>
    </div>
  </div>
  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)}</footer>
</body>
</html>`;
}

// PREPARE_DEPRECATION: Legacy browser attach page based on HTTP polling + normalized text rendering.
// Keep it for compatibility with older links for now; preferred browser entrypoints are the xterm-based /terminal/* routes.
export function renderInteractiveAttachPage(options: {
  actor: string;
  attachPath: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}) {
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

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
    <div class="terminal-shell" id="terminalShell">
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

  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)} • Browser attach refresh: ${refreshMs}ms</footer>

  <script>
    const attachBasePath = ${JSON.stringify(options.attachPath)};
    const refreshMs = ${refreshMs};
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

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /session/* browser page.
export function renderViewerSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  let sessionData: ReturnType<SSHSession['summary']> | null = null;

  try {
    sessionData = resolveSession(sessionRef).summary();
  } catch {
    sessionData = null;
  }

  if (!sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Session reference: ${sessionRef}`,
      footerLabel: 'Session ID',
      footerValue: sessionRef,
      title: 'Session not found',
    });
  }

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/session/${encodeURIComponent(sessionRef)}`,
    baseUrl,
    footerLabel: 'Session ID',
    footerValue: sessionRef,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}\nCreated: ${new Date(sessionData.createdAt).toLocaleString()}\nLast activity: ${new Date(sessionData.updatedAt).toLocaleString()}`,
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /binding/* browser page.
export function renderViewerBindingPage(bindingKey: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const binding = viewerBindings.get(bindingKey);
  const session = binding ? sessions.get(binding.sessionId) : null;
  const sessionData = session ? session.summary() : null;

  if (!binding || !sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Binding key: ${bindingKey}`,
      footerLabel: 'Binding key',
      footerValue: bindingKey,
      title: 'Binding not found',
    });
  }

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/binding/${encodeURIComponent(bindingKey)}`,
    baseUrl,
    footerLabel: 'Binding key',
    footerValue: bindingKey,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}\nBinding: ${bindingKey}\nCreated: ${new Date(sessionData.createdAt).toLocaleString()}\nLast activity: ${new Date(sessionData.updatedAt).toLocaleString()}`,
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}

export function renderXtermTerminalPage(options: {
  attachKind: 'session' | 'binding';
  attachRef: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}) {
  const wsProtocol = 'ws';
  const wsPath = options.attachKind === 'binding'
    ? `/ws/attach/binding/${encodeURIComponent(options.attachRef)}`
    : `/ws/attach/session/${encodeURIComponent(options.attachRef)}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #91a0b3;
      --accent: #72d6d1;
      --user: #2f81f7;
      --codex: #ff9f43;
      --claude: #b197fc;
      --locked: #f85149;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); }
    body { display: flex; flex-direction: column; }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
      flex-shrink: 0; gap: 12px; flex-wrap: wrap;
    }
    .header-left { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 320px; }
    .header-title { font-size: 15px; font-weight: 700; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-meta { font-size: 12px; color: var(--muted); white-space: normal; overflow-wrap: anywhere; }
    .header-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
    .btn {
      height: 30px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--line);
      background: rgba(255,255,255,0.04); color: var(--text); font: inherit; font-size: 12px; cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex-shrink: 0; }
    .conn-dot.disconnected { background: #f85149; }
    #terminal-container { flex: 1; min-height: 0; padding: 4px; }
    .status-bar {
      padding: 6px 16px; border-top: 1px solid var(--line); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
      background: #1f2630; color: #f5f7fa; transition: background 0.2s;
    }
    .status-bar.user { background: var(--user); }
    .status-bar.codex { background: var(--codex); color: #1a140a; }
    .status-bar.claude { background: var(--claude); }
    .status-bar.session { background: #4b5563; }
    .status-bar.error { background: #f85149; }
    .status-bar.locked { background: var(--locked); }
    .lock-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-left: 8px;
    }
    .lock-badge.agent { background: var(--claude); color: #fff; }
    .lock-badge.user-lock { background: var(--user); color: #fff; }
    .lock-badge.none { background: rgba(255,255,255,0.1); color: var(--muted); }
    @media (max-width: 900px) {
      .header {
        align-items: flex-start;
      }
      .header-actions {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="conn-dot" id="connDot"></div>
      <div class="header-title" id="headerTitle">${escapeHtml(options.title)}</div>
      <div class="header-meta" id="headerMeta">${escapeHtml(options.meta)}</div>
    </div>
    <div class="header-actions">
      <a href="${options.baseUrl}" class="btn">Home</a>
      <select id="actorSelect" class="btn" title="Switch input mode: common = both can type, user = only you type (AI blocked), claude/codex = AI types (your input blocked)">
        <option value="common" selected>common</option>
        <option value="user">user</option>
        <option value="codex">codex</option>
        <option value="claude">claude</option>
      </select>
      <select id="modeSelect" class="btn" title="Operation mode: safe = blocks dangerous commands, full = AI has full control">
        <option value="safe"${OPERATION_MODE === 'safe' ? ' selected' : ''}>safe</option>
        <option value="full"${OPERATION_MODE === 'full' ? ' selected' : ''}>full</option>
      </select>
      <span id="lockBadge" class="lock-badge none">unlocked</span>
    </div>
  </div>
  <div id="terminal-container"></div>
  <div class="status-bar" id="statusBar">Connecting...</div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
  (function() {
    var wsPath = ${JSON.stringify(wsPath)};
    var terminal = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 14,
      fontFamily: 'Consolas, "SFMono-Regular", "Courier New", monospace',
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#72d6d1',
        selectionBackground: 'rgba(114,214,209,0.3)',
      },
      allowProposedApi: true,
    });
    var fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    var connDot = document.getElementById('connDot');
    var statusBar = document.getElementById('statusBar');
    var actorSelect = document.getElementById('actorSelect');
    var lockBadge = document.getElementById('lockBadge');
    var headerTitle = document.getElementById('headerTitle');
    var ws = null;
    var currentLine = '';
    var reconnectTimer = null;
    var knownRawChars = 0;
    var isFirstConnect = true;
    var currentLock = 'none';
    var scrollTimer = null;
    var offsetDecoder = null;

    function getLockMode() {
      return actorSelect.value || 'common';
    }

    function getInputActor() {
      return 'user';
    }

    function isUserBlocked() {
      return currentLock === 'agent';
    }

    function updateLockUI(lock) {
      currentLock = lock;
      if (lock === 'agent') {
        lockBadge.textContent = 'AI active';
        lockBadge.className = 'lock-badge agent';
      } else if (lock === 'user') {
        lockBadge.textContent = 'user active';
        lockBadge.className = 'lock-badge user-lock';
      } else {
        lockBadge.textContent = 'unlocked';
        lockBadge.className = 'lock-badge none';
      }
      // Sync dropdown to match lock state
      if (lock === 'user' && actorSelect.value !== 'user') {
        actorSelect.value = 'user';
      } else if (lock === 'none' && actorSelect.value !== 'common') {
        actorSelect.value = 'common';
      }
    }

    function setStatus(text, theme) {
      statusBar.textContent = text;
      statusBar.className = 'status-bar' + (theme ? ' ' + theme : '');
    }

    function scheduleScrollToBottom() {
      if (scrollTimer !== null) return;
      scrollTimer = window.requestAnimationFrame(function() {
        scrollTimer = null;
        terminal.scrollToBottom();
      });
    }

    function eventTheme(event) {
      if (!event) return '';
      if (event.actor === 'user') return 'user';
      if (event.actor === 'codex') return 'codex';
      if (event.actor === 'claude') return 'claude';
      return 'session';
    }

    function summarizeEvent(event) {
      var compact = String(event.text || '').replace(/\\s+/g, ' ').trim();
      var clipped = compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
      if (event.eventType === 'input') return '[' + (event.actor || 'agent') + '] ' + (clipped || '<newline>');
      if (event.eventType === 'control') return '[' + (event.actor || 'agent') + '] <' + clipped + '>';
      return '[session] ' + clipped;
    }

    function connect() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.onclose = null; ws.close(); } catch(e) {} ws = null; }
      offsetDecoder = new window.TextDecoder('utf-8');
      var loc = window.location;
      var wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + wsPath;
      if (!isFirstConnect && knownRawChars > 0) {
        wsUrl += (wsUrl.indexOf('?') === -1 ? '?' : '&') + 'rawOffset=' + knownRawChars;
      }
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        connDot.className = 'conn-dot';
        if (isFirstConnect) { isFirstConnect = false; }
        currentLine = '';
        setStatus('Connected in ' + getLockMode() + ' mode', '');
        scheduleScrollToBottom();
      };

      ws.onmessage = function(evt) {
        if (evt.data instanceof ArrayBuffer) {
          var chunk = new Uint8Array(evt.data);
          terminal.write(chunk, function() {
            scheduleScrollToBottom();
          });
          if (offsetDecoder) {
            knownRawChars += offsetDecoder.decode(chunk, { stream: true }).length;
          }
          return;
        }
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'init' && msg.summary) {
            var s = msg.summary;
            headerTitle.textContent = (s.sessionName || s.sessionId || 'SSH') + ' ' + s.user + '@' + s.host + ':' + s.port;
            document.title = headerTitle.textContent + ' \\u2022 SSH Terminal';
            if (s.inputLock) { updateLockUI(s.inputLock); }
            scheduleScrollToBottom();
          }
          if (msg.type === 'event') {
            var time = String(msg.at || '').slice(11, 19);
            setStatus((time ? time + ' ' : '') + summarizeEvent(msg), eventTheme(msg));
          }
          if (msg.type === 'lock') {
            updateLockUI(msg.lock);
          }
          if (msg.type === 'mode') {
            modeSelect.value = msg.mode;
          }
          if (msg.type === 'lock_rejected') {
            setStatus('Input blocked: AI is active. Switch to "common" or "user" to type.', 'locked');
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        connDot.className = 'conn-dot disconnected';
        setStatus('Disconnected. Reconnecting...', 'error');
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = function() {};
    }

    function sendJson(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }

    terminal.onData(function(data) {
      if (isUserBlocked()) {
        setStatus('Input blocked: AI is active. Switch to "common" or "user" to type.', 'locked');
        return;
      }
      var records = [];
      var normalized = data.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (var i = 0; i < normalized.length; i++) {
        var ch = normalized[i];
        if (ch === '\\n') {
          records.push({ actor: getInputActor(), text: currentLine.length > 0 ? currentLine : '<newline>', type: 'input' });
          currentLine = '';
        } else if (ch === '\\u007f' || ch === '\\b') {
          currentLine = currentLine.slice(0, -1);
        } else if (ch === '\\u0003') {
          currentLine = '';
          records.push({ actor: getInputActor(), text: 'ctrl_c', type: 'control' });
        } else if (ch === '\\u0004') {
          records.push({ actor: getInputActor(), text: 'ctrl_d', type: 'control' });
        } else if (ch >= ' ') {
          currentLine += ch;
        }
      }
      var transportData = data.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
      sendJson({ type: 'input', data: transportData, records: records });
    });

    terminal.onBinary(function(data) {
      if (isUserBlocked()) return;
      sendJson({ type: 'input', data: data, records: [] });
    });

    window.addEventListener('resize', function() {
      fitAddon.fit();
      scheduleScrollToBottom();
    });

    terminal.onResize(function(size) {
      sendJson({ type: 'resize', cols: size.cols, rows: size.rows });
      scheduleScrollToBottom();
    });

    actorSelect.addEventListener('change', function() {
      var lockMode = getLockMode();
      if (lockMode === 'common') {
        sendJson({ type: 'lock', lock: 'none' });
        updateLockUI('none');
        setStatus('Switched to common mode. Both user and AI can type.', 'user');
      } else if (lockMode === 'user') {
        sendJson({ type: 'lock', lock: 'user' });
        updateLockUI('user');
        setStatus('Switched to user mode. AI input is blocked.', 'user');
      } else {
        sendJson({ type: 'lock', lock: 'agent' });
        updateLockUI('agent');
        setStatus('Switched to ' + lockMode + ' mode. AI controls the terminal. Your input is blocked.', 'claude');
      }
      terminal.focus();
    });

    var modeSelect = document.getElementById('modeSelect');
    modeSelect.addEventListener('change', function() {
      var newMode = modeSelect.value;
      if (newMode === 'full') {
        var confirmed = confirm('Warning: Full mode allows AI to execute dangerous commands (rm -rf, mkfs, etc.) without blocking.\\n\\nAre you sure you want to switch to full mode?');
        if (!confirmed) {
          modeSelect.value = 'safe';
          return;
        }
      }
      sendJson({ type: 'mode', mode: newMode });
      setStatus('Operation mode switched to: ' + newMode, newMode === 'full' ? 'error' : 'user');
      terminal.focus();
    });

    connect();
    terminal.focus();
    scheduleScrollToBottom();
  })();
  </script>
</body>
</html>`;
}

export function renderXtermSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  let sessionData: ReturnType<SSHSession['summary']> | null = null;

  try {
    sessionData = resolveSession(sessionRef).summary();
  } catch {
    sessionData = null;
  }

  if (!sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Session reference: ${sessionRef}`,
      footerLabel: 'Session ID',
      footerValue: sessionRef,
      title: 'Session not found',
    });
  }

  return renderXtermTerminalPage({
    attachKind: 'session',
    attachRef: sessionRef,
    baseUrl,
    footerLabel: 'Session ID',
    footerValue: sessionRef,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}`,
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}

export function renderXtermBindingPage(bindingKey: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const binding = viewerBindings.get(bindingKey);
  const session = binding ? sessions.get(binding.sessionId) : null;
  const sessionData = session ? session.summary() : null;

  if (!binding || !sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Binding key: ${bindingKey}`,
      footerLabel: 'Binding key',
      footerValue: bindingKey,
      title: 'Binding not found',
    });
  }

  return renderXtermTerminalPage({
    attachKind: 'binding',
    attachRef: bindingKey,
    baseUrl,
    footerLabel: 'Binding key',
    footerValue: bindingKey,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}`,
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}
