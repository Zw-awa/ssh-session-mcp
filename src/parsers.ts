import { stripAnsi } from './shared.js';

// --- Structured command parsers ---

export interface ParsedOutput {
  type: string;
  data: unknown;
  raw: string;
}

// --- git status parser ---

interface GitStatusResult {
  branch: string;
  ahead?: number;
  behind?: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
}

function parseGitStatus(output: string): GitStatusResult | null {
  const lines = stripAnsi(output).split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const result: GitStatusResult = { branch: '', staged: [], modified: [], untracked: [], deleted: [] };

  for (const line of lines) {
    const branchMatch = line.match(/^On branch (.+)/);
    if (branchMatch) { result.branch = branchMatch[1]; continue; }

    const aheadBehind = line.match(/Your branch is ahead.*?by (\d+)/);
    if (aheadBehind) { result.ahead = parseInt(aheadBehind[1]); continue; }

    const behind = line.match(/Your branch is behind.*?by (\d+)/);
    if (behind) { result.behind = parseInt(behind[1]); continue; }

    // Short format: XY filename
    const shortMatch = line.match(/^(.)(.) (.+)$/);
    if (shortMatch) {
      const [, x, y, file] = shortMatch;
      if (x === '?' && y === '?') { result.untracked.push(file); continue; }
      if (x !== ' ' && x !== '?') result.staged.push(file);
      if (y === 'M') result.modified.push(file);
      if (y === 'D') result.deleted.push(file);
      continue;
    }

    // Long format
    if (line.match(/^\s+modified:/)) {
      const f = line.replace(/^\s+modified:\s+/, '');
      result.modified.push(f);
    } else if (line.match(/^\s+new file:/)) {
      const f = line.replace(/^\s+new file:\s+/, '');
      result.staged.push(f);
    } else if (line.match(/^\s+deleted:/)) {
      const f = line.replace(/^\s+deleted:\s+/, '');
      result.deleted.push(f);
    }
  }

  return result;
}

// --- git log parser ---

interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

function parseGitLog(output: string): GitLogEntry[] | null {
  const lines = stripAnsi(output).split('\n');
  const entries: GitLogEntry[] = [];
  let current: Partial<GitLogEntry> = {};

  for (const line of lines) {
    const commitMatch = line.match(/^commit ([a-f0-9]+)/);
    if (commitMatch) {
      if (current.hash) entries.push(current as GitLogEntry);
      current = { hash: commitMatch[1], message: '' };
      continue;
    }
    const authorMatch = line.match(/^Author:\s+(.+)/);
    if (authorMatch) { current.author = authorMatch[1]; continue; }
    const dateMatch = line.match(/^Date:\s+(.+)/);
    if (dateMatch) { current.date = dateMatch[1].trim(); continue; }
    if (line.startsWith('    ') && current.hash) {
      current.message = (current.message || '') + line.trim() + ' ';
    }
  }
  if (current.hash) entries.push(current as GitLogEntry);

  return entries.length > 0 ? entries : null;
}

// --- ls -la parser ---

interface LsEntry {
  permissions: string;
  links: number;
  owner: string;
  group: string;
  size: number;
  date: string;
  name: string;
  type: 'file' | 'directory' | 'link' | 'other';
}

function parseLsLa(output: string): LsEntry[] | null {
  const lines = stripAnsi(output).split('\n').filter(l => l.trim());
  const entries: LsEntry[] = [];

  for (const line of lines) {
    if (line.startsWith('total ')) continue;
    const match = line.match(/^([drwxlsStT-]{10})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
    if (!match) continue;
    const [, permissions, links, owner, group, size, date, name] = match;
    const type = permissions[0] === 'd' ? 'directory' : permissions[0] === 'l' ? 'link' : permissions[0] === '-' ? 'file' : 'other';
    entries.push({ permissions, links: parseInt(links), owner, group, size: parseInt(size), date, name, type });
  }

  return entries.length > 0 ? entries : null;
}

// --- Main parser dispatcher ---

const PARSER_MAP: Array<{ pattern: RegExp; type: string; parse: (output: string) => unknown }> = [
  { pattern: /^\s*git\s+status\b/, type: 'git_status', parse: parseGitStatus },
  { pattern: /^\s*git\s+log\b/, type: 'git_log', parse: parseGitLog },
  { pattern: /^\s*ls\s+.*-[a-zA-Z]*l/, type: 'ls_la', parse: parseLsLa },
];

export function tryParseCommandOutput(command: string, output: string): ParsedOutput | null {
  for (const { pattern, type, parse } of PARSER_MAP) {
    if (pattern.test(command)) {
      const data = parse(output);
      if (data) return { type, data, raw: output };
      return null;
    }
  }
  return null;
}
