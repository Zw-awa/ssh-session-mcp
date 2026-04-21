#!/usr/bin/env node

// ssh-mcp-ctl: unified CLI for common operations
// Usage:
//   node scripts/ctl.mjs status
//   node scripts/ctl.mjs kill
//   node scripts/ctl.mjs launch
//   node scripts/ctl.mjs cleanup
//   node scripts/ctl.mjs logs --tail=40 [--session=<id|name>] [--follow]

import { execSync, spawn, exec } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const VIEWER_STATE = resolve(ROOT, '.viewer-processes.json');
const BUILD_ENTRY = resolve(ROOT, 'build', 'index.js');
const DEFAULT_LOG_DIR = resolve(ROOT, 'logs', 'session-mcp');

function loadEnv() {
  const env = {};
  try {
    const content = readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch {}
  return env;
}

function parseFlags(argv) {
  const flags = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) {
      flags[raw.slice(2)] = 'true';
    } else {
      flags[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return flags;
}

function getViewerPort() {
  const env = loadEnv();
  return parseInt(env.VIEWER_PORT || process.env.VIEWER_PORT || '8793', 10);
}

function getViewerHost() {
  const env = loadEnv();
  return env.VIEWER_HOST || process.env.VIEWER_HOST || '127.0.0.1';
}

function getLogDir() {
  const env = loadEnv();
  return env.SSH_MCP_LOG_DIR || process.env.SSH_MCP_LOG_DIR || DEFAULT_LOG_DIR;
}

function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) return pid;
        }
      }
    } else {
      try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 5000 });
        const pid = parseInt(out.trim().split('\n')[0], 10);
        if (pid > 0) return pid;
      } catch {
        const out = execSync(`ss -tlnp sport = :${port}`, { encoding: 'utf8', timeout: 5000 });
        const match = out.match(/pid=(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
    }
  } catch {}
  return null;
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function checkExistingServer(host, port) {
  const pid = findPidOnPort(port);
  if (!pid) {
    return { pid: null, healthy: false, sessions: [] };
  }

  try {
    const health = await fetchJson(`http://${host}:${port}/health`);
    const listing = await fetchJson(`http://${host}:${port}/api/sessions`);
    return {
      pid,
      healthy: health.ok === true,
      sessions: Array.isArray(listing.sessions) ? listing.sessions : [],
    };
  } catch {
    return { pid, healthy: false, sessions: [] };
  }
}

function renderLogRecord(record) {
  const prefix = record.scope === 'session'
    ? `[session:${record.sessionId || '?'}]`
    : '[server]';
  const data = record.data && Object.keys(record.data).length > 0
    ? ` ${JSON.stringify(record.data)}`
    : '';
  return `${record.at} ${prefix} ${record.event}${data}`;
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resolveSessionLogPath(logDir, sessionRef) {
  const byId = join(logDir, 'sessions', `${sessionRef}.jsonl`);
  if (existsSync(byId)) {
    return byId;
  }

  const serverLog = join(logDir, 'server.jsonl');
  const serverRecords = readJsonl(serverLog);
  for (let idx = serverRecords.length - 1; idx >= 0; idx -= 1) {
    const record = serverRecords[idx];
    if (record?.event !== 'session.opened') continue;
    const data = record.data || {};
    if (data.sessionId === sessionRef || data.sessionName === sessionRef) {
      const filePath = join(logDir, 'sessions', `${data.sessionId}.jsonl`);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return byId;
}

function printRenderedRecords(records, tail) {
  const rendered = records.map(renderLogRecord);
  const visible = tail > 0 ? rendered.slice(-tail) : rendered;
  for (const line of visible) {
    console.log(line);
  }
}

async function cmdStatus() {
  const port = getViewerPort();
  const host = getViewerHost();
  const env = loadEnv();
  const state = await checkExistingServer(host, port);

  console.log(`  Viewer port: ${port}`);
  console.log(`  SSH target:  ${env.SSH_USER || '?'}@${env.SSH_HOST || '?'}:${env.SSH_PORT || 22}`);

  if (!state.pid) {
    console.log('  Server:      not running');
    return;
  }

  console.log(`  Server PID:  ${state.pid} (${state.healthy ? 'running' : 'unhealthy'})`);
  if (!state.healthy) {
    console.log('  Health:      failed');
    return;
  }

  console.log(`  Sessions:    ${state.sessions.length}`);
  for (const s of state.sessions) {
    console.log(`  → ${s.sessionName || s.sessionId} (${s.user}@${s.host}:${s.port})`);
    console.log(`    Terminal: http://${host}:${port}/terminal/session/${encodeURIComponent(s.sessionId)}`);
  }
}

function cmdKill() {
  const port = getViewerPort();
  const pid = findPidOnPort(port);
  if (!pid) {
    console.log(`  No process on port ${port}`);
    return;
  }
  console.log(`  Killing PID ${pid} on port ${port}...`);
  if (killPid(pid)) {
    console.log('  Done.');
  } else {
    console.log('  Failed to kill process.');
  }
}

function cmdCleanup() {
  cmdKill();
  if (existsSync(VIEWER_STATE)) {
    unlinkSync(VIEWER_STATE);
    console.log('  Removed .viewer-processes.json');
  }
  console.log('  Cleanup complete.');
}

async function cmdLaunch() {
  const port = getViewerPort();
  const host = getViewerHost();
  const existing = await checkExistingServer(host, port);

  if (existing.pid && existing.healthy && existing.sessions.length > 0) {
    const session = existing.sessions[0];
    const url = `http://${host}:${port}/terminal/session/${encodeURIComponent(session.sessionId)}`;
    console.log(`  Reusing existing server PID ${existing.pid}`);
    console.log(`  Session: ${session.sessionName || session.sessionId}`);
    console.log(`  Terminal: ${url}`);
    openBrowser(url);
    return;
  }

  if (existing.pid) {
    console.log(`  Existing process on port ${port} is ${existing.healthy ? 'idle' : 'unhealthy'} (PID ${existing.pid}). Restarting...`);
    killPid(existing.pid);
    sleepSync(800);
  }

  const child = spawn(process.execPath, [BUILD_ENTRY], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: ROOT,
    windowsHide: true,
  });

  let buffer = '';
  let idCounter = 0;
  let opened = false;

  function send(method, params = {}, isNotif = false) {
    const msg = isNotif
      ? JSON.stringify({ jsonrpc: '2.0', method, params })
      : JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params });
    child.stdin.write(`${msg}\n`);
  }

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.result?.content?.[0]?.text && !opened) {
          const inner = JSON.parse(parsed.result.content[0].text);
          if (inner.sessionId) {
            opened = true;
            const url = inner.terminalUrl
              || `http://${host}:${port}/terminal/session/${encodeURIComponent(inner.sessionId)}`;
            console.log(`\n  SSH connected: ${inner.user}@${inner.host}`);
            console.log(`  Session: ${inner.sessionName || inner.sessionId}`);
            console.log(`  Terminal: ${url}\n`);
            openBrowser(url);
            console.log('  Browser opened. Press Ctrl+C to stop.\n');
          }
        }
      } catch {}
    }
  });

  child.on('exit', code => {
    console.log('  Server stopped.');
    process.exit(code || 0);
  });

  send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ctl-launch', version: '1.0' } });
  setTimeout(() => send('notifications/initialized', {}, true), 300);
  setTimeout(() => {
    console.log('  Connecting...');
    send('tools/call', { name: 'ssh-quick-connect', arguments: {} });
  }, 800);

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
  });
}

