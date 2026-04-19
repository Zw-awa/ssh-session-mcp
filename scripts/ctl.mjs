#!/usr/bin/env node

// ssh-mcp-ctl: unified CLI for common operations
// Usage:
//   node scripts/ctl.mjs status     - check if server/sessions are running
//   node scripts/ctl.mjs kill       - kill any process on viewer port
//   node scripts/ctl.mjs launch     - start MCP + open browser terminal
//   node scripts/ctl.mjs cleanup    - kill leftover processes and clean state files

import { execSync, spawn, exec } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const VIEWER_STATE = resolve(ROOT, '.viewer-processes.json');
const BUILD_ENTRY = resolve(ROOT, 'build', 'index.js');

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

function getViewerPort() {
  const env = loadEnv();
  return parseInt(env.VIEWER_PORT || process.env.VIEWER_PORT || '8793', 10);
}

function getViewerHost() {
  const env = loadEnv();
  return env.VIEWER_HOST || process.env.VIEWER_HOST || '127.0.0.1';
}

// ── Cross-platform port/process helpers ──

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
      // macOS / Linux: use lsof
      try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 5000 });
        const pid = parseInt(out.trim().split('\n')[0], 10);
        if (pid > 0) return pid;
      } catch {
        // lsof not available or no match, try ss
        try {
          const out = execSync(`ss -tlnp sport = :${port}`, { encoding: 'utf8', timeout: 5000 });
          const match = out.match(/pid=(\d+)/);
          if (match) return parseInt(match[1], 10);
        } catch {}
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
  } catch { return false; }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

function openBrowser(url) {
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

// ── Commands ──

function cmdStatus() {
  const port = getViewerPort();
  const host = getViewerHost();
  const pid = findPidOnPort(port);
  const env = loadEnv();

  console.log(`  Viewer port: ${port}`);
  console.log(`  SSH target:  ${env.SSH_USER || '?'}@${env.SSH_HOST || '?'}:${env.SSH_PORT || 22}`);

  if (pid) {
    console.log(`  Server PID:  ${pid} (running)`);
    fetch(`http://${host}:${port}/health`)
      .then(r => r.json())
      .then(d => {
        console.log(`  Sessions:    ${d.sessions}`);
        if (d.sessions > 0) {
          return fetch(`http://${host}:${port}/api/sessions`).then(r => r.json());
        }
      })
      .then(d => {
        if (d?.sessions) {
          for (const s of d.sessions) {
            console.log(`  → ${s.sessionName || s.sessionId} (${s.user}@${s.host}:${s.port})`);
            console.log(`    Terminal: http://${host}:${port}/terminal/session/${encodeURIComponent(s.sessionId)}`);
          }
        }
      })
      .catch(() => console.log('  Health check failed'));
  } else {
    console.log('  Server:      not running');
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

function cmdLaunch() {
  const port = getViewerPort();
  const host = getViewerHost();
  const existingPid = findPidOnPort(port);
  if (existingPid) {
    console.log(`  Port ${port} already in use (PID ${existingPid}). Killing...`);
    killPid(existingPid);
    sleepSync(1000);
  }

  const child = spawn(process.execPath, [BUILD_ENTRY], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: ROOT,
  });

  let buffer = '';
  let idCounter = 0;
  let opened = false;

  function send(method, params = {}, isNotif = false) {
    const msg = isNotif
      ? JSON.stringify({ jsonrpc: '2.0', method, params })
      : JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params });
    child.stdin.write(msg + '\n');
  }

  child.stdout.on('data', (chunk) => {
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

  child.on('exit', (code) => { console.log('  Server stopped.'); process.exit(code || 0); });

  send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ctl-launch', version: '1.0' } });
  setTimeout(() => send('notifications/initialized', {}, true), 300);
  setTimeout(() => {
    console.log('  Connecting...');
    send('tools/call', { name: 'ssh-quick-connect', arguments: {} });
  }, 800);

  process.on('SIGINT', () => { console.log('\n  Shutting down...'); child.kill('SIGTERM'); setTimeout(() => process.exit(0), 1000); });
}

// ── Main ──

const cmd = process.argv[2] || 'status';
const commands = { status: cmdStatus, kill: cmdKill, cleanup: cmdCleanup, launch: cmdLaunch };

if (!commands[cmd]) {
  console.log('Usage: node scripts/ctl.mjs <command>\n');
  console.log('Commands:');
  console.log('  status   - check server and session status');
  console.log('  kill     - kill process on viewer port');
  console.log('  cleanup  - kill + remove state files');
  console.log('  launch   - start MCP server + open browser terminal');
  process.exit(1);
}

commands[cmd]();
