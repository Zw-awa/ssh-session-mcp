import { escapeHtml } from '../server-state.js';

export interface ViewerDocumentOptions {
  body: string;
  bodyExtras?: string;
  headExtras?: string;
  styles: string;
  title: string;
}

export function renderViewerDocument(options: ViewerDocumentOptions) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzExMWMyZSIvPjx0ZXh0IHg9IjE2IiB5PSIyMyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIyMCIgZmlsbD0iIzZkZDNjZSI+Pl88L3RleHQ+PC9zdmc+">
  <title>${escapeHtml(options.title)}</title>
${options.headExtras ? `${options.headExtras}\n` : ''}  <style>
${options.styles}
  </style>
</head>
<body>
${options.body}
${options.bodyExtras ? `${options.bodyExtras}\n` : ''}</body>
</html>`;
}
