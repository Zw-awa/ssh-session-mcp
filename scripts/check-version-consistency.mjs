#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */


import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const serverJson = readJson('server.json');

const versions = [
  { label: 'package.json version', value: packageJson.version },
  { label: 'package-lock.json version', value: packageLock.version },
  { label: 'package-lock.json packages[\"\"] version', value: packageLock.packages?.['']?.version },
  { label: 'server.json version', value: serverJson.version },
  { label: 'server.json packages[0] version', value: serverJson.packages?.[0]?.version },
];

const expected = packageJson.version;
const mismatches = versions.filter(entry => entry.value !== expected);

if (mismatches.length > 0) {
  console.error('Version consistency check failed.');
  console.error(`Expected all versions to equal package.json version ${expected}.`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch.label}: ${mismatch.value}`);
  }
  process.exit(1);
}

console.log(`Version consistency check passed for ${expected}.`);
