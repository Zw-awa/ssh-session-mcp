// SPDX-FileCopyrightText: 2026 Zw-awa
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function resolveVitestEntrypoint() {
  let packageJsonPath;

  try {
    packageJsonPath = require.resolve('vitest/package.json', { paths: [repoRoot] });
  } catch {
    return null;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binRelativePath = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.vitest;

  if (!binRelativePath) {
    return null;
  }

  const entrypoint = join(dirname(packageJsonPath), binRelativePath);
  return existsSync(entrypoint) ? entrypoint : null;
}

const vitestEntrypoint = resolveVitestEntrypoint();

if (!vitestEntrypoint) {
  console.error('未找到本地 vitest 入口。请先运行 `npm ci` 或 `npm install` 安装开发依赖。');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: repoRoot,
    env: {
      ...process.env,
      SSH_MCP_DISABLE_MAIN: '1',
    },
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
