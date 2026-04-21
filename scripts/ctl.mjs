#!/usr/bin/env node

import { exec, execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const BUILD_ENTRY = resolve(ROOT, 'build', 'index.js');

function sanitizeLabel(raw, fallback) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80) || fallback;
}

function resolveInstanceId(raw) {
  return sanitizeLabel(raw || 'default', 'default');
}

function windowsConfigRoot() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

function windowsStateRoot() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

function unixConfigRoot() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function unixStateRoot() {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

function getUserConfigDir() {
  return process.platform === 'win32'
    ? join(windowsConfigRoot(), 'ssh-session-mcp')
    : join(unixConfigRoot(), 'ssh-session-mcp');
}

function getUserStateDir() {
  return process.platform === 'win32'
    ? join(windowsStateRoot(), 'ssh-session-mcp')
    : join(unixStateRoot(), 'ssh-session-mcp');
}

function resolveRuntimePaths(instanceId) {
  const safeInstanceId = resolveInstanceId(instanceId);
  const instanceDir = join(getUserStateDir(), 'instances', safeInstanceId);
  return {
    instanceId: safeInstanceId,
    instanceDir,
    logDir: join(instanceDir, 'logs'),
    serverInfoFile: join(instanceDir, 'server-info.json'),
    viewerStateFile: join(instanceDir, '.viewer-processes.json'),
  };
}

function resolveDefaultConfigPath() {
  return {
    cwdConfigPath: join(ROOT, 'ssh-session-mcp.config.json'),
    userConfigPath: join(getUserConfigDir(), 'config.json'),
  };
}

function loadEnv() {
  const env = {};
  try {
    const content = readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // ignore missing .env
  }
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

function readJson(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function resolveConfigPath(flags, env) {
  const candidate = flags.config || process.env.SSH_MCP_CONFIG || env.SSH_MCP_CONFIG;
  if (candidate) {
    return resolve(candidate);
  }

  const defaults = resolveDefaultConfigPath();
  if (existsSync(defaults.cwdConfigPath)) {
    return defaults.cwdConfigPath;
  }

  if (existsSync(defaults.userConfigPath)) {
    return defaults.userConfigPath;
  }

  return null;
}

function getLogDir(flags, env, runtimePaths) {
  return flags.logDir || process.env.SSH_MCP_LOG_DIR || env.SSH_MCP_LOG_DIR || runtimePaths.logDir;
}

function getRequestedViewerPort(flags, env) {
  return flags.viewerPort || process.env.VIEWER_PORT || env.VIEWER_PORT || 'auto';
}

function getRequestedViewerHost(flags, env) {
  return flags.viewerHost || process.env.VIEWER_HOST || env.VIEWER_HOST || '127.0.0.1';
}

function loadServerInfo(runtimePaths) {
  return readJson(runtimePaths.serverInfoFile);
}

function parseMaybeInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      return null;
    }

    try {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 5000 });
      const pid = parseInt(out.trim().split('\n')[0], 10);
      return pid > 0 ? pid : null;
    } catch {
      const out = execSync(`ss -tlnp sport = :${port}`, { encoding: 'utf8', timeout: 5000 });
      const match = out.match(/pid=(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }
  } catch {
    return null;
  }
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

async function checkExistingServer(serverInfo, flags, env) {
  const viewerHost = serverInfo?.viewerHost || getRequestedViewerHost(flags, env);
  const viewerPort = parseMaybeInt(serverInfo?.viewerPort);
  const pidFromInfo = parseMaybeInt(serverInfo?.pid);
  const pid = isPidAlive(pidFromInfo) ? pidFromInfo : (viewerPort ? findPidOnPort(viewerPort) : null);
  const viewerBaseUrl = serverInfo?.viewerBaseUrl
    || (viewerPort ? `http://${viewerHost}:${viewerPort}` : null);

  if (!pid) {
    return {
      pid: null,
      healthy: false,
      message: 'not running',
      sessions: [],
      viewerBaseUrl,
      viewerHost,
      viewerPort,
    };
  }

  if (!viewerBaseUrl) {
    return {
      pid,
      healthy: false,
      message: 'viewer disabled',
      sessions: [],
      viewerBaseUrl: null,
      viewerHost,
      viewerPort,
    };
  }

  try {
    const health = await fetchJson(`${viewerBaseUrl}/health`);
    const listing = await fetchJson(`${viewerBaseUrl}/api/sessions`);
    return {
      pid,
      healthy: health.ok === true,
      message: 'running',
      sessions: Array.isArray(listing.sessions) ? listing.sessions : [],
      viewerBaseUrl: listing.viewerBaseUrl || health.viewerBaseUrl || viewerBaseUrl,
      viewerHost: viewerHost,
      viewerPort: listing.viewerPort || health.viewerPort || viewerPort,
    };
  } catch (error) {
    return {
      pid,
      healthy: false,
      message: error instanceof Error ? error.message : String(error),
      sessions: [],
      viewerBaseUrl,
      viewerHost,
      viewerPort,
    };
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

  return readFileSync(filePath, 'utf8')
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
  const records = readJsonl(serverLog);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.event !== 'session.opened') continue;
    const data = record.data || {};
    if (
      data.sessionId === sessionRef
      || data.sessionName === sessionRef
      || data.sessionRef === sessionRef
    ) {
      const resolvedPath = join(logDir, 'sessions', `${data.sessionId}.jsonl`);
      if (existsSync(resolvedPath)) {
        return resolvedPath;
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

function parseConfigFile(configPath) {
  const parsed = readJson(configPath);
  if (!parsed || !Array.isArray(parsed.devices)) {
    return null;
  }
  return parsed;
}

function sessionLabel(session) {
  return session.sessionRef || session.sessionName || session.sessionId;
}

function pickSession(state, flags) {
  if (!state.sessions.length) {
    return null;
  }

  const requestedSession = flags.session;
  if (requestedSession) {
    return state.sessions.find(session =>
      session.sessionId === requestedSession
      || session.sessionName === requestedSession
      || session.sessionRef === requestedSession,
    ) || null;
  }

  const requestedDevice = flags.device;
  const requestedConnection = flags.connection || flags.connectionName;
  if (requestedDevice) {
    return state.sessions.find(session =>
      session.deviceId === requestedDevice
      && (!requestedConnection || session.connectionName === requestedConnection),
    ) || null;
  }

  return state.sessions[0];
}

async function cmdStatus(ctx) {
  const serverInfo = loadServerInfo(ctx.runtimePaths);
  const state = await checkExistingServer(serverInfo, ctx.flags, ctx.env);

  console.log(`  Instance:     ${ctx.instanceId}`);
  console.log(`  Runtime dir:  ${ctx.runtimePaths.instanceDir}`);
  console.log(`  Config path:  ${ctx.configPath || '(none, legacy env mode)'}`);

  if (!serverInfo) {
    console.log('  Server:       not running');
    return;
  }

  console.log(`  Viewer:       ${state.viewerBaseUrl || '(disabled)'}`);
  if (!state.pid) {
    console.log('  Server:       not running');
    return;
  }

  console.log(`  Server PID:   ${state.pid} (${state.healthy ? 'running' : 'unhealthy'})`);
  if (!state.healthy) {
    console.log(`  Health:       ${state.message}`);
    return;
  }

  console.log(`  Sessions:     ${state.sessions.length}`);
  for (const session of state.sessions) {
    console.log(`  → ${sessionLabel(session)} (${session.user}@${session.host}:${session.port})`);
    console.log(`    Terminal:   ${state.viewerBaseUrl}/terminal/session/${encodeURIComponent(session.sessionId)}`);
  }
}

function cmdKill(ctx) {
  const serverInfo = loadServerInfo(ctx.runtimePaths);
  const viewerPort = parseMaybeInt(serverInfo?.viewerPort);
  const pidFromInfo = parseMaybeInt(serverInfo?.pid);
  const pid = isPidAlive(pidFromInfo) ? pidFromInfo : (viewerPort ? findPidOnPort(viewerPort) : null);

  if (!pid) {
    console.log(`  No running server for instance "${ctx.instanceId}"`);
    return;
  }

  console.log(`  Killing PID ${pid} for instance "${ctx.instanceId}"...`);
  if (killPid(pid)) {
    console.log('  Done.');
  } else {
    console.log('  Failed to kill process.');
  }
}

function removeFile(path, label) {
  if (!existsSync(path)) {
    return;
  }

  unlinkSync(path);
  console.log(`  Removed ${label}`);
}

function cmdCleanup(ctx) {
  cmdKill(ctx);
  removeFile(ctx.runtimePaths.serverInfoFile, 'server-info.json');
  removeFile(ctx.runtimePaths.viewerStateFile, '.viewer-processes.json');
  console.log('  Cleanup complete.');
}

async function cmdDevices(ctx) {
  const parsed = ctx.configPath ? parseConfigFile(ctx.configPath) : null;
  console.log(`  Instance:     ${ctx.instanceId}`);
  console.log(`  Config path:  ${ctx.configPath || '(none, legacy env mode)'}`);

  if (!parsed) {
    console.log('  Devices:      none');
    console.log(`  Legacy env:   ${ctx.env.SSH_USER || '?'}@${ctx.env.SSH_HOST || '?'}:${ctx.env.SSH_PORT || 22}`);
    return;
  }

  console.log(`  Devices:      ${parsed.devices.length}`);
  for (const device of parsed.devices) {
    const mark = device.id === parsed.defaultDevice ? '*' : ' ';
    console.log(` ${mark} ${device.id} (${device.user}@${device.host}:${device.port || 22})`);
    if (device.label) {
      console.log(`    Label:      ${device.label}`);
    }
    if (Array.isArray(device.tags) && device.tags.length > 0) {
      console.log(`    Tags:       ${device.tags.join(', ')}`);
    }
  }
}

async function cmdLaunch(ctx) {
  const existing = await checkExistingServer(loadServerInfo(ctx.runtimePaths), ctx.flags, ctx.env);
  const reused = pickSession(existing, ctx.flags);

  if (existing.pid && existing.healthy && reused) {
    const url = `${existing.viewerBaseUrl}/terminal/session/${encodeURIComponent(reused.sessionId)}`;
    console.log(`  Reusing server PID ${existing.pid}`);
    console.log(`  Session: ${sessionLabel(reused)}`);
    console.log(`  Terminal: ${url}`);
    openBrowser(url);
    return;
  }

  if (existing.pid) {
    console.log(`  Existing server for instance "${ctx.instanceId}" is ${existing.healthy ? 'idle' : 'unhealthy'} (PID ${existing.pid}). Restarting...`);
    killPid(existing.pid);
    sleepSync(800);
  }

  const childArgs = [BUILD_ENTRY, `--instance=${ctx.instanceId}`];
  if (ctx.configPath) {
    childArgs.push(`--config=${ctx.configPath}`);
  }

  const viewerHost = getRequestedViewerHost(ctx.flags, ctx.env);
  const viewerPort = getRequestedViewerPort(ctx.flags, ctx.env);
  childArgs.push(`--viewerHost=${viewerHost}`);
  childArgs.push(`--viewerPort=${viewerPort}`);

  if (ctx.flags.logDir) {
    childArgs.push(`--logDir=${ctx.flags.logDir}`);
  }
  if (ctx.flags.logMode) {
    childArgs.push(`--logMode=${ctx.flags.logMode}`);
  }
  if (ctx.flags.mode) {
    childArgs.push(`--mode=${ctx.flags.mode}`);
  }

  const child = spawn(process.execPath, childArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: ROOT,
    windowsHide: true,
  });

  let buffer = '';
  let requestId = 0;
  let opened = false;

  function send(method, params = {}, isNotification = false) {
    const payload = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++requestId, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const text = parsed.result?.content?.[0]?.text;
        if (!text || opened) continue;

        const inner = JSON.parse(text);
        const session = inner.session || inner;
        const sessionId = session.sessionId || inner.sessionId;
        if (!sessionId) continue;

        opened = true;
        const terminalUrl = inner.terminalUrl
          || inner.autoOpenTerminalUrl
          || (inner.viewerBaseUrl ? `${inner.viewerBaseUrl}/terminal/session/${encodeURIComponent(sessionId)}` : null);
        console.log(`\n  SSH connected: ${session.user}@${session.host}`);
        console.log(`  Session: ${sessionLabel(session)}`);
        if (terminalUrl) {
          console.log(`  Terminal: ${terminalUrl}\n`);
          openBrowser(terminalUrl);
        } else {
          console.log('  Terminal: viewer disabled\n');
        }
      } catch {
        // ignore non-tool output
      }
    }
  });

  child.on('exit', code => {
    console.log('  Server stopped.');
    process.exit(code || 0);
  });

  const toolArgs = {};
  if (ctx.flags.session) toolArgs.sessionName = ctx.flags.session;
  if (ctx.flags.device) toolArgs.device = ctx.flags.device;
  if (ctx.flags.connection || ctx.flags.connectionName) {
    toolArgs.connectionName = ctx.flags.connection || ctx.flags.connectionName;
  }

  send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ctl-launch', version: '2.4.0' },
  });
  setTimeout(() => send('notifications/initialized', {}, true), 300);
  setTimeout(() => {
    console.log(`  Launching instance "${ctx.instanceId}"...`);
    send('tools/call', { name: 'ssh-quick-connect', arguments: toolArgs });
  }, 800);

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
  });
}

