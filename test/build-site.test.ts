import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const scriptPath = join(ROOT, 'scripts', 'build-site.mjs');
const distDir = join(ROOT, 'dist');

function runBuild() {
  execFileSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: process.env,
    stdio: 'pipe',
  });
}

function readDistFile(name: string) {
  return readFileSync(join(distDir, name), 'utf8');
}

describe('build-site', () => {
  it('generates the static site and seo support files', () => {
    runBuild();

    const indexHtml = readDistFile('index.html');
    const notFoundHtml = readDistFile('404.html');
    const robotsTxt = readDistFile('robots.txt');
    const sitemapXml = readDistFile('sitemap.xml');

    expect(indexHtml).toContain('SSH Session MCP | Shared SSH MCP Server for Codex, Claude Code, and AI Agents');
    expect(indexHtml).toContain('meta name="keywords"');
    expect(indexHtml).toContain('application/ld+json');
    expect(indexHtml).toContain('data-lang-choice="zh-CN"');
    expect(indexHtml).toContain('How to use SSH Session MCP for shared AI + remote SSH work');
    expect(indexHtml).toContain('https://zw-awa.github.io/ssh-session-mcp/');
    expect(indexHtml).toContain('Gitee mirror for ssh-session-mcp');

    expect(notFoundHtml).toContain('noindex, nofollow');
    expect(notFoundHtml).toContain('Page not found');

    expect(robotsTxt).toContain('User-agent: *');
    expect(robotsTxt).toContain('Sitemap: https://zw-awa.github.io/ssh-session-mcp/sitemap.xml');

    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/</loc>');
    expect(sitemapXml).toContain('<changefreq>weekly</changefreq>');
  });

  it('copies required assets into dist', () => {
    runBuild();

    const logoPath = join(distDir, 'assets', 'logo-monogram-v1.png');
    const gifPath = join(distDir, 'assets', 'hero-loop.gif');

    expect(readFileSync(logoPath).byteLength).toBeGreaterThan(0);
    expect(readFileSync(gifPath).byteLength).toBeGreaterThan(0);
  });
});
