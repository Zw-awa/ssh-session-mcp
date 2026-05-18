#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function normalizeGitUrl(input = '') {
  return input
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/\.git$/i, '');
}

function ensureTrailingSlash(input = '') {
  return input.endsWith('/') ? input : input + '/';
}

function parseGitHubRepository(input = '') {
  const normalized = normalizeGitUrl(input);
  const match = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function normalizePagesSegment(input = '') {
  return input.trim().toLowerCase();
}

function escapeHtml(input = '') {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce(
    (html, [placeholder, value]) => html.replaceAll(placeholder, value),
    template,
  );
}

const repositoryUrl = normalizeGitUrl(pkg.repository?.url || pkg.homepage || '');
const repo = parseGitHubRepository(repositoryUrl);
const githubUrl = repositoryUrl;
const siteUrl = ensureTrailingSlash(
  repo
    ? `https://${normalizePagesSegment(repo.owner)}.github.io/${normalizePagesSegment(repo.repo)}`
    : repositoryUrl || 'https://zw-awa.github.io/ssh-session-mcp',
);
const npmUrl = `https://www.npmjs.com/package/${pkg.name}`;
const releasesUrl = githubUrl ? `${githubUrl}/releases` : '';
const issuesUrl = pkg.bugs?.url || (githubUrl ? `${githubUrl}/issues` : '');
const ogImageUrl = `${siteUrl}assets/logo-monogram-v1.png`;
const readmeUrl = githubUrl ? `${githubUrl}/blob/main/README.md` : '';
const readmeZhUrl = githubUrl ? `${githubUrl}/blob/main/README.zh-CN.md` : '';
const agentGuideUrl = githubUrl ? `${githubUrl}/blob/main/AGENT.md` : '';
const lastModified = new Date().toISOString().slice(0, 10);

const pageTitle = 'SSH Session MCP | Shared SSH MCP Server for Codex, Claude Code, and AI Agents';
const pageDescription = 'Install SSH Session MCP as a shared SSH MCP server with a persistent PTY, browser terminal viewer, input lock, and safer remote workflows for Codex, Claude Code, Cursor, and other AI agents.';
const pageTitleZh = 'SSH Session MCP | 面向 Codex、Claude Code 与 AI Agent 的共享 SSH MCP Server';
const pageDescriptionZh = '安装 SSH Session MCP，把 SSH 会话变成面向 Codex、Claude Code、Cursor 等 AI Agent 的共享 SSH MCP Server，提供持久 PTY、浏览器终端 viewer、输入锁和更稳的远程协作。';
const pageKeywords = [
  'ssh mcp',
  'mcp ssh server',
  'ssh session mcp',
  'ssh-session-mcp',
  'codex ssh mcp',
  'claude code ssh mcp',
  'browser ssh terminal',
  'shared pty',
  'ai ssh collaboration',
  'mcp ssh install',
  'shared ssh terminal',
  'embedded linux remote debugging',
].join(', ');

const siteMetadata = {
  en: {
    title: pageTitle,
    description: pageDescription,
    copyLabel: 'Copy',
    copiedLabel: 'Copied',
    failedLabel: 'Copy failed',
  },
  'zh-CN': {
    title: pageTitleZh,
    description: pageDescriptionZh,
    copyLabel: '复制',
    copiedLabel: '已复制',
    failedLabel: '复制失败',
  },
};

const softwareApplicationJson = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: pkg.name,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: ['Windows', 'macOS', 'Linux'],
  softwareVersion: pkg.version,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  url: siteUrl,
  downloadUrl: npmUrl,
  codeRepository: githubUrl,
  author: {
    '@type': 'Person',
    name: 'Zw-awa',
  },
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  inLanguage: ['en', 'zh-CN'],
  keywords: pageKeywords.split(', '),
  description: pageDescription,
  featureList: [
    'Persistent SSH PTY session shared by the user and the AI agent',
    'Browser terminal viewer for live inspection and manual takeover',
    'Input ownership tracking and session lock controls',
    'Async command tracking, diagnostics, and retry support',
    'Codex, Claude Code, Cursor, and other MCP client friendly install paths',
  ],
}, null, 2);

const webSiteJson = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'SSH Session MCP',
  url: siteUrl,
  description: pageDescription,
  inLanguage: ['en', 'zh-CN'],
  publisher: {
    '@type': 'Person',
    name: 'Zw-awa',
  },
}, null, 2);

const faqJson = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is SSH Session MCP?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'SSH Session MCP is a shared SSH MCP server that gives the user and the AI agent the same persistent PTY session, plus a browser terminal viewer, input locks, diagnostics, and async command tracking.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I install SSH Session MCP with Codex or Claude Code?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Use npx -y ssh-session-mcp --viewerPort=auto for the lightest install path, then register that command with Codex CLI, Claude Code, or another MCP client.',
      },
    },
    {
      '@type': 'Question',
      name: 'Why use a shared SSH terminal instead of a stateless shell wrapper?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'A shared SSH terminal keeps long-running commands, interactive prompts, and manual operator takeover visible in one PTY, instead of discarding session state after each command.',
      },
    },
  ],
}, null, 2);

