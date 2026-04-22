import {
  escapeHtml,
  sessionDisplayName,
  OPERATION_MODE,
} from '../server-state.js';
import { renderXtermTerminalScript } from './xterm-script.js';
import { renderViewerDocument } from './page-shell.js';
import {
  formatViewerConnectionMeta,
  resolveViewerBindingPageTarget,
  resolveViewerSessionPageTarget,
} from './page-targets.js';
import { XTERM_PAGE_STYLES } from './page-styles.js';

export interface XtermTerminalPageOptions {
  attachKind: 'session' | 'binding';
  attachRef: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}

export function renderXtermTerminalPage(options: XtermTerminalPageOptions) {
  const wsPath = options.attachKind === 'binding'
    ? `/ws/attach/binding/${encodeURIComponent(options.attachRef)}`
    : `/ws/attach/session/${encodeURIComponent(options.attachRef)}`;
  const script = renderXtermTerminalScript({
    operationMode: OPERATION_MODE,
    wsPath,
  });

  return renderViewerDocument({
    title: `${options.title} • SSH Terminal`,
    styles: XTERM_PAGE_STYLES,
    headExtras: '  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">',
    body: `  <div class="header">
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
  <div class="status-bar" id="statusBar">Connecting...</div>`,
    bodyExtras: `  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
${script}
  </script>`,
  });
}

export function renderXtermSessionPage(sessionRef: string) {
  const resolved = resolveViewerSessionPageTarget(sessionRef);
  if (resolved.ok === false) {
    return resolved.html;
  }
  const { target } = resolved;
  const { baseUrl, footerLabel, footerValue, sessionData } = target;

  return renderXtermTerminalPage({
    attachKind: 'session',
    attachRef: sessionRef,
    baseUrl,
    footerLabel,
    footerValue,
    meta: formatViewerConnectionMeta(sessionData),
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}

export function renderXtermBindingPage(bindingKey: string) {
  const resolved = resolveViewerBindingPageTarget(bindingKey);
  if (resolved.ok === false) {
    return resolved.html;
  }
  const { target } = resolved;
  const { baseUrl, footerLabel, footerValue, sessionData } = target;

  return renderXtermTerminalPage({
    attachKind: 'binding',
    attachRef: bindingKey,
    baseUrl,
    footerLabel,
    footerValue,
    meta: formatViewerConnectionMeta(sessionData),
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}
