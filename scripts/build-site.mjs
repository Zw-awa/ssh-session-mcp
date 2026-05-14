#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DIST_DIR = join(ROOT, 'dist');
const SITE_DIR = join(ROOT, 'site');
const SITE_ASSETS_DIR = join(SITE_DIR, 'assets');
const DIST_ASSETS_DIR = join(DIST_DIR, 'assets');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const githubUrl = pkg.homepage || pkg.repository?.url?.replace(/\.git$/, '') || '';
const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;
const releasesUrl = `${githubUrl}/releases`;
const issuesUrl = pkg.bugs?.url || `${githubUrl}/issues`;

const requiredCopies = [
  {
    from: join(SITE_ASSETS_DIR, 'hero-loop.gif'),
    to: join(DIST_ASSETS_DIR, 'hero-loop.gif'),
  },
];

rmSync(DIST_DIR, { force: true, recursive: true });
mkdirSync(DIST_ASSETS_DIR, { recursive: true });

for (const copy of requiredCopies) {
  cpSync(copy.from, copy.to);
}

const template = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
const html = template
  .replaceAll('__PACKAGE_NAME__', pkg.name)
  .replaceAll('__PACKAGE_VERSION__', pkg.version)
  .replaceAll('__PACKAGE_DESCRIPTION__', pkg.description)
  .replaceAll('__GITHUB_URL__', githubUrl)
  .replaceAll('__NPM_URL__', npmUrl)
  .replaceAll('__RELEASES_URL__', releasesUrl)
  .replaceAll('__ISSUES_URL__', issuesUrl);

writeFileSync(join(DIST_DIR, 'index.html'), html, 'utf8');
writeFileSync(join(DIST_DIR, '404.html'), html, 'utf8');
