import { escapeHtml } from '../server-state.js';
import { renderViewerDocument } from './page-shell.js';
import { ERROR_PAGE_STYLES } from './page-styles.js';

export interface ViewerErrorPageOptions {
  baseUrl: string;
  detail: string;
  footerLabel: string;
  footerValue: string;
  title: string;
}

export function renderViewerErrorPage(options: ViewerErrorPageOptions) {
  return renderViewerDocument({
    title: `${options.title} • SSH Session MCP Viewer`,
    styles: ERROR_PAGE_STYLES,
    body: `  <div class="header">SSH Session MCP Viewer</div>
  <div class="body">
    <div class="error">
      <div class="title">${escapeHtml(options.title)}</div>
      <div class="detail">${escapeHtml(options.detail)}</div>
      <a class="btn" href="${options.baseUrl}">Return to Home</a>
    </div>
  </div>
  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)}</footer>`,
  });
}
