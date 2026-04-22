import {
  escapeHtml,
  sessionDisplayName,
  DEFAULT_VIEWER_REFRESH_MS,
} from '../server-state.js';
import { renderLegacyBrowserAttachScript } from './legacy-browser-script.js';
import { renderViewerDocument } from './page-shell.js';
import {
  formatViewerActivityMeta,
  resolveViewerBindingPageTarget,
  resolveViewerSessionPageTarget,
} from './page-targets.js';
import { LEGACY_BROWSER_PAGE_STYLES } from './page-styles.js';

export interface InteractiveAttachPageOptions {
  actor: string;
  attachPath: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}

// PREPARE_DEPRECATION: Legacy browser attach page based on HTTP polling + normalized text rendering.
// Keep it for compatibility with older links for now; preferred browser entrypoints are the xterm-based /terminal/* routes.
export function renderInteractiveAttachPage(options: InteractiveAttachPageOptions) {
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;
  const script = renderLegacyBrowserAttachScript({
    attachPath: options.attachPath,
    refreshMs,
  });

  return renderViewerDocument({
    title: `${options.title} • SSH Session MCP Viewer`,
    styles: LEGACY_BROWSER_PAGE_STYLES,
    body: `  <div class="header">
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

  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)} • Browser attach refresh: ${refreshMs}ms</footer>`,
    bodyExtras: `  <script>
${script}
  </script>`,
  });
}

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /session/* browser page.
export function renderViewerSessionPage(sessionRef: string) {
  const resolved = resolveViewerSessionPageTarget(sessionRef);
  if (resolved.ok === false) {
    return resolved.html;
  }
  const { target } = resolved;
  const { baseUrl, footerLabel, footerValue, sessionData } = target;

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/session/${encodeURIComponent(sessionRef)}`,
    baseUrl,
    footerLabel,
    footerValue,
    meta: formatViewerActivityMeta(sessionData),
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /binding/* browser page.
export function renderViewerBindingPage(bindingKey: string) {
  const resolved = resolveViewerBindingPageTarget(bindingKey);
  if (resolved.ok === false) {
    return resolved.html;
  }
  const { target } = resolved;
  const { baseUrl, footerLabel, footerValue, sessionData } = target;

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/binding/${encodeURIComponent(bindingKey)}`,
    baseUrl,
    footerLabel,
    footerValue,
    meta: formatViewerActivityMeta(sessionData, [`Binding: ${bindingKey}`]),
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}
