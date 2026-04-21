import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfigFile } from './profiles.js';

const REQUIRED_FILES = [
  '.env.example',
  'AI_AGENT_GUIDE.md',
  'README.md',
  'README.zh-CN.md',
  'docs/contracts.md',
  'docs/failure-taxonomy.md',
  'docs/acceptance-scenarios.md',
  'docs/platform-compatibility.md',
  'docs/examples/ssh-session-mcp.config.example.json',
  'src/index.ts',
] as const;

const REQUIRED_SCENARIO_IDS = [
  'single-device-default-connection',
  'dual-device-single-instance-switch',
  'single-device-multi-connection-selection',
  'multi-ai-multi-instance-isolation',
  'viewer-port-auto-allocation',
  'runtime-state-cleanup-on-exit',
  'input-lock-user-blocks-agent',
  'ambiguous-active-session-blocks-default-targeting',
] as const;

function readText(path: string) {
  return readFileSync(path, 'utf8');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractMcpToolNames(source: string) {
  const matches = [...source.matchAll(/server\.tool\(\s*'([^']+)'/g)];
  return [...new Set(matches.map(match => match[1]).sort())];
}

export function findMissingToolMentions(text: string, toolNames: string[]) {
  return toolNames.filter(toolName => {
    const pattern = new RegExp(`(?:\`|\\b)${escapeRegExp(toolName)}(?:\`|\\b)`);
    return !pattern.test(text);
  });
}

export function validateRepository(rootDir: string) {
  const failures: string[] = [];

  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(join(rootDir, relativePath))) {
      failures.push(`Missing required file: ${relativePath}`);
    }
  }

  const readmePath = join(rootDir, 'README.md');
  const readmeZhPath = join(rootDir, 'README.zh-CN.md');
  const aiGuidePath = join(rootDir, 'AI_AGENT_GUIDE.md');
  const indexPath = join(rootDir, 'src/index.ts');
  const acceptanceScenariosPath = join(rootDir, 'docs/acceptance-scenarios.md');
  const exampleConfigPath = join(rootDir, 'docs/examples/ssh-session-mcp.config.example.json');
  const envExamplePath = join(rootDir, '.env.example');

  if (existsSync(readmePath) && existsSync(readmeZhPath)) {
    const readme = readText(readmePath);
    const readmeZh = readText(readmeZhPath);
    if (!readme.includes('README.zh-CN.md')) {
      failures.push('README.md must link to README.zh-CN.md');
    }
    if (!readmeZh.includes('README.md')) {
      failures.push('README.zh-CN.md must link to README.md');
    }
  }

  if (existsSync(indexPath) && existsSync(readmePath) && existsSync(readmeZhPath) && existsSync(aiGuidePath)) {
    const toolNames = extractMcpToolNames(readText(indexPath));
    const docs = [
      { label: 'README.md', text: readText(readmePath) },
      { label: 'README.zh-CN.md', text: readText(readmeZhPath) },
      { label: 'AI_AGENT_GUIDE.md', text: readText(aiGuidePath) },
    ];

    for (const doc of docs) {
      const missing = findMissingToolMentions(doc.text, toolNames);
      if (missing.length > 0) {
        failures.push(`${doc.label} is missing MCP tool references: ${missing.join(', ')}`);
      }
    }
  }

  if (existsSync(acceptanceScenariosPath)) {
    const text = readText(acceptanceScenariosPath);
    for (const scenarioId of REQUIRED_SCENARIO_IDS) {
      if (!text.includes(scenarioId)) {
        failures.push(`docs/acceptance-scenarios.md is missing scenario id: ${scenarioId}`);
      }
    }
  }

  if (existsSync(exampleConfigPath)) {
    try {
      loadConfigFile(exampleConfigPath);
    } catch (error) {
      failures.push(`Example config failed schema validation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (existsSync(envExamplePath)) {
    const text = readText(envExamplePath);
    for (const token of ['SSH_MCP_INSTANCE', 'SSH_MCP_CONFIG', 'VIEWER_PORT=auto']) {
      if (!text.includes(token)) {
        failures.push(`.env.example is missing required token: ${token}`);
      }
    }
  }

  return failures;
}