async function cmdLogs(flags) {
  const logDir = getLogDir();
  const tail = Math.max(0, parseInt(flags.tail || '40', 10) || 40);
  const follow = flags.follow === 'true';
  const sessionRef = flags.session;
  const filePath = sessionRef
    ? resolveSessionLogPath(logDir, sessionRef)
    : join(logDir, 'server.jsonl');

  if (!existsSync(filePath)) {
    console.log(`  No log file: ${filePath}`);
    return;
  }

  let renderedCount = 0;

  const printNow = () => {
    const records = readJsonl(filePath);
    if (renderedCount === 0) {
      printRenderedRecords(records, tail);
      renderedCount = records.length;
      return;
    }

    const next = records.slice(renderedCount);
    for (const record of next) {
      console.log(renderLogRecord(record));
    }
    renderedCount = records.length;
  };

  printNow();

  if (!follow) {
    return;
  }

  console.log('  Following log output. Press Ctrl+C to stop.');
  const timer = setInterval(() => {
    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        printNow();
      }
    } catch {
      // ignore transient file errors
    }
  }, 1000);

  await new Promise(resolve => {
    process.on('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
}

const rawArgs = process.argv.slice(2);
const cmd = rawArgs[0] || 'status';
const flags = parseFlags(rawArgs.slice(1));

const commands = {
  status: () => cmdStatus(),
  kill: () => cmdKill(),
  cleanup: () => cmdCleanup(),
  launch: () => cmdLaunch(),
  logs: () => cmdLogs(flags),
};

if (!commands[cmd]) {
  console.log('Usage: node scripts/ctl.mjs <command> [--flags]\n');
  console.log('Commands:');
  console.log('  status   - check server and session status');
  console.log('  kill     - kill process on viewer port');
  console.log('  cleanup  - kill + remove state files');
  console.log('  launch   - start or reuse server + open browser terminal');
  console.log('  logs     - show server/session JSONL logs');
  process.exit(1);
}

await commands[cmd]();