async function cmdLogs(ctx) {
  const logDir = getLogDir(ctx.flags, ctx.env, ctx.runtimePaths);
  const tail = Math.max(0, parseInt(ctx.flags.tail || '40', 10) || 40);
  const follow = ctx.flags.follow === 'true';
  const sessionRef = ctx.flags.session;
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

  await new Promise(resolvePromise => {
    process.on('SIGINT', () => {
      clearInterval(timer);
      resolvePromise();
    });
  });
}

const rawArgs = process.argv.slice(2);
const cmd = rawArgs[0] || 'status';
const flags = parseFlags(rawArgs.slice(1));
const env = loadEnv();
const instanceId = resolveInstanceId(flags.instance || process.env.SSH_MCP_INSTANCE || env.SSH_MCP_INSTANCE || 'default');
const runtimePaths = resolveRuntimePaths(instanceId);
const configPath = resolveConfigPath(flags, env);
const context = { configPath, env, flags, instanceId, runtimePaths };

const commands = {
  cleanup: () => cmdCleanup(context),
  devices: () => cmdDevices(context),
  kill: () => cmdKill(context),
  launch: () => cmdLaunch(context),
  logs: () => cmdLogs(context),
  status: () => cmdStatus(context),
};

if (!commands[cmd]) {
  console.log('Usage: node scripts/ctl.mjs <command> [--flags]\n');
  console.log('Commands:');
  console.log('  status   - check instance/server/session status');
  console.log('  devices  - list configured device profiles');
  console.log('  kill     - kill the server for one instance');
  console.log('  cleanup  - kill + remove runtime state files');
  console.log('  launch   - start or reuse server + connect/open terminal');
  console.log('  logs     - show server/session JSONL logs');
  console.log('\nFlags:');
  console.log('  --instance=<id>      default: default');
  console.log('  --config=<path>      explicit config file');
  console.log('  --device=<id>        device profile for launch');
  console.log('  --connection=<name>  profile connection name for launch');
  console.log('  --session=<name>     logical session name for launch/logs');
  process.exit(1);
}

await commands[cmd]();
