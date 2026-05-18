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

function toStructuredDataScripts(blocks) {
  return blocks
    .map((block) => `<script type="application/ld+json">\n${JSON.stringify(block, null, 2)}\n  </script>`)
    .join('\n  ');
}

function filePathFromRoute(route) {
  if (!route) return 'index.html';
  return join(...route.split('/').filter(Boolean), 'index.html');
}

function routeToUrl(route) {
  return ensureTrailingSlash(route ? `${siteUrl}${route}` : siteUrl);
}

function routeDepth(route) {
  return route ? route.split('/').filter(Boolean).length : 0;
}

function assetPath(route) {
  return '../'.repeat(routeDepth(route)) + 'assets/';
}

function relativeHref(fromRoute, toRoute) {
  const prefix = '../'.repeat(routeDepth(fromRoute));
  if (!toRoute) return prefix || './';
  return `${prefix}${toRoute}`;
}

function renderLangSpan(lang, text) {
  return `<span data-lang="${lang}">${text}</span>`;
}

function renderBilingual(en, zh) {
  return `${renderLangSpan('en', en)}${renderLangSpan('zh-CN', zh)}`;
}

function renderCodeCard(titleEn, titleZh, command) {
  return [
    '<div class="code-card">',
    '  <div class="code-head">',
    `    ${renderBilingual(titleEn, titleZh)}`,
    '    <button class="copy-button" data-copy="' + escapeHtml(command).replaceAll('\n', '&#10;') + '">' + renderBilingual('Copy', '复制') + '</button>',
    '  </div>',
    `  <pre><code>${escapeHtml(command)}</code></pre>`,
    '</div>',
  ].join('\n');
}

function pageHero({ eyebrowEn, eyebrowZh, titleEn, titleZh, ledeEn, ledeZh, ctas, stats, keywords, visualBarLeft, visualBarRight, visualImageAlt, visualNotes }, variant) {
  return [
    '<section class="page-hero">',
    '  <div>',
    `    <div class="eyebrow"><span class="dot"></span>${renderBilingual(eyebrowEn, eyebrowZh)}</div>`,
    `    <h1>${renderBilingual(titleEn, titleZh)}</h1>`,
    `    <p class="lede">${renderBilingual(ledeEn, ledeZh)}</p>`,
    ctas?.length
      ? [
          '    <div class="cta-row">',
          ...ctas.map((cta) => `      <a class="button ${cta.className}" href="${cta.href(variant)}">${renderBilingual(cta.en, cta.zh)}</a>`),
          '    </div>',
        ].join('\n')
      : '',
    stats?.length
      ? [
          '    <div class="stat-grid">',
          ...stats.map((stat) => [
            '      <div class="surface-card stack">',
            `        <div class="stat-label">${renderBilingual(stat.labelEn, stat.labelZh)}</div>`,
            `        <div class="stat-value">${renderBilingual(stat.valueEn, stat.valueZh)}</div>`,
            '      </div>',
          ].join('\n')),
          '    </div>',
        ].join('\n')
      : '',
    keywords?.length
      ? ['    <div class="keyword-strip">', ...keywords.map((keyword) => `      <span class="keyword-pill">${escapeHtml(keyword)}</span>`), '    </div>'].join('\n')
      : '',
    '  </div>',
    '  <aside class="visual-panel">',
    `    <div class="visual-bar"><span>${escapeHtml(visualBarLeft)}</span><span>${escapeHtml(visualBarRight)}</span></div>`,
    `    <img class="visual-media" src="${variant.assetBase}hero-loop.gif" alt="${escapeHtml(visualImageAlt)}">`,
    '    <div class="visual-note-grid">',
    ...visualNotes.map((note) => `      <div class="visual-note">${renderBilingual(note.en, note.zh)}</div>`),
    '    </div>',
    '  </aside>',
    '</section>',
  ].filter(Boolean).join('\n');
}

