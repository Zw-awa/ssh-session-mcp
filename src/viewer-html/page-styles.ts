const MONO_FONT_STACK = 'Consolas, "SFMono-Regular", "Courier New", monospace';

export const HOME_PAGE_STYLES = `
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #121923;
      --panel-alt: #0f141c;
      --line: #273243;
      --text: #e8edf5;
      --muted: #92a6bb;
      --accent: #78d2bf;
      --warn: #ffb84d;
      --error: #ff6b6b;
      --user: #3b82f6;
      --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
      font-family: ${MONO_FONT_STACK};
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    body {
      margin: 0;
      padding: 24px;
      background:
        radial-gradient(circle at top left, rgba(120, 210, 191, 0.14), transparent 28%),
        linear-gradient(180deg, #0d1117 0%, #091018 100%);
      color: var(--text);
      line-height: 1.6;
    }
    main { animation: fadeIn 0.35s var(--ease); }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 24px;
      padding: 24px;
      border: 1px solid rgba(120, 210, 191, 0.18);
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(20, 31, 44, 0.96), rgba(12, 19, 28, 0.9));
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
    }
    .hero-kicker {
      margin: 0 0 8px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
      font-size: 12px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(30px, 4vw, 44px);
      color: var(--accent);
    }
    .hero-copy {
      color: var(--muted);
      font-size: 15px;
      max-width: 780px;
      text-wrap: pretty;
    }
    .hero-meta {
      min-width: 220px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .hero-meta div {
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .hero-meta span {
      display: block;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .hero-meta strong {
      display: block;
      margin-top: 4px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .home-grid {
      display: grid;
      gap: 18px;
    }
    .policy-panel,
    .sessions-panel {
      background: rgba(18, 25, 35, 0.94);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 16px 50px rgba(0, 0, 0, 0.2);
    }
    .panel-heading {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 16px;
    }
    .panel-heading h2 {
      margin: 0;
      font-size: 20px;
      color: var(--accent);
    }
    .panel-heading p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
      max-width: 760px;
    }
    .access-form {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .access-form label,
    .rule-editor label {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .rule-textarea,
    .rule-input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-alt);
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
      font-size: 13px;
    }
    .rule-textarea {
      min-height: 112px;
      resize: vertical;
    }
    .rule-input.short {
      min-width: 0;
    }
    .rule-input.wide {
      min-width: 220px;
    }
    .rule-input:focus-visible,
    .rule-textarea:focus-visible {
      outline: 2px solid rgba(120, 210, 191, 0.4);
      outline-offset: 1px;
      border-color: var(--accent);
    }
    .global-notice,
    .tiny-text {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 10px;
    }
    .sessions {
      display: grid;
      gap: 15px;
    }
    .session-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      transition: transform 0.25s var(--ease), border-color 0.25s var(--ease), box-shadow 0.25s var(--ease);
      animation: fadeIn 0.4s var(--ease) both;
    }
    .session-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(109, 211, 206, 0.08);
    }
    .session-card:active {
      transform: translateY(0);
    }
    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 15px;
    }
    .session-heading {
      display: grid;
      gap: 6px;
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
      border-radius: 5px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s var(--ease);
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .btn:hover {
      background: var(--line);
      border-color: var(--accent);
      transform: scale(1.03);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 6px;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
      font-weight: 600;
    }
    .btn-primary:hover {
      background: #5bc4c0;
      border-color: #5bc4c0;
      box-shadow: 0 0 16px rgba(109, 211, 206, 0.25);
    }
    .btn-primary:active {
      box-shadow: 0 0 8px rgba(109, 211, 206, 0.15);
    }
    .btn-danger {
      background: transparent;
      border-color: rgba(255, 107, 107, 0.3);
      color: #ff6b6b;
    }
    .btn-danger:hover {
      background: rgba(255, 107, 107, 0.12);
      border-color: #ff6b6b;
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--muted);
      font-style: italic;
      animation: fadeIn 0.5s var(--ease);
    }
    .status-badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      vertical-align: middle;
      margin-left: 6px;
      transition: background 0.3s var(--ease);
    }
    .badge-active { background: #1f7a43; color: #dfffe7; animation: pulse 2s ease-in-out infinite; }
    .badge-idle { background: #835d16; color: #ffe4a0; }
    .badge-mode { background: rgba(120, 210, 191, 0.14); color: var(--accent); }
    .badge-agent { background: rgba(255, 107, 107, 0.16); color: #ffc9c9; }
    .badge-user { background: rgba(59, 130, 246, 0.18); color: #d8e9ff; }
    .session-state-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .detail-shell {
      margin-top: 12px;
      display: grid;
      gap: 12px;
    }
    .debug-tools {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px dashed rgba(255, 255, 255, 0.08);
    }
    .debug-runner,
    .debug-controls {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .debug-input {
      min-width: 280px;
      flex: 1 1 320px;
    }
    .detail-panel,
    .rule-editor {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px;
      background: rgba(8, 13, 19, 0.78);
    }
    .detail-panel h3,
    .rule-editor-header strong {
      margin: 0;
      color: var(--accent);
      font-size: 14px;
    }
    .detail-copy,
    .detail-loading,
    .detail-error {
      font-size: 12px;
      color: var(--muted);
      margin-top: 8px;
    }
    .detail-error {
      color: #ffc9c9;
    }
    .history-view {
      margin: 12px 0 0;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      overflow: auto;
      max-height: 260px;
      color: var(--text);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .rule-editor-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .rule-editor-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .rule-list {
      display: grid;
      gap: 10px;
    }
    .rule-row {
      display: grid;
      gap: 10px;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.025);
    }
    .rule-row-top {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .rule-row-bottom {
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(240px, 2fr) minmax(90px, 120px) minmax(240px, 1.5fr) minmax(240px, 1.5fr);
      align-items: center;
    }
    .rule-row.dragging {
      opacity: 0.4;
    }
    .rule-handle {
      cursor: grab;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
      user-select: none;
      text-align: center;
    }
    .rule-handle:active {
      cursor: grabbing;
    }
    .rule-toggle {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: var(--text);
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
      .hero,
      .panel-heading,
      .rule-editor-header {
        flex-direction: column;
      }
      .access-form {
        grid-template-columns: 1fr;
      }
      .session-header {
        flex-direction: column;
        align-items: flex-start;
      }
      .session-actions {
        width: 100%;
      }
      .rule-row-bottom {
        grid-template-columns: 1fr;
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
      --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
      font-family: ${MONO_FONT_STACK};
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
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
      animation: fadeIn 0.4s var(--ease);
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
      transition: all 0.2s var(--ease);
    }
    .btn:hover {
      background: var(--line);
      border-color: var(--accent);
      transform: scale(1.03);
      box-shadow: 0 0 12px rgba(109, 211, 206, 0.1);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 7px;
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
      --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
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
      transition: all 0.2s var(--ease);
    }
    .btn {
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn:hover, .actor:hover {
      border-color: var(--accent);
      transform: scale(1.03);
      background: rgba(255,255,255,0.06);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn:focus-visible, .actor:focus-visible, .terminal-shell:focus-within {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 9px;
      border-color: var(--accent);
    }
    .btn.primary {
      background: var(--accent);
      color: #08242a;
      border-color: transparent;
      font-weight: 700;
    }
    .btn.primary:hover {
      box-shadow: 0 0 16px rgba(114, 214, 209, 0.3);
      background: #5bc4c0;
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
      transition: border-color 0.25s var(--ease), box-shadow 0.25s var(--ease);
    }
    .terminal-shell:focus-within {
      border-color: var(--accent);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(114, 214, 209, 0.12);
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
      transition: background 0.25s var(--ease);
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
      transition: border-color 0.2s var(--ease);
    }
    .shortcut-row code:hover {
      border-color: var(--accent);
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
      --ease: cubic-bezier(0.22, 0.61, 0.36, 1);
      font-family: ${MONO_FONT_STACK};
    }
    @keyframes connPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.5); }
      50% { box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); }
    }
    @keyframes shakeIn {
      0% { transform: translateY(-6px); opacity: 0; }
      60% { transform: translateY(2px); }
      100% { transform: translateY(0); opacity: 1; }
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
      text-decoration: none; display: inline-flex; align-items: center;
      transition: all 0.2s var(--ease);
    }
    .btn:hover {
      border-color: var(--accent);
      transform: scale(1.04);
      background: rgba(255,255,255,0.08);
    }
    .btn:active {
      transform: scale(0.96);
    }
    .btn:focus-visible, select.btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 7px;
    }
    select.btn {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 22px;
      background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5'><path d='M0 0l4 5 4-5z' fill='%2391a0b3'/></svg>");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    select.btn option {
      background: #161b22;
      color: #e6edf3;
    }
    .conn-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex-shrink: 0;
      animation: connPulse 2s ease-in-out infinite;
      transition: background 0.3s var(--ease);
    }
    .conn-dot.disconnected {
      background: #f85149;
      animation: none;
    }
    #terminal-container {
      flex: 1; min-height: 0; padding: 4px;
      transition: box-shadow 0.3s var(--ease);
    }
    #terminal-container:focus-within {
      box-shadow: inset 0 0 0 1px rgba(114, 214, 209, 0.18);
    }
    .status-bar {
      padding: 6px 16px; border-top: 1px solid var(--line); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
      background: #1f2630; color: #f5f7fa;
      transition: background 0.25s var(--ease), color 0.25s var(--ease);
    }
    .status-bar.user { background: var(--user); }
    .status-bar.codex { background: var(--codex); color: #1a140a; }
    .status-bar.claude { background: var(--claude); }
    .status-bar.session { background: #4b5563; }
    .status-bar.error { background: #f85149; animation: shakeIn 0.35s var(--ease); }
    .status-bar.locked { background: var(--locked); }
    .lock-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-left: 8px;
      transition: background 0.25s var(--ease), color 0.25s var(--ease);
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
