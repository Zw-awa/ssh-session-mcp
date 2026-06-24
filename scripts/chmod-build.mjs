// SPDX-FileCopyrightText: 2026 Zw-awa
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const buildDir = fileURLToPath(new URL('../build/', import.meta.url));

for (const entry of readdirSync(buildDir)) {
  if (!entry.endsWith('.js')) {
    continue;
  }

  chmodSync(join(buildDir, entry), 0o755);
}