function renderSection({ kickerEn, kickerZh, titleEn, titleZh, copyEn, copyZh, body }) {
  return [
    '<section class="section-block">',
    '  <div class="section-head">',
    `    <div class="section-kicker">${renderBilingual(kickerEn, kickerZh)}</div>`,
    `    <h2 class="section-title">${renderBilingual(titleEn, titleZh)}</h2>`,
    copyEn || copyZh ? `    <p class="section-copy">${renderBilingual(copyEn, copyZh)}</p>` : '',
    '  </div>',
    body,
    '</section>',
  ].filter(Boolean).join('\n');
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
const giteeUrl = 'https://gitee.com/Zw-awa/ssh-session-mcp';
const devtoUrl = 'https://dev.to/zwawa/i-got-tired-of-splitting-my-brain-between-local-ai-and-remote-ssh-so-i-built-ssh-session-mcp-d0e';
const csdnUrl = 'https://blog.csdn.net/XW_mmQAQ/article/details/160383144';
const juejinUrl = 'https://juejin.cn/post/7631182856620212264';
const oschinaUrl = 'https://my.oschina.net/u/9755759/blog/19588988';
const registryUrl = `${githubUrl}/blob/main/server.json`;
const ogImageUrl = `${siteUrl}assets/logo-monogram-v1.png`;
const heroImageUrl = `${siteUrl}assets/hero-loop.gif`;
const readmeUrl = githubUrl ? `${githubUrl}/blob/main/README.md` : '';
const readmeZhUrl = githubUrl ? `${githubUrl}/blob/main/README.zh-CN.md` : '';
const agentGuideUrl = githubUrl ? `${githubUrl}/blob/main/AGENT.md` : '';
const llmsInstallUrl = githubUrl ? `${githubUrl}/blob/main/llms-install.md` : '';
const lastModified = new Date().toISOString().slice(0, 10);

const commonKeywords = [
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
];

const navigation = [
  { slug: 'home', baseRoute: '', en: 'Overview', zh: '总览' },
  { slug: 'install', baseRoute: 'install/', en: 'Install', zh: '安装' },
  { slug: 'commands', baseRoute: 'commands/', en: 'Commands', zh: '命令' },
  { slug: 'resources', baseRoute: 'resources/', en: 'Resources', zh: '资源' },
  { slug: 'faq', baseRoute: 'faq/', en: 'FAQ', zh: '问答' },
  { slug: 'use-cases', baseRoute: 'use-cases/', en: 'Use Cases', zh: '场景' },
  { slug: 'compare', baseRoute: 'compare/', en: 'Compare', zh: '对比' },
];

const baseStructuredData = {
  website: {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'SSH Session MCP',
    url: siteUrl,
    description: 'Shared SSH MCP server with viewer, input lock, async tracking, and policy-aware terminal workflows.',
    inLanguage: ['en', 'zh-CN'],
    publisher: {
      '@type': 'Person',
      name: 'Zw-awa',
    },
  },
  softwareApplication: {
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
    keywords: commonKeywords,
    description: 'Persistent shared SSH PTY runtime for MCP clients with a browser terminal viewer and operator-aware controls.',
    featureList: [
      'Persistent SSH PTY session shared by the user and the AI agent',
      'Browser terminal viewer for live inspection and manual takeover',
      'Input ownership tracking and session lock controls',
      'Async command tracking, diagnostics, and retry support',
      'Codex, Claude Code, Cursor, Cline, and OpenCode friendly install paths',
    ],
  },
};

const pageDefs = [
  {
    slug: 'home',
    baseRoute: '',
    className: 'page-home',
    titleEn: 'SSH Session MCP | Shared SSH MCP Server for Codex, Claude Code, and AI Agents',
    titleZh: 'SSH Session MCP | 面向 Codex、Claude Code 与 AI Agent 的共享 SSH MCP Server',
    descriptionEn: 'Install SSH Session MCP as a shared SSH MCP server with a persistent PTY, browser terminal viewer, input lock, and safer remote workflows for Codex, Claude Code, Cursor, OpenCode, and Cline.',
    descriptionZh: '安装 SSH Session MCP，把 SSH 会话变成面向 Codex、Claude Code、Cursor、OpenCode、Cline 的共享 SSH MCP Server，提供持久 PTY、浏览器终端 viewer、输入锁和更稳的远程协作。',
    keywords: [...commonKeywords, 'cline ssh mcp', 'opencode ssh mcp'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.softwareApplication, url: variant.absoluteUrl, description: variant.descriptionEn, inLanguage: [variant.lang] },
        { ...baseStructuredData.website },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Shared PTY for human and agent',
        eyebrowZh: '面向人类与 Agent 的共享 PTY',
        titleEn: 'SSH MCP server with a real shared terminal.',
        titleZh: '把 SSH 变成真正可共享的 MCP 终端。',
        ledeEn: '`ssh-session-mcp` is a shared SSH MCP server for Codex, Claude Code, Cursor, OpenCode, Cline, and other AI agents. It keeps one persistent PTY alive, adds a browser terminal viewer, tracks who typed what, and makes remote install, debugging, and long-running work safer to operate.',
        ledeZh: '`ssh-session-mcp` 是面向 Codex、Claude Code、Cursor、OpenCode、Cline 等 AI Agent 的共享 SSH MCP Server。它保留一条持久 PTY，会附带浏览器终端 viewer、输入来源跟踪和会话级状态管理，让远程安装、调试和长任务执行更可控。',
        ctas: [
          { className: 'button-primary', href: (v) => relativeHref(v.route, v.lookup.install.route), en: 'Open Install Guide', zh: '查看安装指南' },
          { className: 'button-secondary', href: () => npmUrl, en: 'Install from npm', zh: '从 npm 安装' },
          { className: 'button-tertiary', href: (v) => relativeHref(v.route, v.lookup.resources.route), en: 'Browse Resources', zh: '查看资源页' },
        ],
        stats: [
          { labelEn: 'Best For', labelZh: '最适合', valueEn: 'MCP + SSH install and usage, AI-assisted remote terminals, embedded Linux boards, deployment hosts, and remote debugging.', valueZh: 'MCP + SSH 安装与使用、AI 辅助远程终端、嵌入式 Linux 板卡、部署机与远程调试。' },
          { labelEn: 'Core Promise', labelZh: '核心能力', valueEn: 'Shared PTY, browser terminal, input lock, async command tracking, diagnostics, and safe/full execution modes.', valueZh: '共享 PTY、浏览器终端、输入锁、异步命令跟踪、诊断信息，以及 safe/full 执行模式。' },
          { labelEn: 'Fastest Demo', labelZh: '最快演示', valueEn: '<code>ssh-session-mcp-ctl launch --local --viewerPort=auto</code>', valueZh: '<code>ssh-session-mcp-ctl launch --local --viewerPort=auto</code>' },
        ],
        keywords: ['ssh mcp', 'mcp ssh server', 'codex ssh mcp', 'claude code ssh mcp', 'shared pty', 'browser ssh terminal'],
        visualBarLeft: 'market-demo / browser viewer / localhost',
        visualBarRight: 'safe mode',
        visualImageAlt: 'Animated shared terminal demo',
        visualNotes: [
          { en: 'Install once, then let the MCP client reuse the same SSH session instead of spawning a stateless shell for every command.', zh: '安装后即可让 MCP client 复用同一条 SSH 会话，而不是每次命令都重新起一个无状态 shell。' },
          { en: 'Useful for Codex, Claude Code, Cursor, OpenCode, Cline, and operators who still need manual takeover when the remote shell gets strange.', zh: '适合 Codex、Claude Code、Cursor、OpenCode、Cline，也适合需要在远端 shell 异常时随时人工接管的操作者。' },
        ],
      }, variant);

      const landingGrid = [
        '<div class="grid three-up">',
        [
          ['Why It Matters', '为什么值得看', 'Most SSH MCP tools run commands, but do not preserve the terminal as a shared runtime.', '很多 SSH MCP 工具能执行命令，但保不住“共享终端运行时”。', 'When installation prompts, long-running deploys, or remote debugging sessions depend on one real PTY, a stateless wrapper forces the user and the AI to guess. This project keeps both sides on the same terminal state.', '当安装提示、长时间部署、远程调试依赖一条真实 PTY 时，无状态包装层会迫使用户和 AI 靠猜。这个项目的目标就是让双方看到同一份终端状态。', ['shared PTY', 'browser terminal', 'remote debugging']],
          ['What It Adds', '它补上了什么', 'A practical SSH MCP server for real operator + AI collaboration.', '一个真正面向“操作者 + AI 协作”的 SSH MCP Server。', 'State-aware command handling, safe/full modes, input lock, session history, async polling, viewer diagnostics, and a local demo path that explains the product without touching a real SSH target.', '它提供状态感知的命令处理、safe/full 模式、输入锁、会话历史、异步轮询、viewer 诊断，以及无需真实 SSH 目标的本地演示路径。', ['safe/full mode', 'async status', 'session history']],
          ['Where To Go Next', '下一步看哪里', 'Each page helps with a different kind of question.', '不同页面分别解决不同的问题。', 'Start here for the overview, then jump to install, resources, FAQ, or use cases when you want the next layer of detail.', '先在这里看总览；如果你接下来想看安装、资源、问答或使用场景，再继续往下跳转。', ['install guide', 'resources', 'FAQ']],
        ].map(([kEn, kZh, tEn, tZh, pEn, pZh, chips]) => [
          '<article class="surface-card stack">',
          `  <div class="section-kicker">${renderBilingual(kEn, kZh)}</div>`,
          `  <h3>${renderBilingual(tEn, tZh)}</h3>`,
          `  <p>${renderBilingual(pEn, pZh)}</p>`,
          `  <div class="chip-row">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>`,
          '</article>',
        ].join('\n')).join('\n'),
        '</div>',
      ].join('\n');

      const paths = renderSection({
        kickerEn: 'Start Here',
        kickerZh: '从这里继续',
        titleEn: 'Pick the page that matches what you need right now.',
        titleZh: '按你现在要解决的问题继续往下看。',
        copyEn: 'Some people want setup steps, some want links, and some want examples. These pages keep each path easier to browse.',
        copyZh: '有人要安装步骤，有人要官方链接，也有人想看使用例子。把它们拆开以后，会更容易浏览。',
        body: [
          '<div class="grid four-up">',
          [
            { key: 'install', labelEn: 'Install', labelZh: '安装', titleEn: 'MCP + SSH install guide', titleZh: 'MCP + SSH 安装指南', copyEn: 'Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows notes.', copyZh: '覆盖 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 注意事项。' },
            { key: 'resources', labelEn: 'Resources', labelZh: '资源', titleEn: 'Official links and article index', titleZh: '官方链接与文章索引', copyEn: 'One place for the package, source, registry info, mirrors, and articles.', copyZh: '把包地址、源码、registry 信息、镜像和文章放到一个地方。' },
            { key: 'faq', labelEn: 'FAQ', labelZh: '问答', titleEn: 'Install and runtime questions', titleZh: '安装与运行时问答', copyEn: 'Direct answers to the questions people usually ask before or after setup.', copyZh: '把安装前后最常见的问题集中回答清楚。' },
            { key: 'use-cases', labelEn: 'Use Cases', labelZh: '场景', titleEn: 'Why shared PTY matters', titleZh: '为什么共享 PTY 值得要', copyEn: 'Break down viewer, lock, async tracking, and policy rules by scenario instead of listing features flatly.', copyZh: '按场景解释 viewer、输入锁、异步跟踪和策略规则的价值，而不是平铺功能名。' },
          ].map((item) => [
            `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup[item.key].route)}">`,
            `  <div class="path-label">${renderBilingual(item.labelEn, item.labelZh)}</div>`,
            `  <div class="path-title">${renderBilingual(item.titleEn, item.titleZh)}</div>`,
            `  <div class="path-copy">${renderBilingual(item.copyEn, item.copyZh)}</div>`,
            '</a>',
          ].join('\n')).join('\n'),
          '</div>',
        ].join('\n'),
      });

      const internalLinks = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'Not sure where to go next?',
        titleZh: '还不确定下一步看哪里？',
        copyEn: 'Go to install for setup, resources for links, FAQ for answers, and use cases for examples.',
        copyZh: '安装页看接入，资源页看链接，FAQ 看答案，场景页看例子。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><h3>${renderBilingual('If you need install commands, start with the install guide.', '如果你需要安装命令，先去安装页。')}</h3><p>${renderBilingual('That page keeps Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows setup in one place.', '那一页把 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 的接入方式都放在一起。')}</p><div class="chip-row"><a class="button button-secondary" href="${relativeHref(variant.route, variant.lookup.install.route)}">${renderBilingual('Open Install Guide', '查看安装指南')}</a></div></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('If you want links, mirrors, or articles, open the resources page.', '如果你需要链接、镜像或文章，去资源页。')}</h3><p>${renderBilingual('It gathers the package, source, registry metadata, mirrors, and writeups in one place.', '它把包地址、源码、registry 信息、镜像和文章都集中在一个地方。')}</p><div class="chip-row"><a class="button button-secondary" href="${relativeHref(variant.route, variant.lookup.resources.route)}">${renderBilingual('Open Resources', '查看资源页')}</a></div></article>`,
          '</div>',
        ].join('\n'),
      });

      return [hero, landingGrid, paths, internalLinks].join('\n');
    },
  },
  {
    slug: 'install',
    baseRoute: 'install/',
    className: 'page-install',
    titleEn: 'SSH Session MCP Install Guide | Codex, Claude Code, Cline, OpenCode, npm, Docker',
    titleZh: 'SSH Session MCP 安装指南 | Codex、Claude Code、Cline、OpenCode、npm、Docker',
    descriptionEn: 'Install SSH Session MCP for Codex, Claude Code, Cline, OpenCode, or manual npm and Docker workflows, with Windows notes and search-focused MCP + SSH setup instructions.',
    descriptionZh: '为 Codex、Claude Code、Cline、OpenCode，或手动 npm 与 Docker 流程安装 SSH Session MCP，并附带 Windows 注意事项和面向 MCP + SSH 的接入说明。',
    keywords: [...commonKeywords, 'cline mcp ssh', 'opencode mcp ssh', 'docker ssh mcp', 'windows mcp ssh'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.softwareApplication, url: variant.absoluteUrl, description: variant.descriptionEn, inLanguage: [variant.lang] },
        {
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: variant.lang === 'en' ? 'Install SSH Session MCP for MCP clients' : '为 MCP 客户端安装 SSH Session MCP',
          url: variant.absoluteUrl,
          description: variant.descriptionEn,
          step: [
            { '@type': 'HowToStep', name: 'Choose npx or Docker', text: 'Prefer npx -y ssh-session-mcp --viewerPort=auto unless the user explicitly wants Docker.' },
            { '@type': 'HowToStep', name: 'Register the server command', text: 'Add the command to Codex, Claude Code, Cline, or OpenCode using the client-specific install flow.' },
            { '@type': 'HowToStep', name: 'Verify the viewer', text: 'Use --viewerPort=auto or a fixed published port so the browser terminal can be reached.' },
          ],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: [variant.lang],
          mainEntity: [
            {
              '@type': 'Question',
              name: 'How do I add SSH Session MCP to Codex CLI?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto for the lowest-friction setup path.',
              },
            },
            {
              '@type': 'Question',
              name: 'How do I install SSH Session MCP for Claude Code on Windows?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto when native Windows stdio launch needs the cmd /c fallback.',
              },
            },
            {
              '@type': 'Question',
              name: 'Should I use Docker or npx for SSH Session MCP?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use npx -y ssh-session-mcp --viewerPort=auto by default. Switch to Docker only when you need a pinned runtime, image-based distribution, or a fixed published viewer port.',
              },
            },
            {
              '@type': 'Question',
              name: 'What is the fastest no-SSH demo path?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use ssh-session-mcp-ctl launch --local --viewerPort=auto to demo the viewer and shared runtime model without a real SSH target.',
              },
            },
          ],
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Install Guide',
        eyebrowZh: '安装指南',
        titleEn: 'Install SSH Session MCP for the MCP client you already use.',
        titleZh: '给你已经在用的 MCP client 安装 SSH Session MCP。',
        ledeEn: 'This page puts setup first: Cline, Claude Code, Codex, OpenCode, `npx -y ssh-session-mcp`, Docker, and Windows notes all live here.',
        ledeZh: '这个页面把安装放在第一位：Cline、Claude Code、Codex、OpenCode、`npx -y ssh-session-mcp`、Docker 和 Windows 注意事项都集中在这里。',
        ctas: [
          { className: 'button-primary', href: () => npmUrl, en: 'Open npm Package', zh: '打开 npm 包页' },
          { className: 'button-secondary', href: () => llmsInstallUrl, en: 'Open llms-install.md', zh: '打开 llms-install.md' },
          { className: 'button-tertiary', href: () => githubUrl, en: 'Repository', zh: '仓库' },
        ],
        stats: [
          { labelEn: 'Primary Command', labelZh: '主命令', valueEn: '<code>npx -y ssh-session-mcp --viewerPort=auto</code>', valueZh: '<code>npx -y ssh-session-mcp --viewerPort=auto</code>' },
          { labelEn: 'Windows Variant', labelZh: 'Windows 变体', valueEn: '<code>cmd /c npx -y ssh-session-mcp --viewerPort=auto</code>', valueZh: '<code>cmd /c npx -y ssh-session-mcp --viewerPort=auto</code>' },
          { labelEn: 'Docker Path', labelZh: 'Docker 路径', valueEn: 'For pinned runtime, fixed port publishing, or image-first distribution.', valueZh: '适合固定运行时、固定端口发布或镜像优先分发。' },
        ],
        keywords: ['mcp ssh install', 'codex ssh mcp', 'claude code ssh mcp', 'shared ssh mcp', 'npx ssh-session-mcp', 'docker ssh mcp'],
        visualBarLeft: 'install / stdio / marketplace-ready',
        visualBarRight: 'npx first',
        visualImageAlt: 'Animated shared terminal install demo',
        visualNotes: [
          { en: 'Preferred install path: `npx -y ssh-session-mcp --viewerPort=auto`.', zh: '首选安装路径：`npx -y ssh-session-mcp --viewerPort=auto`。' },
          { en: 'Use Docker only when the user explicitly wants a containerized runtime or a pinned image.', zh: '只有在用户明确想要容器化运行时或固定镜像时，再走 Docker。' },
        ],
      }, variant);

      const clientCards = renderSection({
        kickerEn: 'Client-Specific Setup',
        kickerZh: '按客户端安装',
        titleEn: 'Use the command shape that matches the MCP client.',
        titleZh: '按 MCP client 使用对应的命令形状。',
        copyEn: 'Use the command shape that matches the client you already have open.',
        copyZh: '直接选和你当前 MCP client 对应的那条命令就行。',
        body: [
          '<div class="code-grid two-up">',
          renderCodeCard('Cline / Roo JSON config', 'Cline / Roo JSON 配置', `{\n  "mcpServers": {\n    "ssh-session-mcp": {\n      "command": "npx",\n      "args": ["-y", "ssh-session-mcp", "--viewerPort=auto"],\n      "disabled": false,\n      "autoApprove": []\n    }\n  }\n}`),
          renderCodeCard('Claude Code', 'Claude Code', 'claude mcp add --transport stdio ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto'),
          renderCodeCard('Codex CLI', 'Codex CLI', 'codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto'),
          renderCodeCard('OpenCode local command', 'OpenCode 本地命令', 'npx -y ssh-session-mcp --viewerPort=auto'),
          '</div>',
        ].join('\n'),
      });

      const installPaths = renderSection({
        kickerEn: 'Install Paths',
        kickerZh: '安装路径',
        titleEn: 'Pick the lightest path that matches the operator and environment.',
        titleZh: '按操作者和环境选择最轻的路径。',
        copyEn: 'This page keeps the setup paths explicit so you can copy the right one quickly.',
        copyZh: '这里把安装路径写得很直接，方便你快速复制正确的那一条。',
        body: [
          '<div class="code-grid three-up">',
          renderCodeCard('npx install', 'npx 安装', 'npx -y ssh-session-mcp --viewerPort=auto'),
          renderCodeCard('Global npm install', '全局 npm 安装', 'npm install -g ssh-session-mcp\nssh-session-mcp --viewerPort=auto'),
          renderCodeCard('Docker install', 'Docker 安装', 'docker run --rm -i -p 8793:8793 -e VIEWER_PORT=8793 -e VIEWER_HOST=0.0.0.0 docker.io/zwawa/ssh-session-mcp:latest'),
          '</div>',
          `<div class="note-banner" style="margin-top: 0.9rem;">${renderBilingual('Use `--viewerPort=auto` for local installs so the browser viewer is available without hand-picking a port. Use a fixed published port in Docker when you need predictable host mapping.', '本地安装优先使用 `--viewerPort=auto`，这样浏览器 viewer 不需要手工选端口。Docker 场景如果需要稳定宿主机映射，就用固定端口。')}</div>`,
        ].join('\n'),
      });

      const windowsAndRuntime = renderSection({
        kickerEn: 'Windows And Runtime Notes',
        kickerZh: 'Windows 与运行时说明',
        titleEn: 'Windows users should treat `cmd /c npx` as the safe fallback for stdio launchers.',
        titleZh: 'Windows 用户在 stdio 启动器里，应把 `cmd /c npx` 当成稳妥回退方案。',
        copyEn: 'If Windows stdio launch feels flaky, keep the `cmd /c` fallback in mind.',
        copyZh: '如果 Windows 上的 stdio 拉起不稳定，记住 `cmd /c` 这个回退方案就够了。',
        body: [
          '<div class="grid two-up">',
          [
            ['Windows fallback', 'Windows 回退命令', 'Use this when a client fails to spawn `npx` directly as a stdio command.', '当客户端不能直接把 `npx` 作为 stdio 命令拉起时，用这个回退。', 'cmd /c npx -y ssh-session-mcp --viewerPort=auto'],
            ['Runtime config', '运行时配置', 'Use `.env` for one target and `ssh-session-mcp.config.json` for multi-device setups. Keep secrets in environment variables.', '单目标用 `.env`，多设备用 `ssh-session-mcp.config.json`，secret 保持在环境变量里。', 'SSH_MCP_CONFIG=/path/to/ssh-session-mcp.config.json'],
          ].map(([titleEn, titleZh, copyEn, copyZh, code]) => [
            '<article class="surface-card stack">',
            `  <h3>${renderBilingual(titleEn, titleZh)}</h3>`,
            `  <p>${renderBilingual(copyEn, copyZh)}</p>`,
            `  <pre><code>${escapeHtml(code)}</code></pre>`,
            '</article>',
          ].join('\n')).join('\n'),
          '</div>',
        ].join('\n'),
      });

      const longTailFaq = renderSection({
        kickerEn: 'Setup Questions',
        kickerZh: '安装问题',
        titleEn: 'Short answers for the setup details people ask most.',
        titleZh: '把大家最常问的安装细节快速答清楚。',
        copyEn: 'Use these when you already know you want the project and just need the exact setup path.',
        copyZh: '如果你已经确定要用它，只差一条准确的安装路径，就从这里看。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><h3>${renderBilingual('How do I add SSH Session MCP to Codex CLI?', '怎么把 SSH Session MCP 加到 Codex CLI？')}</h3><p>${renderBilingual('Use `codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto` if you want the lowest-friction install path.', '如果你要最低摩擦的接入路径，就用 `codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto`。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('How do I install it for Claude Code on Windows?', '怎么在 Windows 上给 Claude Code 安装？')}</h3><p>${renderBilingual('Use `claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto` when native Windows stdio launch needs the `cmd /c` fallback.', '当原生 Windows 的 stdio 拉起需要 `cmd /c` 回退时，使用 `claude mcp add --transport stdio ssh-session-mcp -- cmd /c npx -y ssh-session-mcp --viewerPort=auto`。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Should I use Docker or npx for SSH Session MCP?', 'SSH Session MCP 应该用 Docker 还是 npx？')}</h3><p>${renderBilingual('Use `npx -y ssh-session-mcp --viewerPort=auto` by default. Switch to Docker only when you need a pinned runtime, image-based distribution, or a fixed published viewer port.', '默认优先用 `npx -y ssh-session-mcp --viewerPort=auto`。只有在你需要固定运行时、镜像分发或固定的 viewer 映射端口时，再切到 Docker。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('What is the fastest no-SSH demo path?', '最快的无 SSH 演示路径是什么？')}</h3><p>${renderBilingual('Use `ssh-session-mcp-ctl launch --local --viewerPort=auto` to demo the browser viewer and shared runtime model without touching a real SSH target.', '用 `ssh-session-mcp-ctl launch --local --viewerPort=auto`，在不接触真实 SSH 目标的情况下演示浏览器 viewer 和共享运行时模型。')}</p></article>`,
          '</div>',
        ].join('\n'),
      });

      const internalLinks = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'After setup, you will probably want one of these.',
        titleZh: '装好以后，下一步大多会看这几页。',
        copyEn: 'Most people next want the official links, a quick answer, or a few real examples.',
        copyZh: '大多数人接下来会去看官方链接、直接答案，或者几个实际例子。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.resources.route)}"><div class="path-label">${renderBilingual('Resources', '资源')}</div><div class="path-title">${renderBilingual('Official links, registry details, and articles', '官方链接、registry 信息和相关文章')}</div><div class="path-copy">${renderBilingual('Use this when you want the main links gathered in one place.', '如果你想把主要链接一次性看全，去这里。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.faq.route)}"><div class="path-label">${renderBilingual('FAQ', '问答')}</div><div class="path-title">${renderBilingual('Common setup and runtime answers', '常见安装与运行时问题')}</div><div class="path-copy">${renderBilingual('Use this when setup naturally turns into trust or behavior questions.', '如果安装过程中自然冒出了信任或行为问题，就去这里。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup['use-cases'].route)}"><div class="path-label">${renderBilingual('Use Cases', '场景')}</div><div class="path-title">${renderBilingual('See where shared PTY and viewer help most', '看看 shared PTY 和 viewer 最适合用在哪些地方')}</div><div class="path-copy">${renderBilingual('Use this if you already know how to install and want to see when the shared runtime becomes useful.', '如果你已经知道怎么装，接下来想看这个共享运行时在什么场景里真正有用，就去这里。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">install</span></div>`,
        hero,
        clientCards,
        installPaths,
        windowsAndRuntime,
        longTailFaq,
        internalLinks,
      ].join('\n');
    },
  },
  {
    slug: 'commands',
    baseRoute: 'commands/',
    className: 'page-commands',
    titleEn: 'SSH Session MCP Commands | MCP Tools, CLI Commands, and Recommended Flows',
    titleZh: 'SSH Session MCP 命令页 | MCP 工具、CLI 命令与推荐流程',
    descriptionEn: 'Browse SSH Session MCP commands and tools: ssh-quick-connect, ssh-run, ssh-status, ssh-command-status, ssh-session-diagnostics, ssh-retry, ssh-device-list, and ssh-session-mcp-ctl operator commands.',
    descriptionZh: '查看 SSH Session MCP 的命令与工具：ssh-quick-connect、ssh-run、ssh-status、ssh-command-status、ssh-session-diagnostics、ssh-retry、ssh-device-list，以及 ssh-session-mcp-ctl 操作命令。',
    keywords: [...commonKeywords, 'ssh-session-mcp commands', 'ssh-run', 'ssh-quick-connect', 'ssh-session-mcp-ctl', 'ssh-device-list'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.softwareApplication, url: variant.absoluteUrl, description: variant.descriptionEn, inLanguage: [variant.lang] },
        {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: variant.lang === 'zh-CN' ? 'SSH Session MCP 命令页' : 'SSH Session MCP commands',
          url: variant.absoluteUrl,
          description: variant.descriptionEn,
          inLanguage: [variant.lang],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: [variant.lang],
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What does ssh-quick-connect do?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'ssh-quick-connect opens or reuses the common SSH session and can also launch the viewer, so it is the recommended first step before ssh-run.',
              },
            },
            {
              '@type': 'Question',
              name: 'When should I use ssh-command-status?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use ssh-command-status when ssh-run returns an async command ID or when long-running remote work should be polled explicitly instead of guessed.',
              },
            },
            {
              '@type': 'Question',
              name: 'What is ssh-session-diagnostics for?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'ssh-session-diagnostics inspects lock state, warnings, running command state, and viewer health when the terminal is blocked, odd, or stateful.',
              },
            },
            {
              '@type': 'Question',
              name: 'When do I use ssh-session-mcp-ctl instead of MCP tools?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use ssh-session-mcp-ctl when acting as the local operator and you need process status, device listing, launch, logs, or cleanup outside the MCP tool loop.',
              },
            },
          ],
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Commands',
        eyebrowZh: '命令',
        titleEn: 'One page for MCP tool names, CLI commands, and the normal command flow.',
        titleZh: '把 MCP 工具名、CLI 命令和正常工作流放到一个页面里。',
        ledeEn: 'If you remember a command name but not what it does, this page is the fastest way back to the full picture. It keeps the common MCP tools and operator commands together in one place.',
        ledeZh: '如果你记得一个命令名，却忘了它是做什么的、应该什么时候用，这个页面会是最快的回到上下文的地方。',
        ctas: [
          { className: 'button-primary', href: (v) => relativeHref(v.route, v.lookup.install.route), en: 'Install Guide', zh: '安装指南' },
          { className: 'button-secondary', href: () => llmsInstallUrl, en: 'Open llms-install.md', zh: '打开 llms-install.md' },
          { className: 'button-tertiary', href: () => agentGuideUrl, en: 'Open AGENT.md', zh: '打开 AGENT.md' },
        ],
        stats: [
          { labelEn: 'Agent Flow', labelZh: 'Agent 流程', valueEn: '<code>ssh-device-list -> ssh-quick-connect -> ssh-run -> ssh-command-status</code>', valueZh: '<code>ssh-device-list -> ssh-quick-connect -> ssh-run -> ssh-command-status</code>' },
          { labelEn: 'Operator CLI', labelZh: '操作者 CLI', valueEn: '<code>ssh-session-mcp-ctl status / devices / launch / logs / cleanup</code>', valueZh: '<code>ssh-session-mcp-ctl status / devices / launch / logs / cleanup</code>' },
          { labelEn: 'Best For', labelZh: '适合', valueEn: 'Remembering a tool name but not the exact workflow around it.', valueZh: '记得工具名，但忘了它在整条流程里该怎么用。' },
        ],
        keywords: ['ssh-run', 'ssh-quick-connect', 'ssh-status', 'ssh-command-status', 'ssh-session-mcp-ctl', 'ssh-device-list'],
        visualBarLeft: 'commands / tools / operator flow',
        visualBarRight: 'quick lookup',
        visualImageAlt: 'Animated shared terminal command demo',
        visualNotes: [
          { en: 'If a command name looks familiar but the surrounding workflow is fuzzy, start here.', zh: '如果某个命令名看着眼熟，但你一时想不起它在整条流程里怎么用，就从这里开始。' },
          { en: 'Use this page as a quick map, then jump out once the command makes sense again.', zh: '先把命令和上下文重新对上，然后再继续跳到你真正需要的页面。' },
        ],
      }, variant);

      const flow = renderSection({
        kickerEn: 'Recommended Flow',
        kickerZh: '推荐流程',
        titleEn: 'The shortest normal loop for most agent work.',
        titleZh: '适合大多数 Agent 工作的最短正常路径。',
        copyEn: 'This is the normal path repeated across the docs and everyday usage.',
        copyZh: '这是文档和日常使用里最常出现的一条正常路径。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><div class="section-kicker">${renderBilingual('Agent-First Path', 'Agent 首选路径')}</div><h3>${renderBilingual('List devices, connect once, run, inspect, poll if async, then run again.', '先列设备、连一次、执行、检查，必要时轮询异步，再继续执行。')}</h3><pre><code>ssh-device-list\nssh-quick-connect\nssh-run\nssh-status\nssh-command-status\nssh-run</code></pre></article>`,
          `<article class="surface-card stack"><div class="section-kicker">${renderBilingual('When The Shell Gets Weird', '当 shell 进入异常状态')}</div><h3>${renderBilingual('Drop to diagnostics, history, and control tools instead of blindly sending another command.', '不要盲目再发一条命令，而是切到诊断、历史和控制工具。')}</h3><pre><code>ssh-session-diagnostics\nssh-session-history\nssh-session-control\nssh-status</code></pre></article>`,
          '</div>',
        ].join('\n'),
      });

      const tools = [
        ['ssh-device-list', '列出已配置设备和默认项。', 'List configured devices and defaults.'],
        ['ssh-quick-connect', '连接或复用默认目标，并可选打开 viewer。', 'Connect or reuse the default target and optionally open the viewer.'],
        ['ssh-run', '主命令执行路径，带完成判定和退出码捕获。', 'Main command execution path with completion detection and exit-code capture.'],
        ['ssh-status', '查看 session、viewer 状态和运行模式。', 'Inspect sessions, viewer state, and operation mode.'],
        ['ssh-command-status', '查询异步命令进度。', 'Poll async command progress.'],
        ['ssh-retry', '对易失败命令做自动重试。', 'Retry flaky commands with backoff.'],
        ['ssh-session-history', '查看混合终端历史。', 'Read mixed terminal history.'],
        ['ssh-session-control', '发送 ctrl_c、方向键、tab 等控制输入。', 'Send control keys such as ctrl_c, arrows, or tab.'],
        ['ssh-session-diagnostics', '查看锁状态、警告、运行中命令和 viewer 健康度。', 'Inspect lock state, warnings, running command state, and viewer health.'],
      ];

      const mcpTools = renderSection({
        kickerEn: 'MCP Tools',
        kickerZh: 'MCP 工具',
        titleEn: 'Tools the MCP client actually calls.',
        titleZh: 'MCP client 真正会调用的工具。',
        copyEn: 'If a tool name looks familiar but you cannot remember why, start here.',
        copyZh: '如果某个工具名看着眼熟，但一时想不起来它是干什么的，就从这里开始。',
        body: [
          '<div class="grid three-up">',
          ...tools.map(([name, zh, en]) => [
            '<article class="surface-card stack">',
            `  <div class="section-kicker">${renderBilingual('Tool', '工具')}</div>`,
            `  <h3><code>${name}</code></h3>`,
            `  <p>${renderBilingual(en, zh)}</p>`,
            '</article>',
          ].join('\n')),
          '</div>',
        ].join('\n'),
      });

      const cli = renderSection({
        kickerEn: 'Operator CLI',
        kickerZh: '操作者 CLI',
        titleEn: '`ssh-session-mcp-ctl` commands for local operators and debugging.',
        titleZh: '面向本地操作者和调试的 `ssh-session-mcp-ctl` 命令。',
        copyEn: 'These are the local operator commands people reach for most often.',
        copyZh: '这些是本地操作者最常会用到的几个命令。',
        body: [
          '<div class="code-grid three-up">',
          renderCodeCard('Status', '状态', 'ssh-session-mcp-ctl status'),
          renderCodeCard('Devices', '设备', 'ssh-session-mcp-ctl devices'),
          renderCodeCard('Launch', '启动', 'ssh-session-mcp-ctl launch --viewerPort=auto'),
          renderCodeCard('Local demo', '本地演示', 'ssh-session-mcp-ctl launch --local --viewerPort=auto'),
          renderCodeCard('Logs', '日志', 'ssh-session-mcp-ctl logs --tail=60'),
          renderCodeCard('Cleanup', '清理', 'ssh-session-mcp-ctl cleanup'),
          '</div>',
        ].join('\n'),
      });

      const longTailCommands = renderSection({
        kickerEn: 'Command Questions',
        kickerZh: '命令问题',
        titleEn: 'Short answers for the command names people forget.',
        titleZh: '把大家最容易忘的命令名快速解释清楚。',
        copyEn: 'These are useful when you saw a tool once in a log, prompt, or example and want a fast reminder.',
        copyZh: '如果你是在日志、提示词或示例里见过一次命令名，现在想快速回忆它是做什么的，这一组最合适。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><h3>${renderBilingual('What does `ssh-quick-connect` do?', '`ssh-quick-connect` 是干什么的？')}</h3><p>${renderBilingual('It opens or reuses the common SSH session and can also launch the viewer, so it is the recommended first step before `ssh-run`.', '它会打开或复用常用 SSH 会话，还可以顺手拉起 viewer，所以它是 `ssh-run` 之前推荐的第一步。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('When should I use `ssh-command-status`?', '什么时候该用 `ssh-command-status`？')}</h3><p>${renderBilingual('Use it when `ssh-run` returns an async command ID or when long-running remote work should be polled explicitly instead of guessed.', '当 `ssh-run` 返回异步命令 ID，或者远程长任务应该被显式轮询而不是靠猜时，就该用它。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('What is `ssh-session-diagnostics` for?', '`ssh-session-diagnostics` 是做什么的？')}</h3><p>${renderBilingual('It inspects lock state, warnings, running command state, and viewer health when the terminal is blocked, odd, or clearly stateful.', '当终端被阻塞、状态异常、或明显进入强状态依赖时，它用来检查锁状态、警告、运行中命令和 viewer 健康度。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('When do I use `ssh-session-mcp-ctl` instead of MCP tools?', '什么时候该用 `ssh-session-mcp-ctl`，而不是 MCP 工具？')}</h3><p>${renderBilingual('Use the CLI when you are acting as the local operator and need process status, device listing, launch, logs, or cleanup outside the MCP tool loop.', '当你是本地操作者，需要看进程状态、列设备、启动、看日志或清理，而不是走 MCP 工具回路时，就用这个 CLI。')}</p></article>`,
          '</div>',
        ].join('\n'),
      });

      const internalLinks = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'If the command is clear, these pages cover the rest.',
        titleZh: '如果命令已经看明白了，剩下的问题在这些页面里。',
        copyEn: 'Most people next want setup steps, practical answers, or the bigger picture.',
        copyZh: '大多数人接下来会去看安装步骤、实际问答，或者更完整的背景。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.install.route)}"><div class="path-label">${renderBilingual('Install', '安装')}</div><div class="path-title">${renderBilingual('Need the full setup path?', '如果还需要完整接入路径？')}</div><div class="path-copy">${renderBilingual('Open the install guide for Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows setup.', '去安装页看 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 的完整接入方式。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.faq.route)}"><div class="path-label">${renderBilingual('FAQ', '问答')}</div><div class="path-title">${renderBilingual('Need a quick answer?', '如果需要一个直接答案？')}</div><div class="path-copy">${renderBilingual('Go to the FAQ page for viewer, lock, async command, Docker, and Windows questions.', '去 FAQ 看 viewer、输入锁、异步命令、Docker 和 Windows 相关问题。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.compare.route)}"><div class="path-label">${renderBilingual('Compare', '对比')}</div><div class="path-title">${renderBilingual('Want the bigger picture?', '如果想看更完整的差别？')}</div><div class="path-copy">${renderBilingual('The compare page explains why these commands sit on a shared PTY runtime instead of a simpler wrapper.', '对比页会解释，为什么这些命令建立在共享 PTY 运行时之上，而不是更简单的 wrapper。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">commands</span></div>`,
        hero,
        flow,
        mcpTools,
        cli,
        longTailCommands,
        internalLinks,
      ].join('\n');
    },
  },
  {
    slug: 'resources',
    baseRoute: 'resources/',
    className: 'page-resources',
    titleEn: 'SSH Session MCP Resources | npm, GitHub, Registry, Mirrors, and Articles',
    titleZh: 'SSH Session MCP 资源页 | npm、GitHub、Registry、镜像与文章索引',
    descriptionEn: 'Browse the SSH Session MCP resource index: npm package, GitHub source, server.json registry metadata, Gitee mirror, and article links from dev.to, CSDN, Juejin, and OSChina.',
    descriptionZh: '查看 SSH Session MCP 的资源索引页：npm 包、GitHub 源码、server.json registry 元数据、Gitee 镜像，以及 dev.to、CSDN、掘金、开源中国等文章链接。',
    keywords: [...commonKeywords, 'ssh session mcp resources', 'ssh session mcp registry', 'ssh session mcp articles'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.website },
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: variant.lang === 'en' ? 'SSH Session MCP resources' : 'SSH Session MCP 资源页',
          url: variant.absoluteUrl,
          description: variant.descriptionEn,
          inLanguage: [variant.lang],
          isPartOf: {
            '@type': 'WebSite',
            name: 'SSH Session MCP',
            url: siteUrl,
          },
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Resource Index',
        eyebrowZh: '资源索引',
        titleEn: 'One place for official links, registry metadata, mirrors, and articles.',
        titleZh: '把官方链接、registry 信息、镜像和文章放在一个地方。',
        ledeEn: 'Use this page when you want the package, source, registry metadata, mirrors, and writeups collected in one place instead of scattered across the site.',
        ledeZh: '如果你想把包地址、源码、registry 信息、镜像和文章都放在一个地方看，这一页就是最方便的入口。',
        ctas: [
          { className: 'button-primary', href: () => githubUrl, en: 'Open GitHub Source', zh: '打开 GitHub 源码' },
          { className: 'button-secondary', href: () => npmUrl, en: 'Open npm Package', zh: '打开 npm 包页' },
          { className: 'button-tertiary', href: () => registryUrl, en: 'Open server.json Registry Metadata', zh: '打开 server.json 元数据' },
        ],
        stats: [
          { labelEn: 'What It Is For', labelZh: '这页适合', valueEn: 'Finding the main links people usually ask for in one place.', valueZh: '把大家最常要找的几个主入口集中放在一起。' },
          { labelEn: 'Best Used When', labelZh: '适合什么时候看', valueEn: 'You want package, source, and article links without opening several pages first.', valueZh: '当你想一次性找到包地址、源码和文章入口，而不想先翻好几页时。' },
          { labelEn: 'What You Will Find', labelZh: '你能在这里找到', valueEn: 'Official links, registry metadata, mirrors, and community writeups.', valueZh: '官方链接、registry 信息、镜像和社区文章。' },
        ],
        keywords: ['ssh session mcp resources', 'ssh session mcp registry', 'npm package', 'gitee mirror', 'dev.to article'],
        visualBarLeft: 'resources / registry / outbound index',
        visualBarRight: 'all links together',
        visualImageAlt: 'Animated shared terminal resource demo',
        visualNotes: [
          { en: 'Official links stay grouped together so users and crawlers can understand which URLs are primary.', zh: '官方链接集中在一起，让用户和爬虫都更容易理解哪些 URL 是主入口。' },
          { en: 'Articles and mirrors are here when you want broader context or a backup source.', zh: '如果你想看更广的背景，或者需要备用来源，文章和镜像都可以从这里进入。' },
        ],
      }, variant);

      const official = renderSection({
        kickerEn: 'Official',
        kickerZh: '官方',
        titleEn: 'Primary links users should trust first.',
        titleZh: '用户应优先信任的主入口。',
        copyEn: 'These are the core destinations: source, package install page, release feed, issue tracker, and registry metadata.',
        copyZh: '这些是主入口：源码、包安装页、发布页、Issue 跟踪和 registry 元数据。',
        body: [
          '<div class="grid three-up">',
          [
            { titleEn: 'GitHub source for ssh-session-mcp', titleZh: 'ssh-session-mcp GitHub 源码', copyEn: 'Repository source, docs, issues, and releases.', copyZh: '仓库源码、文档、Issue 和发布页。', href: githubUrl },
            { titleEn: 'ssh-session-mcp on npm', titleZh: 'ssh-session-mcp npm 包页', copyEn: 'Package page for `npx -y ssh-session-mcp` installs.', copyZh: '用于 `npx -y ssh-session-mcp` 安装的包页面。', href: npmUrl },
            { titleEn: 'MCP registry metadata in server.json', titleZh: 'server.json 里的 MCP registry 元数据', copyEn: 'Registry-facing metadata and environment variable declarations.', copyZh: '面向 registry 的元数据和环境变量声明。', href: registryUrl },
            { titleEn: 'GitHub releases', titleZh: 'GitHub 发布页', copyEn: 'Tagged releases and version history.', copyZh: '标签发布与版本历史。', href: releasesUrl },
            { titleEn: 'Issue tracker', titleZh: 'Issue 跟踪', copyEn: 'Bug reports, feature requests, and operator questions.', copyZh: 'Bug、功能请求和操作者问题。', href: issuesUrl },
            { titleEn: 'Gitee mirror', titleZh: 'Gitee 镜像', copyEn: 'Alternative repository mirror for users who prefer Gitee.', copyZh: '适合偏好 Gitee 或访问 GitHub 不稳定的用户。', href: giteeUrl },
          ].map((item) => [
            `<a class="path-card stack" href="${item.href}">`,
            `  <div class="path-label">${renderBilingual('Link', '链接')}</div>`,
            `  <div class="path-title">${renderBilingual(item.titleEn, item.titleZh)}</div>`,
            `  <div class="path-copy">${renderBilingual(item.copyEn, item.copyZh)}</div>`,
            '</a>',
          ].join('\n')).join('\n'),
          '</div>',
        ].join('\n'),
      });

      const articles = renderSection({
        kickerEn: 'Articles',
        kickerZh: '文章',
        titleEn: 'Secondary discovery paths that help search and community reach.',
        titleZh: '帮助搜索发现和社区传播的次级入口。',
        copyEn: 'This page points you to the original sources with clear labels, so you can choose what to read next.',
        copyZh: '这里用清楚的标签把你带到原始来源，你可以按自己想看的方向继续读下去。',
        body: [
          '<div class="grid two-up">',
          [
            { titleEn: 'dev.to article: shared AI + remote SSH work', titleZh: 'dev.to 文章：共享 AI + 远程 SSH 工作流', copyEn: 'Project story and the motivation behind a shared SSH terminal for AI agents.', copyZh: '项目起因，以及为什么 AI Agent 需要共享 SSH 终端。', href: devtoUrl },
            { titleEn: 'CSDN article: install and usage overview', titleZh: 'CSDN：安装与使用说明', copyEn: 'Chinese article focused on setup and usage.', copyZh: '偏安装与使用的中文文章。', href: csdnUrl },
            { titleEn: 'Juejin article', titleZh: '掘金文章', copyEn: 'Chinese developer-community discovery path.', copyZh: '用于中文开发者社区发现。', href: juejinUrl },
            { titleEn: 'OSChina article', titleZh: '开源中国文章', copyEn: 'Another Chinese article entry point for readers who prefer OSChina.', copyZh: '如果你更习惯在开源中国看内容，也可以从这里继续。', href: oschinaUrl },
          ].map((item) => [
            `<a class="path-card stack" href="${item.href}">`,
            `  <div class="path-label">${renderBilingual('Article', '文章')}</div>`,
            `  <div class="path-title">${renderBilingual(item.titleEn, item.titleZh)}</div>`,
            `  <div class="path-copy">${renderBilingual(item.copyEn, item.copyZh)}</div>`,
            '</a>',
          ].join('\n')).join('\n'),
          '</div>',
        ].join('\n'),
      });

      const internalLinks = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'After the links, these pages usually help next.',
        titleZh: '看完链接之后，下一步通常看这些。',
        copyEn: 'Most people then move on to setup, answers, or examples.',
        copyZh: '大多数人接下来会去看安装、答案或例子。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.install.route)}"><div class="path-label">${renderBilingual('Install', '安装')}</div><div class="path-title">${renderBilingual('Ready to set it up?', '准备开始安装？')}</div><div class="path-copy">${renderBilingual('If you already know you want it, the install page has the setup steps.', '如果你已经确定想装，安装页会把步骤列清楚。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.faq.route)}"><div class="path-label">${renderBilingual('FAQ', '问答')}</div><div class="path-title">${renderBilingual('Want quick answers?', '想先看几个直接答案？')}</div><div class="path-copy">${renderBilingual('If you are more concerned about trust, behavior, viewer, or lock questions, go to the FAQ page.', '如果你现在更关心信任、行为、viewer 或输入锁问题，就去 FAQ。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup['use-cases'].route)}"><div class="path-label">${renderBilingual('Use Cases', '场景')}</div><div class="path-title">${renderBilingual('Want to see where it fits?', '想看它适合用在哪些地方？')}</div><div class="path-copy">${renderBilingual('Use the scenario page for embedded Linux, deployment, remote debugging, and operator workflows.', '去场景页看嵌入式 Linux、部署、远程调试和操作者工作流里的用法。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">resources</span></div>`,
        hero,
        official,
        articles,
        internalLinks,
      ].join('\n');
    },
  },
  {
    slug: 'faq',
    baseRoute: 'faq/',
    className: 'page-faq',
    titleEn: 'SSH Session MCP FAQ | Shared PTY, Install, Viewer, Lock, and Async Questions',
    titleZh: 'SSH Session MCP FAQ | 共享 PTY、安装、Viewer、输入锁与异步问题',
    descriptionEn: 'Read the SSH Session MCP FAQ covering install questions, shared PTY behavior, browser viewer value, input lock, async command tracking, and when to choose Docker or Windows fallback commands.',
    descriptionZh: '阅读 SSH Session MCP FAQ，覆盖安装问题、共享 PTY 行为、浏览器 viewer 价值、输入锁、异步命令跟踪，以及何时选择 Docker 或 Windows 回退命令。',
    keywords: [...commonKeywords, 'ssh session mcp faq', 'shared pty faq', 'ssh viewer faq'],
    structuredData(variant) {
      return [
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What is the difference between SSH Session MCP and a normal SSH wrapper?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'SSH Session MCP preserves a shared PTY so the user and AI agent see the same terminal state, prompts, history, and long-running process lifecycle.',
              },
            },
            {
              '@type': 'Question',
              name: 'How do I install SSH Session MCP for Codex or Claude Code?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Use npx -y ssh-session-mcp --viewerPort=auto for the lightest path, then register that command as an MCP server in Codex CLI, Claude Code, Cline, or OpenCode.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why does a browser terminal viewer matter?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'The viewer lets the human inspect prompts, intervene manually, and share terminal state with the AI instead of trusting a stateless command wrapper.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why would I want a shared PTY instead of isolated command calls?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A shared PTY preserves prompt state, editors, pagers, and long-running shell context instead of forcing every step to behave like a fresh command call.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why not just keep sending ssh-run when a terminal blocks?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A blocked terminal may be inside a pager, editor, or password prompt. In that state, diagnostics, history, or control inputs are safer than blindly sending another command.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why does input lock matter for AI-assisted SSH work?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Input lock stops the AI from typing over the human during interactive or risky shell moments when both sides share the same remote terminal.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why does the viewer matter if I already have terminal output?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'The browser viewer gives the human a live, interruptible window into prompts, shell state, and operator takeover that plain command output does not provide.',
              },
            },
          ],
          inLanguage: [variant.lang],
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'FAQ',
        eyebrowZh: '问答',
        titleEn: 'Questions users actually ask before they install or trust the runtime.',
        titleZh: '这是用户在安装前、接入前、信任运行时前，真正会问的问题。',
        ledeEn: 'The homepage keeps a short summary, but this page gathers the common questions in one place so you can skim them quickly.',
        ledeZh: '首页只放了简短摘要，这一页把常见问题集中在一起，方便你快速扫一遍。',
        ctas: [
          { className: 'button-primary', href: (v) => relativeHref(v.route, v.lookup.home.route), en: 'Back To Overview', zh: '回到总览' },
          { className: 'button-secondary', href: (v) => relativeHref(v.route, v.lookup.install.route), en: 'Install Page', zh: '安装页' },
          { className: 'button-tertiary', href: (v) => relativeHref(v.route, v.lookup['use-cases'].route), en: 'Use Cases', zh: '使用场景' },
        ],
        stats: [
          { labelEn: 'Focus', labelZh: '聚焦', valueEn: 'Install questions, shared PTY behavior, viewer value, input lock, async jobs, and environment choices.', valueZh: '安装问题、共享 PTY 行为、viewer 价值、输入锁、异步任务和环境选择。' },
          { labelEn: 'Best For', labelZh: '适合', valueEn: 'Getting direct answers before or after setup.', valueZh: '无论是在安装前还是安装后，想快速拿到直接答案。' },
          { labelEn: 'Read Next', labelZh: '接着看', valueEn: 'Pair this page with install for setup and use cases for workflow context.', valueZh: '接下来可以配合安装页看接入步骤，或配合场景页看工作流背景。' },
        ],
        keywords: ['ssh session mcp faq', 'shared pty faq', 'browser ssh terminal faq', 'input lock faq'],
        visualBarLeft: 'faq / install questions / trust',
        visualBarRight: 'quick answers',
        visualImageAlt: 'Animated shared terminal FAQ demo',
        visualNotes: [
          { en: 'Questions are easier to scan when each one has a short, direct answer.', zh: '当每个问题都对应一个短而直接的回答时，扫一遍会轻松很多。' },
          { en: 'Keep answers short, concrete, and grounded in actual runtime behavior.', zh: '回答要短、具体，并且回到真实运行时行为。' },
        ],
      }, variant);

      const faqs = [
        {
          qEn: 'What is the difference between SSH Session MCP and a normal SSH wrapper?',
          qZh: 'SSH Session MCP 和普通 SSH 包装层有什么区别？',
          aEn: 'A normal wrapper executes one command at a time. SSH Session MCP preserves a shared PTY, so the user and AI agent see the same terminal state, prompts, history, and long-running process lifecycle.',
          aZh: '普通包装层通常一次执行一条命令。SSH Session MCP 会保留共享 PTY，让用户和 AI Agent 看到同一份终端状态、提示符、历史和长任务生命周期。',
        },
        {
          qEn: 'How do I install SSH Session MCP for Codex, Claude Code, Cline, or OpenCode?',
          qZh: '如何给 Codex、Claude Code、Cline 或 OpenCode 安装 SSH Session MCP？',
          aEn: 'Use `npx -y ssh-session-mcp --viewerPort=auto` as the default install path, then register that command in the MCP client. Client-specific examples are collected in the install guide and `llms-install.md`.',
          aZh: '默认安装路径是 `npx -y ssh-session-mcp --viewerPort=auto`，然后把这条命令注册到对应的 MCP client。客户端示例可以在安装指南和 `llms-install.md` 里找到。',
        },
        {
          qEn: 'Why does a browser terminal viewer matter?',
          qZh: '为什么浏览器 terminal viewer 值得要？',
          aEn: 'Because the human can inspect prompts, manually intervene, and confirm what the AI is doing on the same terminal instead of guessing from disconnected command outputs.',
          aZh: '因为人可以直接看到提示符、手工介入、确认 AI 在做什么，而不是只能从断开的命令输出里猜测。',
        },
        {
          qEn: 'What does input lock solve?',
          qZh: '输入锁解决了什么问题？',
          aEn: 'It prevents the AI and the human from typing over each other in the same terminal. That is important when a shell becomes interactive, risky, or stateful.',
          aZh: '它防止 AI 和人同时往同一个终端里乱打字。这在 shell 进入交互态、高风险态或强状态依赖时尤其重要。',
        },
        {
          qEn: 'When should I use Docker instead of npx?',
          qZh: '什么时候该用 Docker 而不是 npx？',
          aEn: 'Use Docker when you need a pinned runtime, image-based distribution, or a fixed mapped viewer port. For normal desktop setup, `npx -y ssh-session-mcp --viewerPort=auto` is still the lower-friction default.',
          aZh: '当你需要固定运行时、镜像分发或稳定的 viewer 映射端口时，用 Docker。对普通桌面端接入来说，`npx -y ssh-session-mcp --viewerPort=auto` 仍是摩擦更小的默认方案。',
        },
        {
          qEn: 'What should Windows users do if stdio launch fails?',
          qZh: '如果 Windows 上的 stdio 启动失败该怎么办？',
          aEn: 'Use `cmd /c npx -y ssh-session-mcp --viewerPort=auto` as the fallback. Some MCP clients spawn stdio commands differently on native Windows.',
          aZh: '用 `cmd /c npx -y ssh-session-mcp --viewerPort=auto` 作为回退方案。部分 MCP client 在原生 Windows 上拉起 stdio 命令的方式并不一样。',
        },
      ];

      const longTailFaq = renderSection({
        kickerEn: 'More Questions',
        kickerZh: '更多问题',
        titleEn: 'A few more things people often wonder about.',
        titleZh: '再补几件大家经常会追问的事。',
        copyEn: 'These usually show up after the basic setup is already clear.',
        copyZh: '这些问题通常会出现在你已经弄清基本接入方式之后。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><h3>${renderBilingual('Why would I want a shared PTY instead of isolated command calls?', '为什么我要共享 PTY，而不是隔离的单次命令调用？')}</h3><p>${renderBilingual('Because remote shell state, prompts, editors, pagers, and long-running commands often matter across steps. A shared PTY preserves that context instead of forcing every turn to pretend it starts from zero.', '因为远程 shell 状态、提示符、编辑器、分页器和长任务经常会跨步骤持续存在。共享 PTY 能保住这些上下文，而不是让每一步都假装从零开始。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why not just keep sending `ssh-run` when a terminal blocks?', '当终端阻塞时，为什么不能一直继续发 `ssh-run`？')}</h3><p>${renderBilingual('Because the terminal may be inside a pager, editor, or password prompt. In those states, diagnostics, history, or control inputs are safer than blindly sending another command string.', '因为终端可能已经进了分页器、编辑器或密码提示。在这些状态里，诊断、历史查看或控制输入会比盲发下一条命令更安全。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why does input lock matter for AI-assisted SSH work?', '为什么 AI 辅助 SSH 工作需要输入锁？')}</h3><p>${renderBilingual('It stops the AI from typing over the human during interactive or risky shell moments, which is a common failure mode when both sides share one remote terminal.', '它能阻止 AI 在交互态或高风险时刻覆盖人的输入，而这正是共享同一远程终端时最常见的失败模式之一。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why does the viewer matter if I already have terminal output?', '如果我已经能拿到终端输出，为什么还需要 viewer？')}</h3><p>${renderBilingual('Because terminal output alone does not give the human a live, interruptible window into prompts, shell state, or operator takeover. The browser viewer does.', '因为单纯的终端输出并不能给人一个可实时旁观、可中断、可接管的窗口去看提示符和 shell 状态，而浏览器 viewer 可以。')}</p></article>`,
          '</div>',
        ].join('\n'),
      });

      const related = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'If one answer leads to the next question, start here.',
        titleZh: '如果一个答案又引出了下一个问题，从这里继续。',
        copyEn: 'Install keeps the commands together, resources keeps the links together, and use cases gives the wider context.',
        copyZh: '安装页把命令放在一起，资源页把链接放在一起，场景页补更完整的背景。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.install.route)}"><div class="path-label">${renderBilingual('Install', '安装')}</div><div class="path-title">${renderBilingual('Still need the exact client commands?', '如果还需要精确的客户端命令？')}</div><div class="path-copy">${renderBilingual('The install page keeps Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows setup together.', '安装页把 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 的接入方式都放在了一起。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.resources.route)}"><div class="path-label">${renderBilingual('Resources', '资源')}</div><div class="path-title">${renderBilingual('Need official links or articles?', '如果需要官方链接或文章？')}</div><div class="path-copy">${renderBilingual('The resources page gathers npm, GitHub, registry details, mirrors, and external articles.', '资源页把 npm、GitHub、registry 信息、镜像和外部文章集中放在一起。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup['use-cases'].route)}"><div class="path-label">${renderBilingual('Use Cases', '场景')}</div><div class="path-title">${renderBilingual('Want the bigger context?', '如果想看更完整的使用背景？')}</div><div class="path-copy">${renderBilingual('The use-case page explains where viewer, lock, async tracking, and policy rules help most.', '场景页会解释 viewer、输入锁、异步跟踪和策略规则最适合用在哪些地方。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">faq</span></div>`,
        hero,
        renderSection({
          kickerEn: 'Questions',
          kickerZh: '问题',
          titleEn: 'Search-friendly answers, one topic per card.',
          titleZh: '可搜索、可扫描，一卡一个问题。',
          copyEn: 'This page keeps the answers short and direct so you can get unstuck quickly, then keep going if needed.',
          copyZh: '这里的答案都会尽量短而直接，方便你先把问题解决，再决定下一步往哪看。',
          body: [
            '<div class="grid two-up">',
            ...faqs.map((faq) => [
              '<article class="surface-card stack">',
              `  <h3>${renderBilingual(faq.qEn, faq.qZh)}</h3>`,
              `  <p>${renderBilingual(faq.aEn, faq.aZh)}</p>`,
              '</article>',
            ].join('\n')),
            '</div>',
          ].join('\n'),
        }),
        longTailFaq,
        related,
      ].join('\n');
    },
  },
  {
    slug: 'use-cases',
    baseRoute: 'use-cases/',
    className: 'page-use-cases',
    titleEn: 'SSH Session MCP Use Cases | Shared PTY, Viewer, Lock, Async Tracking, and Policy Rules',
    titleZh: 'SSH Session MCP 使用场景 | 共享 PTY、Viewer、输入锁、异步跟踪与策略规则',
    descriptionEn: 'Explore why SSH Session MCP matters in real workflows: shared PTY debugging, browser viewer oversight, input lock, async command tracking, and policy rules for safer remote AI-assisted terminal work.',
    descriptionZh: '查看 SSH Session MCP 在真实工作流里的价值：共享 PTY 调试、浏览器 viewer 旁观、输入锁、异步命令跟踪，以及面向更安全远程 AI 终端协作的策略规则。',
    keywords: [...commonKeywords, 'shared pty use case', 'ssh viewer use case', 'input lock ssh', 'async command tracking ssh'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.softwareApplication, url: variant.absoluteUrl, description: variant.descriptionEn, inLanguage: [variant.lang] },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: [variant.lang],
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What is the difference between SSH Session MCP and a normal SSH wrapper?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'SSH Session MCP keeps one shared PTY alive for the human and AI, while a normal SSH wrapper usually treats each command as isolated, disposable work.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why is a browser viewer part of the comparison?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A browser viewer changes visibility and trust. It gives the human a live window into prompts, logs, and manual takeover instead of hiding terminal state behind disconnected outputs.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why do shared PTY and input lock belong together?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Once the terminal becomes shared and stateful, input lock prevents the AI and human from racing each other in the same shell.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why is async tracking part of the architecture difference?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A stateful remote runtime acknowledges that commands may outlive one request-response turn, and async tracking makes that explicit instead of pretending everything finishes immediately.',
              },
            },
          ],
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Use Cases',
        eyebrowZh: '使用场景',
        titleEn: 'Explain the value by workflow, not by feature dump.',
        titleZh: '按工作流解释价值，而不是平铺功能名。',
        ledeEn: 'Shared PTY, viewer, lock, async tracking, and policy rules are not equally important in every environment. This page breaks them apart so users can map product behavior to embedded, ops, deployment, and remote debugging work.',
        ledeZh: '共享 PTY、viewer、输入锁、异步跟踪和策略规则，在不同环境里的重要性并不一样。这个页面把它们拆开，让用户能把产品行为映射到嵌入式、运维、部署和远程调试场景。',
        ctas: [
          { className: 'button-primary', href: (v) => relativeHref(v.route, v.lookup.install.route), en: 'Install First', zh: '先看安装' },
          { className: 'button-secondary', href: (v) => relativeHref(v.route, v.lookup.faq.route), en: 'Read FAQ', zh: '查看 FAQ' },
          { className: 'button-tertiary', href: (v) => relativeHref(v.route, v.lookup.resources.route), en: 'Open Resources', zh: '查看资源页' },
        ],
        stats: [
          { labelEn: 'Shared PTY', labelZh: '共享 PTY', valueEn: 'Useful when prompt state, long-running commands, and manual takeover must stay visible.', valueZh: '当提示符状态、长任务和人工接管必须保持可见时最有价值。' },
          { labelEn: 'Viewer + Lock', labelZh: 'Viewer + 输入锁', valueEn: 'Useful when the human cannot fully surrender the shell to an AI agent.', valueZh: '当人不能把 shell 完全让给 AI Agent 时最有价值。' },
          { labelEn: 'Async + Policy', labelZh: '异步 + 策略', valueEn: 'Useful when remote commands are slow, flaky, or risky.', valueZh: '当远程命令慢、容易抖或带风险时最有价值。' },
        ],
        keywords: ['shared pty use case', 'browser viewer', 'input lock', 'async command tracking', 'policy rules'],
        visualBarLeft: 'use-cases / workflow / runtime',
        visualBarRight: 'stateful',
        visualImageAlt: 'Animated shared terminal use-case demo',
        visualNotes: [
          { en: 'Each card maps to a real operational problem instead of a generic feature list.', zh: '每张卡都对应一个真实的运维或开发问题，而不是泛泛的功能列表。' },
          { en: 'It also helps explain why “shared SSH MCP” is not just a different wrapper around the same command runner.', zh: '它也能更清楚说明：所谓“shared SSH MCP”并不只是给同一个命令执行器换了层包装。' },
        ],
      }, variant);

      const scenarios = [
        {
          labelEn: 'Shared PTY',
          labelZh: '共享 PTY',
          titleEn: 'Remote debugging on embedded Linux boards',
          titleZh: '嵌入式 Linux 板卡远程调试',
          copyEn: 'When commands change prompt state, spawn background jobs, or leave partial shell context behind, a shared PTY keeps both operator and AI grounded in the same runtime instead of re-simulating context each round.',
          copyZh: '当命令会改变提示符状态、拉起后台任务或留下半截 shell 上下文时，共享 PTY 能让操作者和 AI 站在同一个运行时上，而不是每轮都重新模拟上下文。',
          chips: ['embedded linux', 'remote debugging', 'stateful shell'],
        },
        {
          labelEn: 'Viewer',
          labelZh: 'Viewer',
          titleEn: 'Deployment hosts where humans must still watch the terminal',
          titleZh: '人必须继续盯终端的部署机场景',
          copyEn: 'A browser viewer matters when the human needs to inspect prompts, logs, or interactive confirmations in real time while the AI is still helping in the same session.',
          copyZh: '当人需要实时看提示符、日志或交互确认，而 AI 仍在同一会话里帮忙时，浏览器 viewer 的价值会非常直接。',
          chips: ['browser terminal', 'deploy host', 'visibility'],
        },
        {
          labelEn: 'Input Lock',
          labelZh: '输入锁',
          titleEn: 'Guardrails for risky or interactive shells',
          titleZh: '给高风险或交互态 shell 加护栏',
          copyEn: 'Input lock stops the AI from typing over the operator when the shell is in a sensitive moment. That matters more than usual on machines where a single stray input can alter remote state.',
          copyZh: '输入锁能在 shell 进入敏感时刻时阻止 AI 抢输入。对那些一次误输入就可能改变远端状态的机器，这个能力尤其重要。',
          chips: ['input lock', 'manual takeover', 'risky shell'],
        },
        {
          labelEn: 'Async Tracking',
          labelZh: '异步跟踪',
          titleEn: 'Long-running builds, training jobs, and flaky remote work',
          titleZh: '长时间构建、训练任务和易抖的远程工作',
          copyEn: 'Async command tracking lets the agent launch long work and poll it explicitly instead of pretending every remote task behaves like a short shell command.',
          copyZh: '异步命令跟踪让 Agent 能拉起长任务并显式轮询，而不是假装所有远程任务都像短命令一样马上结束。',
          chips: ['async status', 'long job', 'polling'],
        },
        {
          labelEn: 'Policy Rules',
          labelZh: '策略规则',
          titleEn: 'Safer collaboration on operationally sensitive machines',
          titleZh: '在运维敏感机器上更安全地协作',
          copyEn: 'Policy rules let operators stay in `safe` mode by default and loosen behavior only when the environment, workflow, and trust model actually justify it.',
          copyZh: '策略规则让操作者默认停在 `safe` 模式，只在环境、流程和信任模型真的允许时再放宽行为。',
          chips: ['safe mode', 'policy rules', 'ops safety'],
        },
        {
          labelEn: 'Local Demo',
          labelZh: '本地演示',
          titleEn: 'Demo the workflow before touching a real SSH target',
          titleZh: '在接触真实 SSH 目标前先演示工作流',
          copyEn: 'Local demo mode is useful when a team wants to validate the human/AI collaboration model before wiring credentials, hosts, and policy into a real environment.',
          copyZh: '当团队想先验证人机协作模型，再去接入真实凭证、主机和策略时，本地演示模式会很有帮助。',
          chips: ['--local', 'demo', 'offline testing'],
        },
      ];

      const related = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'If the idea makes sense, these pages help next.',
        titleZh: '如果这个思路已经看明白了，下一步看这些。',
        copyEn: 'Most people then want install steps, direct answers, or the official links.',
        copyZh: '这时候大多数人会继续去看安装步骤、直接问答或官方链接。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.install.route)}"><div class="path-label">${renderBilingual('Install', '安装')}</div><div class="path-title">${renderBilingual('Convinced already? Install it.', '已经被说服了？那就去安装。')}</div><div class="path-copy">${renderBilingual('Use the install page for Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows details.', '去安装页看 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 的细节。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.faq.route)}"><div class="path-label">${renderBilingual('FAQ', '问答')}</div><div class="path-title">${renderBilingual('Need narrower behavior answers?', '如果还要更细的行为问题？')}</div><div class="path-copy">${renderBilingual('Use the FAQ page when the user still has install, lock, viewer, or Docker questions.', '如果用户还在问安装、输入锁、viewer 或 Docker 相关问题，就去 FAQ。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.resources.route)}"><div class="path-label">${renderBilingual('Resources', '资源')}</div><div class="path-title">${renderBilingual('Need source, registry, mirrors, or articles?', '如果需要源码、registry、镜像或文章？')}</div><div class="path-copy">${renderBilingual('Use the resources page for official links and discovery paths.', '去资源页看官方链接和外部发现路径。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">use-cases</span></div>`,
        hero,
        renderSection({
          kickerEn: 'Scenario Breakdown',
          kickerZh: '场景拆解',
          titleEn: 'Each capability matters for a different reason.',
          titleZh: '每个能力都有自己更适合的理由。',
          copyEn: 'This structure is better than a flat feature list because it meets users where their real pain already exists: stateful terminals, manual intervention, long jobs, and safety boundaries.',
          copyZh: '这个结构比平铺功能列表更好，因为它直接对准用户已经存在的痛点：状态型终端、人工接管、长任务和安全边界。',
          body: [
            '<div class="grid three-up">',
            ...scenarios.map((item) => [
              '<article class="surface-card stack">',
              `  <div class="section-kicker">${renderBilingual(item.labelEn, item.labelZh)}</div>`,
              `  <h3>${renderBilingual(item.titleEn, item.titleZh)}</h3>`,
              `  <p>${renderBilingual(item.copyEn, item.copyZh)}</p>`,
              `  <div class="chip-row">${item.chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>`,
              '</article>',
            ].join('\n')),
            '</div>',
          ].join('\n'),
        }),
        related,
      ].join('\n');
    },
  },
  {
    slug: 'compare',
    baseRoute: 'compare/',
    className: 'page-compare',
    titleEn: 'SSH Session MCP Comparison | Shared PTY vs Stateless SSH Wrappers',
    titleZh: 'SSH Session MCP 对比 | 共享 PTY 与无状态 SSH Wrapper 的区别',
    descriptionEn: 'Compare SSH Session MCP with normal SSH wrappers and command-only SSH MCP servers. See why shared PTY, browser viewer, input lock, async tracking, and policy rules change real remote workflows.',
    descriptionZh: '对比 SSH Session MCP 与普通 SSH wrapper、仅命令型 SSH MCP server 的区别，理解为什么共享 PTY、浏览器 viewer、输入锁、异步跟踪和策略规则会改变真实远程工作流。',
    keywords: [...commonKeywords, 'ssh wrapper comparison', 'shared pty vs stateless shell', 'ssh mcp compare'],
    structuredData(variant) {
      return [
        { ...baseStructuredData.softwareApplication, url: variant.absoluteUrl, description: variant.descriptionEn, inLanguage: [variant.lang] },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: [variant.lang],
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What is the difference between SSH Session MCP and a normal SSH wrapper?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'SSH Session MCP keeps one shared PTY alive for the human and AI, while a normal SSH wrapper usually treats each command as isolated, disposable work.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why is a browser viewer part of the comparison?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A browser viewer changes visibility and trust. It gives the human a live window into prompts, logs, and manual takeover instead of hiding terminal state behind disconnected outputs.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why do shared PTY and input lock belong together?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Once the terminal becomes shared and stateful, input lock prevents the AI and human from racing each other in the same shell.',
              },
            },
            {
              '@type': 'Question',
              name: 'Why is async tracking part of the architecture difference?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'A stateful remote runtime acknowledges that commands may outlive one request-response turn, and async tracking makes that explicit instead of pretending everything finishes immediately.',
              },
            },
          ],
        },
      ];
    },
    render(variant) {
      const hero = pageHero({
        eyebrowEn: 'Comparison',
        eyebrowZh: '对比',
        titleEn: 'This is not just another SSH command wrapper.',
        titleZh: '这不只是另一个 SSH 命令包装层。',
        ledeEn: 'If you are deciding whether this is meaningfully different from a normal SSH wrapper, this page gives the clearest side-by-side explanation.',
        ledeZh: '很多用户在信任一个新的远程运行时之前，会先做对比搜索。这个页面就是专门回答：当终端变成“共享的、有状态的、对人和 AI 同时可见的”之后，到底改变了什么？',
        ctas: [
          { className: 'button-primary', href: (v) => relativeHref(v.route, v.lookup.install.route), en: 'Install Guide', zh: '安装指南' },
          { className: 'button-secondary', href: (v) => relativeHref(v.route, v.lookup['use-cases'].route), en: 'Use Cases', zh: '使用场景' },
          { className: 'button-tertiary', href: (v) => relativeHref(v.route, v.lookup.faq.route), en: 'FAQ', zh: 'FAQ' },
        ],
        stats: [
          { labelEn: 'Question', labelZh: '问题', valueEn: 'Why not just use a normal SSH wrapper?', valueZh: '为什么不直接用普通 SSH wrapper？' },
          { labelEn: 'Core Difference', labelZh: '核心差异', valueEn: 'SSH Session MCP keeps a shared PTY alive instead of re-wrapping each command as isolated work.', valueZh: 'SSH Session MCP 保留一条共享 PTY，而不是把每条命令都重新包装成孤立执行。' },
          { labelEn: 'Best For', labelZh: '适合', valueEn: 'Deciding whether this feels meaningfully different from a normal SSH wrapper.', valueZh: '想判断它和普通 SSH wrapper 到底是不是同一类东西。' },
        ],
        keywords: ['shared pty vs stateless shell', 'ssh wrapper comparison', 'browser viewer', 'input lock', 'async tracking'],
        visualBarLeft: 'compare / stateful / visible',
        visualBarRight: 'operator-aware',
        visualImageAlt: 'Animated shared terminal comparison demo',
        visualNotes: [
          { en: 'This page focuses on how the runtime behaves, not just how many features it has.', zh: '这一页重点讲运行时是怎么工作的，而不只是功能多不多。' },
          { en: 'It is most useful when the setup is clear but the reason still is not.', zh: '如果你已经看懂安装步骤，但还没完全明白为什么值得要，这一页最合适。' },
        ],
      }, variant);

      const compareBlocks = renderSection({
        kickerEn: 'Side-By-Side',
        kickerZh: '并排对比',
        titleEn: 'Normal wrapper vs shared SSH runtime.',
        titleZh: '普通 wrapper 与共享 SSH 运行时的差别。',
        copyEn: 'The strongest argument is behavioral, not marketing. The comparison below stays concrete.',
        copyZh: '最有说服力的不是营销话术，而是行为差异。下面的对比尽量保持具体。',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><div class="section-kicker">${renderBilingual('Normal SSH Wrapper', '普通 SSH Wrapper')}</div><h3>${renderBilingual('Runs commands, but does not preserve the terminal as shared state.', '能跑命令，但不会把终端当成共享状态保留下来。')}</h3><p>${renderBilingual('Each command is treated like a separate call. Prompt state, partial context, interactive pauses, and manual takeover become awkward because the wrapper is not centered on a durable PTY.', '每条命令都像单独调用。提示符状态、半截上下文、交互暂停和人工接管都会变得尴尬，因为它不是围绕一条持久 PTY 来设计的。')}</p><div class="chip-row"><span class="chip">stateless</span><span class="chip">command-only</span><span class="chip">weak takeover</span></div></article>`,
          `<article class="surface-card stack"><div class="section-kicker">${renderBilingual('SSH Session MCP', 'SSH Session MCP')}</div><h3>${renderBilingual('Keeps one PTY alive so the user and AI agent operate on the same runtime.', '保留一条 PTY，让用户和 AI Agent 操作同一份运行时。')}</h3><p>${renderBilingual('The browser viewer, input lock, async tracking, diagnostics, and policy rules all make more sense once the terminal is treated as a shared, stateful place instead of disposable command output.', '一旦终端被当成共享的、有状态的地方，而不是一次性命令输出，浏览器 viewer、输入锁、异步跟踪、诊断和策略规则就都变得合理了。')}</p><div class="chip-row"><span class="chip">shared PTY</span><span class="chip">browser viewer</span><span class="chip">operator-aware</span></div></article>`,
          '</div>',
        ].join('\n'),
      });

      const dimensions = renderSection({
        kickerEn: 'What Changes',
        kickerZh: '到底改变了什么',
        titleEn: 'Five practical differences that matter in real workflows.',
        titleZh: '五个在真实工作流里确实重要的差异。',
        copyEn: 'Each card focuses on one practical difference you can feel in a real workflow.',
        copyZh: '每张卡都只讲一个你在真实工作流里能感受到的差异。',
        body: [
          '<div class="grid three-up">',
          [
            ['Terminal state', '终端状态', 'One command call vs one shared PTY', '单次命令调用 vs 一条共享 PTY', 'Shared PTY keeps shell state visible to both sides instead of reconstructing context after every command.', '共享 PTY 会把 shell 状态留给双方，而不是每次命令后再去重构上下文。'],
            ['Visibility', '可见性', 'Hidden execution vs browser viewer', '隐藏执行 vs 浏览器 viewer', 'A viewer gives the human a live window into prompts, logs, and terminal anomalies.', 'viewer 会把提示符、日志和终端异常实时暴露给人。'],
            ['Input ownership', '输入归属', 'No guardrail vs input lock', '无护栏 vs 输入锁', 'Input lock matters when the shell turns interactive or risky and the AI must stop typing over the operator.', '当 shell 变成交互态或高风险态时，输入锁能阻止 AI 覆盖操作者输入。'],
            ['Long jobs', '长任务', 'Fire-and-forget guesswork vs async tracking', '靠猜的放飞式执行 vs 异步跟踪', 'Async tracking acknowledges that remote work is often slow and non-blocking.', '异步跟踪承认远程工作本来就经常是慢的、非阻塞的。'],
            ['Safety model', '安全模型', 'All-or-nothing execution vs policy-aware control', '全有或全无的执行 vs 策略感知控制', 'Policy rules let operators expose AI help without fully surrendering the machine.', '策略规则让操作者能开放 AI 帮助，但不必把整台机器完全让出去。'],
          ].map(([kEn, kZh, tEn, tZh, pEn, pZh]) => [
            '<article class="surface-card stack">',
            `  <div class="section-kicker">${renderBilingual(kEn, kZh)}</div>`,
            `  <h3>${renderBilingual(tEn, tZh)}</h3>`,
            `  <p>${renderBilingual(pEn, pZh)}</p>`,
            '</article>',
          ].join('\n')).join('\n'),
          '</div>',
        ].join('\n'),
      });

      const internalLinks = renderSection({
        kickerEn: 'Next',
        kickerZh: '下一步',
        titleEn: 'If the difference is clear, these pages help next.',
        titleZh: '如果差异已经看明白了，下一步看这些。',
        copyEn: 'Most people then want install steps, examples, or a few direct answers.',
        copyZh: '这时候大多数人会继续去看安装步骤、例子或几个直接答案。',
        body: [
          '<div class="grid three-up">',
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.install.route)}"><div class="path-label">${renderBilingual('Install', '安装')}</div><div class="path-title">${renderBilingual('Ready to try it?', '如果你已经想试一试？')}</div><div class="path-copy">${renderBilingual('The install guide covers Codex, Claude Code, Cline, OpenCode, npm, Docker, and Windows setup.', '安装页覆盖了 Codex、Claude Code、Cline、OpenCode、npm、Docker 和 Windows 配置。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup['use-cases'].route)}"><div class="path-label">${renderBilingual('Use Cases', '场景')}</div><div class="path-title">${renderBilingual('Want real workflow examples?', '想看真实工作流例子？')}</div><div class="path-copy">${renderBilingual('Use the use-case page for embedded Linux, deployment hosts, remote debugging, and ops scenarios.', '去场景页看嵌入式 Linux、部署机、远程调试和运维场景。')}</div></a>`,
          `<a class="path-card stack" href="${relativeHref(variant.route, variant.lookup.faq.route)}"><div class="path-label">${renderBilingual('FAQ', '问答')}</div><div class="path-title">${renderBilingual('Still have a few practical questions?', '如果还剩下一些实际问题？')}</div><div class="path-copy">${renderBilingual('The FAQ page keeps install, viewer, lock, Docker, and Windows answers together.', 'FAQ 会把安装、viewer、输入锁、Docker 和 Windows 相关问题集中放在一起。')}</div></a>`,
          '</div>',
        ].join('\n'),
      });

      const compareFaq = renderSection({
        kickerEn: 'Comparison Questions',
        kickerZh: '对比问题',
        titleEn: 'A few direct answers for people who are still deciding.',
        titleZh: '给还在比较阶段的人几个直接答案。',
        copyEn: 'If you are still judging whether this is meaningfully different, start with these.',
        copyZh: '如果你还在判断它是不是和普通做法有本质区别，可以先看这几条。 ',
        body: [
          '<div class="grid two-up">',
          `<article class="surface-card stack"><h3>${renderBilingual('What is the difference between SSH Session MCP and a normal SSH wrapper?', 'SSH Session MCP 和普通 SSH wrapper 到底差在哪？')}</h3><p>${renderBilingual('The biggest difference is that SSH Session MCP keeps one shared PTY alive for the human and AI, while a normal wrapper usually treats each command like isolated, disposable work.', '最大的差异是：SSH Session MCP 会为人和 AI 保留一条共享 PTY，而普通 wrapper 往往把每条命令都当成相互隔离、可丢弃的单次执行。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why is a browser viewer part of the comparison?', '为什么浏览器 viewer 也是对比重点？')}</h3><p>${renderBilingual('Because visibility changes behavior. A visible terminal is easier to trust, inspect, interrupt, and manually take over than hidden command execution.', '因为“可见性”本身就会改变行为。一个可见终端比隐藏式命令执行更容易被信任、检查、中断和人工接管。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why do shared PTY and input lock belong together?', '为什么 shared PTY 和输入锁经常要一起出现？')}</h3><p>${renderBilingual('Once the terminal becomes shared and stateful, you need a way to stop the AI and human from racing each other in the same shell. Input lock is that control.', '一旦终端变成共享且有状态，就必须有办法阻止 AI 和人同时在同一个 shell 里互相抢输入，而输入锁就是这个控制。')}</p></article>`,
          `<article class="surface-card stack"><h3>${renderBilingual('Why is async tracking part of the architecture difference?', '为什么异步跟踪也算架构差异的一部分？')}</h3><p>${renderBilingual('Because a stateful remote runtime acknowledges that commands may outlive one request-response turn. Async tracking makes that explicit instead of pretending everything finishes immediately.', '因为有状态的远程运行时承认：命令可能会活得比一次请求响应更久。异步跟踪把这件事显式表达出来，而不是假装所有命令都会立刻结束。')}</p></article>`,
          '</div>',
        ].join('\n'),
      });

      return [
        `<div class="breadcrumb"><a href="${relativeHref(variant.route, variant.lookup.home.route)}">SSH Session MCP</a><span>/</span><span class="breadcrumb-current">compare</span></div>`,
        hero,
        compareBlocks,
        dimensions,
        compareFaq,
        internalLinks,
      ].join('\n');
    },
  },
];

