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
