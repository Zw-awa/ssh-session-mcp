#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  writeFileSync(join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const nextVersion = process.argv[2];

if (!nextVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error('Usage: node scripts/sync-version.mjs <semver>');
  process.exit(1);
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const serverJson = readJson('server.json');

packageJson.version = nextVersion;
packageLock.version = nextVersion;
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = nextVersion;
}
serverJson.version = nextVersion;
if (Array.isArray(serverJson.packages) && serverJson.packages[0]) {
  serverJson.packages[0].version = nextVersion;
}

writeJson('package.json', packageJson);
writeJson('package-lock.json', packageLock);
writeJson('server.json', serverJson);

console.log(`Synchronized package.json, package-lock.json, and server.json to ${nextVersion}.`);