function createVariant(page, lang) {
  const prefix = lang === 'zh-CN' ? 'zh/' : '';
  const route = `${prefix}${page.baseRoute}`;
  return {
    ...page,
    lang,
    route,
    file: filePathFromRoute(route),
    absoluteUrl: routeToUrl(route),
    assetBase: assetPath(route),
    htmlLang: lang,
    title: lang === 'zh-CN' ? page.titleZh : page.titleEn,
    description: lang === 'zh-CN' ? page.descriptionZh : page.descriptionEn,
    descriptionEn: page.descriptionEn,
    descriptionZh: page.descriptionZh,
    copyLabel: lang === 'zh-CN' ? '复制' : 'Copy',
    copiedLabel: lang === 'zh-CN' ? '已复制' : 'Copied',
    failedLabel: lang === 'zh-CN' ? '复制失败' : 'Copy failed',
    ogLocale: lang === 'zh-CN' ? 'zh_CN' : 'en_US',
    defaultLang: lang,
  };
}

const variants = pageDefs.flatMap((page) => [createVariant(page, 'en'), createVariant(page, 'zh-CN')]);
const variantLookup = Object.fromEntries(pageDefs.map((page) => [page.slug, { en: variants.find((v) => v.slug === page.slug && v.lang === 'en'), zh: variants.find((v) => v.slug === page.slug && v.lang === 'zh-CN') }]));

