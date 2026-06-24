/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

export { renderViewerErrorPage, type ViewerErrorPageOptions } from './viewer-html/error-page.js';
export { renderViewerHomePage } from './viewer-html/home-page.js';
export {
  renderInteractiveAttachPage,
  renderViewerBindingPage,
  renderViewerSessionPage,
  type InteractiveAttachPageOptions,
} from './viewer-html/legacy-browser-page.js';
export {
  renderXtermBindingPage,
  renderXtermSessionPage,
  renderXtermTerminalPage,
  type XtermTerminalPageOptions,
} from './viewer-html/xterm-page.js';
