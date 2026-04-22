import {
  sessions,
  escapeHtml,
  sessionDisplayName,
  getViewerBaseUrl,
  buildViewerBindingKeyForSession,
  DEFAULT_VIEWER_REFRESH_MS,
} from '../server-state.js';
import { renderViewerDocument } from './page-shell.js';
import { HOME_PAGE_STYLES } from './page-styles.js';

export function renderViewerHomePage() {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

  const sessionCards = (() => {
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
  })();

  return renderViewerDocument({
    title: 'SSH Session MCP Viewer',
    styles: HOME_PAGE_STYLES,
    body: `  <header>
    <h1>SSH Session MCP Viewer</h1>
    <div class="subtitle">Real‑time SSH session monitoring</div>
  </header>

  <main>
    <div class="sessions">
      ${sessionCards}
    </div>
  </main>

  <footer>
    <div>SSH Session MCP • Auto‑refresh: ${refreshMs}ms</div>
    <div>Viewer base URL: <code>${escapeHtml(baseUrl)}</code></div>
  </footer>`,
    bodyExtras: `  <script>
    const refreshTimer = setTimeout(() => location.reload(), ${refreshMs});
    window.addEventListener('pagehide', () => clearTimeout(refreshTimer), { once: true });
  </script>`,
  });
}
