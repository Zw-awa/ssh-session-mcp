/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OperationMode } from '../server-state.js';
import {
  renderXtermConnectionSection,
  renderXtermInputSection,
  renderXtermLifecycleSection,
  renderXtermSetupSection,
  renderXtermUiSection,
} from './xterm-script-sections.js';

export function renderXtermTerminalScript(options: {
  operationMode: OperationMode;
  wsPath: string;
}) {
  return [
    renderXtermSetupSection(options),
    renderXtermUiSection(),
    renderXtermConnectionSection(),
    renderXtermInputSection(),
    renderXtermLifecycleSection(),
  ].join('\n');
}
