const MONO_FONT_STACK = 'Consolas, "SFMono-Regular", "Courier New", monospace';

export const HOME_PAGE_STYLES = `
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
      font-family: ${MONO_FONT_STACK};
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
`;

export const ERROR_PAGE_STYLES = `
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --error: #ff6b6b;
      font-family: ${MONO_FONT_STACK};
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
`;

export const LEGACY_BROWSER_PAGE_STYLES = `
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
      font-family: ${MONO_FONT_STACK};
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
`;

export const XTERM_PAGE_STYLES = `
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
      font-family: ${MONO_FONT_STACK};
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
`;