for (const variant of variants) {
  variant.lookup = Object.fromEntries(Object.entries(variantLookup).map(([slug, pair]) => [slug, variant.lang === 'zh-CN' ? pair.zh : pair.en]));
  variant.alternate = variant.lang === 'zh-CN' ? variantLookup[variant.slug].en : variantLookup[variant.slug].zh;
}

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

function navLink(variant, item) {
  const target = variant.lang === 'zh-CN' ? variantLookup[item.slug].zh : variantLookup[item.slug].en;
  const classes = ['nav-link'];
  if (variant.slug === item.slug) classes.push('nav-link-active');
  return `<a class="${classes.join(' ')}" href="${relativeHref(variant.route, target.route)}">${renderBilingual(item.en, item.zh)}</a>`;
}

function footerPageLink(variant, item) {
  const target = variant.lang === 'zh-CN' ? variantLookup[item.slug].zh : variantLookup[item.slug].en;
  return `<a href="${relativeHref(variant.route, target.route)}">${renderBilingual(item.en, item.zh)}</a>`;
}

function renderLangSwitch(variant) {
  return [
    `<a class="lang-button${variant.lang === 'en' ? ' lang-button-active' : ''}" href="${relativeHref(variant.route, variantLookup[variant.slug].en.route)}">EN</a>`,
    `<a class="lang-button${variant.lang === 'zh-CN' ? ' lang-button-active' : ''}" href="${relativeHref(variant.route, variantLookup[variant.slug].zh.route)}">中文</a>`,
  ].join('');
}

