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
    const zhIndexHtml = readDistFile('zh/index.html');
    const installHtml = readDistFile('install/index.html');
    const zhInstallHtml = readDistFile('zh/install/index.html');
    const commandsHtml = readDistFile('commands/index.html');
    const zhCommandsHtml = readDistFile('zh/commands/index.html');
    const resourcesHtml = readDistFile('resources/index.html');
    const zhResourcesHtml = readDistFile('zh/resources/index.html');
    const faqHtml = readDistFile('faq/index.html');
    const zhFaqHtml = readDistFile('zh/faq/index.html');
    const useCasesHtml = readDistFile('use-cases/index.html');
    const zhUseCasesHtml = readDistFile('zh/use-cases/index.html');
    const compareHtml = readDistFile('compare/index.html');
    const zhCompareHtml = readDistFile('zh/compare/index.html');
    const notFoundHtml = readDistFile('404.html');
    const zhNotFoundHtml = readDistFile('zh/404/index.html');
    const robotsTxt = readDistFile('robots.txt');
    const sitemapXml = readDistFile('sitemap.xml');

    expect(indexHtml).toContain('SSH Session MCP | Shared SSH MCP Server for Codex, Claude Code, and AI Agents');
    expect(zhIndexHtml).toContain('SSH Session MCP | 面向 Codex、Claude Code 与 AI Agent 的共享 SSH MCP Server');
    expect(indexHtml).toContain('meta name="keywords"');
    expect(indexHtml).toContain('application/ld+json');
    expect(indexHtml).toContain('href="zh/"');
    expect(zhIndexHtml).toContain('href="../"');
    expect(indexHtml).toContain('https://zw-awa.github.io/ssh-session-mcp/');
    expect(indexHtml).toContain('MCP + SSH install guide');
    expect(zhIndexHtml).toContain('常见路径');

    expect(installHtml).toContain('SSH Session MCP Install Guide');
    expect(zhInstallHtml).toContain('SSH Session MCP 安装指南');
    expect(installHtml).toContain('codex mcp add ssh-session-mcp -- npx -y ssh-session-mcp --viewerPort=auto');
    expect(installHtml).toContain('cmd /c npx -y ssh-session-mcp --viewerPort=auto');
    expect(installHtml).toContain('docker.io/zwawa/ssh-session-mcp:latest');
    expect(zhInstallHtml).toContain('装好以后，下一步常见的问题通常在这些页面里');
    expect(installHtml).toContain('How do I add SSH Session MCP to Codex CLI?');
    expect(zhInstallHtml).toContain('怎么在 Windows 上给 Claude Code 安装？');
    expect(installHtml).toContain('"@type": "FAQPage"');

    expect(commandsHtml).toContain('SSH Session MCP Commands');
    expect(commandsHtml).toContain('ssh-quick-connect');
    expect(commandsHtml).toContain('ssh-session-mcp-ctl status');
    expect(commandsHtml).toContain('ssh-session-diagnostics');
    expect(zhCommandsHtml).toContain('SSH Session MCP 命令页');
    expect(zhCommandsHtml).toContain('MCP client 真正会调用的工具');
    expect(commandsHtml).toContain('What does `ssh-quick-connect` do?');
    expect(zhCommandsHtml).toContain('什么时候该用 `ssh-command-status`？');
    expect(commandsHtml).toContain('What does ssh-quick-connect do?');

    expect(resourcesHtml).toContain('SSH Session MCP Resources');
    expect(zhResourcesHtml).toContain('SSH Session MCP 资源页');
    expect(resourcesHtml).toContain('MCP registry metadata in server.json');
    expect(resourcesHtml).toContain('https://gitee.com/Zw-awa/ssh-session-mcp');
    expect(resourcesHtml).toContain('https://dev.to/zwawa/i-got-tired-of-splitting-my-brain-between-local-ai-and-remote-ssh-so-i-built-ssh-session-mcp-d0e');
    expect(zhResourcesHtml).toContain('看完链接之后，下一步常见的问题在这些页面里');

    expect(faqHtml).toContain('SSH Session MCP FAQ');
    expect(zhFaqHtml).toContain('SSH Session MCP FAQ');
    expect(faqHtml).toContain('What does input lock solve?');
    expect(zhFaqHtml).toContain('输入锁解决了什么问题？');
    expect(faqHtml).toContain('Why would I want a shared PTY instead of isolated command calls?');
    expect(zhFaqHtml).toContain('为什么 AI 辅助 SSH 工作需要输入锁？');
    expect(faqHtml).toContain('Why does the viewer matter if I already have terminal output?');

    expect(useCasesHtml).toContain('SSH Session MCP Use Cases');
    expect(zhUseCasesHtml).toContain('SSH Session MCP 使用场景');
    expect(useCasesHtml).toContain('Remote debugging on embedded Linux boards');
    expect(useCasesHtml).toContain('Long-running builds, training jobs, and flaky remote work');
    expect(zhUseCasesHtml).toContain('如果你已经理解了这个思路，下一步可以看这些页面');

    expect(compareHtml).toContain('SSH Session MCP Comparison');
    expect(compareHtml).toContain('Normal SSH Wrapper');
    expect(compareHtml).toContain('This is not just another SSH command wrapper');
    expect(zhCompareHtml).toContain('SSH Session MCP 对比');
    expect(zhCompareHtml).toContain('这不只是另一个 SSH 命令包装层');
    expect(compareHtml).toContain('What is the difference between SSH Session MCP and a normal SSH wrapper?');
    expect(zhCompareHtml).toContain('为什么 shared PTY 和输入锁经常要一起出现？');
    expect(compareHtml).toContain('Why is async tracking part of the architecture difference?');

    expect(notFoundHtml).toContain('noindex, nofollow');
    expect(notFoundHtml).toContain('Page not found');
    expect(zhNotFoundHtml).toContain('页面不存在');

    expect(robotsTxt).toContain('User-agent: *');
    expect(robotsTxt).toContain('Sitemap: https://zw-awa.github.io/ssh-session-mcp/sitemap.xml');

    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/install/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/install/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/commands/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/commands/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/resources/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/resources/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/faq/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/faq/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/use-cases/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/use-cases/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/compare/</loc>');
    expect(sitemapXml).toContain('<loc>https://zw-awa.github.io/ssh-session-mcp/zh/compare/</loc>');
    expect(sitemapXml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(sitemapXml).toContain('hreflang="zh-CN"');
    expect(sitemapXml).toContain('hreflang="en"');
    expect(sitemapXml).toContain('<image:loc>https://zw-awa.github.io/ssh-session-mcp/assets/hero-loop.gif</image:loc>');
    expect(sitemapXml).toContain('<changefreq>weekly</changefreq>');
    expect(sitemapXml).toContain('\n  <url>\n    <loc>https://zw-awa.github.io/ssh-session-mcp/');
  });

  it('copies required assets into dist', () => {
    runBuild();

    const logoPath = join(distDir, 'assets', 'logo-monogram-v1.png');
    const gifPath = join(distDir, 'assets', 'hero-loop.gif');

    expect(readFileSync(logoPath).byteLength).toBeGreaterThan(0);
    expect(readFileSync(gifPath).byteLength).toBeGreaterThan(0);
  });
});