const requiredCopies = [
  { from: join(SITE_ASSETS_DIR, 'hero-loop.gif'), to: join(DIST_ASSETS_DIR, 'hero-loop.gif') },
  { from: join(SITE_ASSETS_DIR, 'logo-monogram-v1.png'), to: join(DIST_ASSETS_DIR, 'logo-monogram-v1.png') },
  { from: join(SITE_ASSETS_DIR, 'logo-monogram-v1.svg'), to: join(DIST_ASSETS_DIR, 'logo-monogram-v1.svg') },
];

rmSync(DIST_DIR, { force: true, recursive: true });
mkdirSync(DIST_ASSETS_DIR, { recursive: true });

for (const copy of requiredCopies) {
  cpSync(copy.from, copy.to);
}

const template = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');

function renderPage({ is404 = false } = {}) {
  const pageAlert = is404
    ? [
      '<section class="notice-card" role="status">',
      '  <div data-lang="en" lang="en"><strong>Page not found.</strong> This URL does not map to a published landing page. Start from the homepage or open the repository.</div>',
      '  <div data-lang="zh-CN" lang="zh-CN"><strong>页面不存在。</strong> 这个 URL 没有对应的已发布落地页，请回到首页或打开仓库。</div>',
      '  <div class="cta-row" style="margin-top: 0.95rem;">',
      `    <a class="button button-secondary" href="${escapeHtml(siteUrl)}"><span data-lang="en" lang="en">Home</span><span data-lang="zh-CN" lang="zh-CN">首页</span></a>`,
      `    <a class="button button-tertiary" href="${escapeHtml(githubUrl)}"><span data-lang="en" lang="en">Repository</span><span data-lang="zh-CN" lang="zh-CN">仓库</span></a>`,
      '  </div>',
      '</section>',
    ].join('\n')
    : '';

  return renderTemplate(template, {
    '__PACKAGE_NAME__': escapeHtml(pkg.name),
    '__PACKAGE_VERSION__': escapeHtml(pkg.version),
    '__PACKAGE_DESCRIPTION__': escapeHtml(pkg.description),
    '__GITHUB_URL__': escapeHtml(githubUrl),
    '__NPM_URL__': escapeHtml(npmUrl),
    '__RELEASES_URL__': escapeHtml(releasesUrl),
    '__ISSUES_URL__': escapeHtml(issuesUrl),
    '__SITE_URL__': escapeHtml(siteUrl),
    '__OG_IMAGE_URL__': escapeHtml(ogImageUrl),
    '__README_URL__': escapeHtml(readmeUrl),
    '__README_ZH_URL__': escapeHtml(readmeZhUrl),
    '__AGENT_GUIDE_URL__': escapeHtml(agentGuideUrl),
    '__SITE_KEYWORDS__': escapeHtml(pageKeywords),
    '__PAGE_TITLE__': escapeHtml(is404 ? 'Page Not Found | SSH Session MCP' : pageTitle),
    '__PAGE_DESCRIPTION__': escapeHtml(is404 ? 'Page not found. Return to the SSH Session MCP landing page for install instructions, MCP usage, and shared SSH terminal resources.' : pageDescription),
    '__ROBOTS_CONTENT__': is404 ? 'noindex, nofollow' : 'index, follow',
    '__CANONICAL_TAG__': is404 ? '' : `<link rel="canonical" href="${escapeHtml(siteUrl)}">`,
    '__PAGE_URL__': escapeHtml(is404 ? `${siteUrl}404.html` : siteUrl),
    '__PAGE_ALERT__': pageAlert,
    '__SITE_METADATA_JSON__': JSON.stringify(siteMetadata),
    '__SOFTWARE_APPLICATION_JSON__': softwareApplicationJson,
    '__WEBSITE_JSON__': webSiteJson,
    '__FAQ_JSON__': faqJson,
  });
}

const robotsTxt = [
  'User-agent: *',
  'Allow: /',
  `Sitemap: ${siteUrl}sitemap.xml`,
  '',
].join('\n');

const sitemapXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url>',
  `    <loc>${siteUrl}</loc>`,
  `    <lastmod>${lastModified}</lastmod>`,
  '    <changefreq>weekly</changefreq>',
  '    <priority>1.0</priority>',
  '  </url>',
  '</urlset>',
  '',
].join('\n');

writeFileSync(join(DIST_DIR, 'index.html'), renderPage(), 'utf8');
writeFileSync(join(DIST_DIR, '404.html'), renderPage({ is404: true }), 'utf8');
writeFileSync(join(DIST_DIR, 'robots.txt'), robotsTxt, 'utf8');
writeFileSync(join(DIST_DIR, 'sitemap.xml'), sitemapXml, 'utf8');