function renderPage(variant, { is404 = false } = {}) {
  const title = is404 ? 'Page Not Found | SSH Session MCP' : variant.title;
  const description = is404
    ? (variant.lang === 'zh-CN'
      ? '页面不存在。请返回 SSH Session MCP 的总览页、安装页、资源页、FAQ 或使用场景页。'
      : 'Page not found. Return to the SSH Session MCP overview, install guide, resources, FAQ, or use-case pages.')
    : variant.description;

  const breadcrumbBlock = is404
    ? null
    : {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: variant.lang === 'zh-CN' ? '总览' : 'Overview',
            item: variantLookup.home[variant.lang === 'zh-CN' ? 'zh' : 'en'].absoluteUrl,
          },
          ...(variant.slug === 'home'
            ? []
            : [
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: variant.lang === 'zh-CN'
                    ? navigation.find((item) => item.slug === variant.slug)?.zh
                    : navigation.find((item) => item.slug === variant.slug)?.en,
                  item: variant.absoluteUrl,
                },
              ]),
        ],
      };

  const structuredBlocks = is404
    ? [{ ...baseStructuredData.website }]
    : [...variant.structuredData(variant), ...(breadcrumbBlock ? [breadcrumbBlock] : [])];

  const pageAlert = is404
    ? [
        '<section class="notice-card" role="status">',
        `  <div>${renderBilingual('<strong>Page not found.</strong> This URL does not map to a published page. Start from the overview or the install guide.', '<strong>页面不存在。</strong> 这个 URL 没有对应的已发布页面，请从总览页或安装页重新进入。')}</div>`,
        '  <div class="cta-row" style="margin-top: 0.95rem;">',
        `    <a class="button button-secondary" href="${relativeHref(variant.route, variant.lookup.home.route)}">${renderBilingual('Overview', '总览')}</a>`,
        `    <a class="button button-tertiary" href="${relativeHref(variant.route, variant.lookup.install.route)}">${renderBilingual('Install Guide', '安装指南')}</a>`,
        '  </div>',
        '</section>',
      ].join('\n')
    : '';

  const ogAltLocales = variant.lang === 'zh-CN'
    ? '<meta property="og:locale:alternate" content="en_US">'
    : '<meta property="og:locale:alternate" content="zh_CN">';

  const canonicalBlock = [
    `<link rel="canonical" href="${escapeHtml(variant.absoluteUrl)}">`,
    `<link rel="alternate" href="${escapeHtml(variantLookup[variant.slug].en.absoluteUrl)}" hreflang="en">`,
    `<link rel="alternate" href="${escapeHtml(variantLookup[variant.slug].zh.absoluteUrl)}" hreflang="zh-CN">`,
    `<link rel="alternate" href="${escapeHtml(variantLookup[variant.slug].en.absoluteUrl)}" hreflang="x-default">`,
  ].join('\n  ');

  return renderTemplate(template, {
    '__PACKAGE_NAME__': escapeHtml(pkg.name),
    '__PACKAGE_VERSION__': escapeHtml(pkg.version),
    '__PAGE_TITLE__': escapeHtml(title),
    '__PAGE_DESCRIPTION__': escapeHtml(description),
    '__SITE_KEYWORDS__': escapeHtml((is404 ? commonKeywords : variant.keywords).join(', ')),
    '__ROBOTS_CONTENT__': is404 ? 'noindex, nofollow' : 'index, follow',
    '__PAGE_URL__': escapeHtml(is404 ? routeToUrl(variant.lang === 'zh-CN' ? 'zh/404/' : '404/') : variant.absoluteUrl),
    '__OG_IMAGE_URL__': escapeHtml(ogImageUrl),
    '__CANONICAL_TAG__': is404 ? '' : canonicalBlock,
    '__ASSET_BASE__': variant.assetBase,
    '__STRUCTURED_DATA__': toStructuredDataScripts(structuredBlocks),
    '__HOME_URL__': relativeHref(variant.route, variant.lookup.home.route),
    '__NAV_LINKS__': navigation.map((item) => navLink(variant, item)).join('\n        '),
    '__PAGE_ALERT__': pageAlert,
    '__PAGE_CONTENT__': is404 ? '' : variant.render(variant),
    '__FOOTER_PAGE_LINKS__': navigation.map((item) => footerPageLink(variant, item)).join('\n            '),
    '__README_URL__': escapeHtml(readmeUrl),
    '__README_ZH_URL__': escapeHtml(readmeZhUrl),
    '__AGENT_GUIDE_URL__': escapeHtml(agentGuideUrl),
    '__ISSUES_URL__': escapeHtml(issuesUrl),
    '__PAGE_CLASS__': escapeHtml(variant.className + (is404 ? ' page-404' : '')),
    '__HTML_LANG__': escapeHtml(variant.htmlLang),
    '__DEFAULT_LANG__': escapeHtml(variant.defaultLang),
    '__OG_LOCALE__': escapeHtml(variant.ogLocale),
    '__OG_ALTERNATE_LOCALES__': ogAltLocales,
    '__LANG_SWITCH_LINKS__': renderLangSwitch(variant),
    '__COPY_LABEL__': escapeHtml(variant.copyLabel),
    '__COPIED_LABEL__': escapeHtml(variant.copiedLabel),
    '__FAILED_LABEL__': escapeHtml(variant.failedLabel),
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
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
  '        xmlns:xhtml="http://www.w3.org/1999/xhtml"',
  '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
  ...variants.flatMap((variant) => [
    '  <url>',
    `    <loc>${variant.absoluteUrl}</loc>`,
    `    <xhtml:link rel="alternate" hreflang="en" href="${variantLookup[variant.slug].en.absoluteUrl}" />`,
    `    <xhtml:link rel="alternate" hreflang="zh-CN" href="${variantLookup[variant.slug].zh.absoluteUrl}" />`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${variantLookup[variant.slug].en.absoluteUrl}" />`,
    `    <lastmod>${lastModified}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    variant.slug === 'home' ? '    <priority>1.0</priority>' : '    <priority>0.8</priority>',
    '    <image:image>',
    `      <image:loc>${ogImageUrl}</image:loc>`,
    `      <image:title>SSH Session MCP ${variant.slug} ${variant.lang}</image:title>`,
    `      <image:caption>${variant.descriptionEn}</image:caption>`,
    '    </image:image>',
    '    <image:image>',
    `      <image:loc>${heroImageUrl}</image:loc>`,
    '      <image:title>SSH Session MCP shared terminal demo</image:title>',
    `      <image:caption>${variant.descriptionEn}</image:caption>`,
    '    </image:image>',
    '  </url>',
  ]),
  '</urlset>',
  '',
].join('\n');

for (const variant of variants) {
  const outFile = join(DIST_DIR, variant.file);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderPage(variant), 'utf8');
}

const notFoundEn = join(DIST_DIR, '404.html');
const notFoundZh = join(DIST_DIR, 'zh', '404', 'index.html');
mkdirSync(dirname(notFoundZh), { recursive: true });
writeFileSync(notFoundEn, renderPage(variantLookup.home.en, { is404: true }), 'utf8');
writeFileSync(notFoundZh, renderPage(variantLookup.home.zh, { is404: true }), 'utf8');
writeFileSync(join(DIST_DIR, 'robots.txt'), robotsTxt, 'utf8');
writeFileSync(join(DIST_DIR, 'sitemap.xml'), sitemapXml, 'utf8');
