#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  delay,
  normalizePaneText,
  renderSplitDashboard,
  renderTranscriptEvent,
  sanitizeActor,
  sanitizeNonNegativeInt,
  sanitizeOptionalText,
  sanitizePort,
  sanitizePositiveInt,
  sanitizeRequiredText,
} from './shared.js';
import {
  SSHConnection,
  SSHSession,
  type SSHConfig,
  type SessionTuning,
} from './session.js';

function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const equalIndex = arg.indexOf('=');
    if (equalIndex === -1) {
      config[arg.slice(2)] = null;
    } else {
      config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
    }
  }

  return config;
}

const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = isCliEnabled ? parseArgv() : {} as Record<string, string>;

const DEFAULT_HOST = argvConfig.host;
const DEFAULT_PORT = argvConfig.port ? parseInt(argvConfig.port, 10) : 22;
const DEFAULT_USER = argvConfig.user;
const DEFAULT_PASSWORD = argvConfig.password;
const DEFAULT_KEY = argvConfig.key;
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout, 10) : 30 * 60 * 1000;
const DEFAULT_COLS = argvConfig.cols ? parseInt(argvConfig.cols, 10) : 120;
const DEFAULT_ROWS = argvConfig.rows ? parseInt(argvConfig.rows, 10) : 40;
const DEFAULT_TERM = argvConfig.term || 'xterm-256color';
const MAX_BUFFER_CHARS = argvConfig.maxBufferChars ? parseInt(argvConfig.maxBufferChars, 10) : 200000;
const DEFAULT_READ_CHARS = argvConfig.defaultReadChars ? parseInt(argvConfig.defaultReadChars, 10) : 4000;
const DEFAULT_IDLE_SWEEP_MS = argvConfig.idleSweepMs ? parseInt(argvConfig.idleSweepMs, 10) : 5000;
const DEFAULT_CLOSED_RETENTION_MS = argvConfig.closedRetentionMs ? parseInt(argvConfig.closedRetentionMs, 10) : 5 * 60 * 1000;
const MAX_TRANSCRIPT_EVENTS = argvConfig.maxTranscriptEvents ? parseInt(argvConfig.maxTranscriptEvents, 10) : 2000;
const MAX_TRANSCRIPT_CHARS = argvConfig.maxTranscriptChars ? parseInt(argvConfig.maxTranscriptChars, 10) : 200000;
const MAX_TRANSCRIPT_EVENT_CHARS = Math.min(MAX_TRANSCRIPT_CHARS, 40000);
const DEFAULT_WATCH_WAIT_MS = argvConfig.defaultWatchWaitMs ? parseInt(argvConfig.defaultWatchWaitMs, 10) : 5000;
const DEFAULT_DASHBOARD_WIDTH = argvConfig.defaultDashboardWidth ? parseInt(argvConfig.defaultDashboardWidth, 10) : 140;
const DEFAULT_DASHBOARD_HEIGHT = argvConfig.defaultDashboardHeight ? parseInt(argvConfig.defaultDashboardHeight, 10) : 24;
const DEFAULT_DASHBOARD_LEFT_CHARS = argvConfig.defaultDashboardLeftChars ? parseInt(argvConfig.defaultDashboardLeftChars, 10) : 12000;
const DEFAULT_DASHBOARD_RIGHT_EVENTS = argvConfig.defaultDashboardRightEvents ? parseInt(argvConfig.defaultDashboardRightEvents, 10) : 40;
const DEFAULT_VIEWER_HOST = argvConfig.viewerHost || '127.0.0.1';
const DEFAULT_VIEWER_PORT = argvConfig.viewerPort ? parseInt(argvConfig.viewerPort, 10) : 0;
const DEFAULT_VIEWER_REFRESH_MS = argvConfig.viewerRefreshMs ? parseInt(argvConfig.viewerRefreshMs, 10) : 1000;
const SSH_CONNECT_TIMEOUT_MS = 30000;
const VIEWER_STATE_FILE = new URL('../.viewer-processes.json', import.meta.url);
const VIEWER_CLI_ENTRY_PATH = fileURLToPath(new URL('./viewer-cli.js', import.meta.url));

type ViewerLaunchMode = 'terminal' | 'browser';
type ViewerSingletonScope = 'connection' | 'session';

interface ViewerProcessState {
  bindingKey: string;
  pid?: number;
  mode: ViewerLaunchMode;
  sessionId: string;
  host: string;
  port: number;
  user: string;
  title: string;
  url: string;
  scope: ViewerSingletonScope;
  createdAt: string;
  updatedAt: string;
}

interface ViewerBindingState {
  bindingKey: string;
  connectionKey: string;
  host: string;
  port: number;
  user: string;
  sessionId: string;
  scope: ViewerSingletonScope;
  updatedAt: string;
}

const viewerProcesses = new Map<string, ViewerProcessState>();
const viewerBindings = new Map<string, ViewerBindingState>();
let viewerServer: HttpServer | undefined;
let viewerStateLoaded = false;

function validateConfig(config: Record<string, string | null>) {
  const numericFields = [
    'port',
    'timeout',
    'cols',
    'rows',
    'maxBufferChars',
    'defaultReadChars',
    'idleSweepMs',
    'closedRetentionMs',
    'maxTranscriptEvents',
    'maxTranscriptChars',
    'defaultWatchWaitMs',
    'defaultDashboardWidth',
    'defaultDashboardHeight',
    'defaultDashboardLeftChars',
    'defaultDashboardRightEvents',
    'viewerPort',
    'viewerRefreshMs',
  ];

  const errors = numericFields
    .filter(field => config[field] && Number.isNaN(Number(config[field])))
    .map(field => `Invalid --${field}`);

  if (config.viewerPort) {
    const viewerPort = Number(config.viewerPort);
    if (!Number.isInteger(viewerPort) || viewerPort < 0 || viewerPort > 65535) {
      errors.push('Invalid --viewerPort');
    }
  }

  if (config.viewerRefreshMs) {
    const viewerRefreshMs = Number(config.viewerRefreshMs);
    if (!Number.isInteger(viewerRefreshMs) || viewerRefreshMs <= 0) {
      errors.push('Invalid --viewerRefreshMs');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration error:\n${errors.join('\n')}`);
  }
}

function viewerScopeValue(value: string | undefined): ViewerSingletonScope {
  return value === 'session' ? 'session' : 'connection';
}

function viewerModeValue(value: string | undefined): ViewerLaunchMode {
  return value === 'browser' ? 'browser' : 'terminal';
}

function buildConnectionKey(host: string, port: number, user: string) {
  return `${user}@${host}:${port}`;
}

function buildViewerBindingKeyForSession(session: SSHSession, scope: ViewerSingletonScope) {
  if (scope === 'session') {
    return `session:${session.sessionId}`;
  }

  return `connection:${buildConnectionKey(session.host, session.port, session.user)}`;
}

function buildViewerBindingTitle(host: string, port: number, user: string) {
  return `SSH Session MCP Viewer - ${user}@${host}:${port}`;
}

function buildViewerBindingUrl(bindingKey: string) {
  const baseUrl = getViewerBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  return `${baseUrl}/binding/${encodeURIComponent(bindingKey)}`;
}

function viewerProcessAlive(pid: number | undefined) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeViewerProcessState(value: unknown): ViewerProcessState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.bindingKey !== 'string' ||
    typeof candidate.mode !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.host !== 'string' ||
    typeof candidate.port !== 'number' ||
    typeof candidate.user !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.url !== 'string' ||
    typeof candidate.scope !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return undefined;
  }

  const mode = viewerModeValue(candidate.mode);
  const scope = viewerScopeValue(candidate.scope);
  const pid = typeof candidate.pid === 'number' ? candidate.pid : undefined;

  return {
    bindingKey: candidate.bindingKey,
    pid,
    mode,
    sessionId: candidate.sessionId,
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    title: candidate.title,
    url: candidate.url,
    scope,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

async function saveViewerProcessState() {
  const records = [...viewerProcesses.values()];
  await fs.writeFile(VIEWER_STATE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

async function loadViewerProcessState() {
  if (viewerStateLoaded) {
    return;
  }

  viewerStateLoaded = true;

  try {
    const raw = await fs.readFile(VIEWER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : [];
    let pruned = false;

    for (const item of values) {
      const state = normalizeViewerProcessState(item);
      if (!state) {
        pruned = true;
        continue;
      }

      if (state.mode === 'terminal' && state.pid && !viewerProcessAlive(state.pid)) {
        pruned = true;
        continue;
      }

      viewerProcesses.set(state.bindingKey, state);
    }

    if (pruned) {
      await saveViewerProcessState();
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function refreshViewerProcessState(bindingKey: string) {
  await loadViewerProcessState();

  const existing = viewerProcesses.get(bindingKey);
  if (!existing) {
    return undefined;
  }

  if (existing.mode === 'terminal' && existing.pid && !viewerProcessAlive(existing.pid)) {
    viewerProcesses.delete(bindingKey);
    await saveViewerProcessState();
    return undefined;
  }

  return existing;
}

function upsertViewerBinding(session: SSHSession, scope: ViewerSingletonScope) {
  const connectionKey = buildConnectionKey(session.host, session.port, session.user);
  const bindingKey = buildViewerBindingKeyForSession(session, scope);
  const updatedAt = new Date().toISOString();

  const binding: ViewerBindingState = {
    bindingKey,
    connectionKey,
    host: session.host,
    port: session.port,
    user: session.user,
    sessionId: session.sessionId,
    scope,
    updatedAt,
  };

  viewerBindings.set(bindingKey, binding);
  return binding;
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

const tuning: SessionTuning = {
  maxBufferChars: MAX_BUFFER_CHARS,
  defaultReadChars: DEFAULT_READ_CHARS,
  maxTranscriptEvents: MAX_TRANSCRIPT_EVENTS,
  maxTranscriptChars: MAX_TRANSCRIPT_CHARS,
  maxTranscriptEventChars: MAX_TRANSCRIPT_EVENT_CHARS,
  defaultDashboardRightEvents: DEFAULT_DASHBOARD_RIGHT_EVENTS,
  defaultDashboardLeftChars: DEFAULT_DASHBOARD_LEFT_CHARS,
};

const sessions = new Map<string, SSHSession>();

function sweepSessions(nowMs = Date.now()) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.shouldCloseForIdle(nowMs)) {
      session.finalize(`idle timeout after ${session.idleTimeoutMs}ms without input/output`);
      continue;
    }

    if (session.shouldPrune(nowMs)) {
      sessions.delete(sessionId);
    }
  }
}

function resolveSession(sessionRef: string): SSHSession {
  sweepSessions();

  if (sessions.has(sessionRef)) {
    return sessions.get(sessionRef)!;
  }

  const allMatches = [...sessions.values()].filter(session => session.sessionName === sessionRef);
  const activeMatches = allMatches.filter(session => !session.closed);

  if (activeMatches.length === 1) {
    return activeMatches[0];
  }

  if (activeMatches.length > 1) {
    throw new McpError(ErrorCode.InvalidParams, `Multiple active sessions share the name "${sessionRef}". Use the sessionId instead.`);
  }

  if (allMatches.length === 1) {
    return allMatches[0];
  }

  if (allMatches.length > 1) {
    throw new McpError(ErrorCode.InvalidParams, `Multiple retained sessions share the name "${sessionRef}". Use the sessionId instead.`);
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown session: ${sessionRef}`);
}

function ensureUniqueSessionName(sessionName: string | undefined) {
  if (!sessionName) return;
  sweepSessions();
  if ([...sessions.values()].some(session => !session.closed && session.sessionName === sessionName)) {
    throw new McpError(ErrorCode.InvalidParams, `Session name already exists: ${sessionName}`);
  }
}

async function readPrivateKey(keyPath: string | undefined): Promise<string | undefined> {
  const safePath = sanitizeOptionalText(keyPath);
  if (!safePath) return undefined;
  return fs.readFile(safePath, 'utf8');
}

function createToolResponse(primaryText: string, extraTexts: string[] = []) {
  return {
    content: [
      { type: 'text' as const, text: primaryText },
      ...extraTexts
        .filter(text => text.trim().length > 0)
        .map(text => ({ type: 'text' as const, text })),
    ],
  };
}

function buildDashboard(session: SSHSession, options: {
  width: number;
  height: number;
  leftChars: number;
  rightEvents: number;
  stripAnsiFromLeft: boolean;
}) {
  return buildDashboardState(session, options).dashboard;
}

function buildDashboardState(session: SSHSession, options: {
  width: number;
  height: number;
  leftChars: number;
  rightEvents: number;
  stripAnsiFromLeft: boolean;
}) {
  const outputSnapshot = session.read(undefined, options.leftChars);
  const conversationEvents = session.getConversationEvents(options.rightEvents);
  const terminalText = normalizePaneText(outputSnapshot.output, options.stripAnsiFromLeft);
  const conversationText = conversationEvents.map(renderTranscriptEvent).join('\n\n');
  const leftTitleBase = session.sessionName
    ? `SSH ${session.sessionName} ${session.user}@${session.host}:${session.port}`
    : `SSH ${session.user}@${session.host}:${session.port}`;
  const leftTitle = session.closed ? `${leftTitleBase} [closed]` : leftTitleBase;
  const rightTitle = 'Inputs (user / agent)';

  return {
    terminalText,
    conversationText,
    leftTitle,
    rightTitle,
    dashboard: renderSplitDashboard({
      leftTitle,
      rightTitle,
      leftText: terminalText,
      rightText: conversationText,
      width: options.width,
      height: options.height,
    }),
  };
}

function viewerHostForUrl(host: string) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host;
}

function getViewerBaseUrl() {
  if (DEFAULT_VIEWER_PORT <= 0) {
    return undefined;
  }

  return `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${DEFAULT_VIEWER_PORT}`;
}

function buildViewerSessionUrl(session: SSHSession) {
  const baseUrl = getViewerBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  return `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
}

function parsePositiveQueryInt(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanQuery(raw: string | null, fallback: boolean) {
  if (!raw) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createViewerPayload(
  session: SSHSession,
  options: {
    width: number;
    height: number;
    leftChars: number;
    rightEvents: number;
    stripAnsiFromLeft: boolean;
  },
) {
  const state = buildDashboardState(session, options);

  return {
    summary: session.summary(),
    viewerBaseUrl: getViewerBaseUrl(),
    viewerUrl: buildViewerSessionUrl(session),
    dashboardWidth: options.width,
    dashboardHeight: options.height,
    dashboardLeftChars: options.leftChars,
    dashboardRightEvents: options.rightEvents,
    stripAnsiFromLeft: options.stripAnsiFromLeft,
    dashboard: state.dashboard,
    terminalText: state.terminalText,
    conversationText: state.conversationText,
    leftTitle: state.leftTitle,
    rightTitle: state.rightTitle,
  };
}

function createViewerBindingPayload(
  bindingKey: string,
  options: {
    width: number;
    height: number;
    leftChars: number;
    rightEvents: number;
    stripAnsiFromLeft: boolean;
  },
) {
  const binding = viewerBindings.get(bindingKey);

  if (!binding) {
    const terminalText = '(viewer binding is not attached to any SSH session yet)';
    const conversationText = '(no user/agent input yet)';
    const leftTitle = `Viewer ${bindingKey}`;
    const rightTitle = 'Inputs (user / agent)';

    return {
      bindingKey,
      summary: null,
      binding: null,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerUrl: buildViewerBindingUrl(bindingKey),
      sessionViewerUrl: null,
      dashboardWidth: options.width,
      dashboardHeight: options.height,
      dashboardLeftChars: options.leftChars,
      dashboardRightEvents: options.rightEvents,
      stripAnsiFromLeft: options.stripAnsiFromLeft,
      dashboard: renderSplitDashboard({
        leftTitle,
        rightTitle,
        leftText: terminalText,
        rightText: conversationText,
        width: options.width,
        height: options.height,
      }),
      terminalText,
      conversationText,
      leftTitle,
      rightTitle,
    };
  }

  const session = sessions.get(binding.sessionId);
  if (!session) {
    const terminalText = `(binding ${binding.bindingKey} is waiting for session ${binding.sessionId})`;
    const conversationText = '(no user/agent input yet)';
    const leftTitle = `Viewer ${binding.user}@${binding.host}:${binding.port}`;
    const rightTitle = 'Inputs (user / agent)';

    return {
      bindingKey: binding.bindingKey,
      summary: null,
      binding,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerUrl: buildViewerBindingUrl(binding.bindingKey),
      sessionViewerUrl: null,
      dashboardWidth: options.width,
      dashboardHeight: options.height,
      dashboardLeftChars: options.leftChars,
      dashboardRightEvents: options.rightEvents,
      stripAnsiFromLeft: options.stripAnsiFromLeft,
      dashboard: renderSplitDashboard({
        leftTitle,
        rightTitle,
        leftText: terminalText,
        rightText: conversationText,
        width: options.width,
        height: options.height,
      }),
      terminalText,
      conversationText,
      leftTitle,
      rightTitle,
    };
  }

  const payload = createViewerPayload(session, options);
  return {
    ...payload,
    bindingKey: binding.bindingKey,
    binding,
    viewerUrl: buildViewerBindingUrl(binding.bindingKey),
    sessionViewerUrl: buildViewerSessionUrl(session),
  };
}

function escapePowerShellText(text: string) {
  return text.replace(/'/g, "''");
}

async function runPowerShellScript(script: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
  });
}

async function terminateViewerProcess(pid: number | undefined) {
  if (!viewerProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    await runPowerShellScript(`Stop-Process -Id ${pid} -Force`);
    return;
  }

  try {
    process.kill(pid!, 'SIGTERM');
  } catch {
    // ignore
  }
}

async function launchTerminalViewer(binding: ViewerBindingState) {
  if (DEFAULT_VIEWER_PORT <= 0) {
    throw new McpError(ErrorCode.InvalidRequest, 'viewerPort is disabled. Restart the MCP server with --viewerPort=<port> before launching a viewer terminal.');
  }

  if (process.platform !== 'win32') {
    throw new McpError(ErrorCode.InvalidRequest, 'Automatic terminal viewer launch is currently implemented for Windows only. Use the browser viewer or run viewer-cli manually on other platforms.');
  }

  const title = buildViewerBindingTitle(binding.host, binding.port, binding.user);
  const bindingUrl = buildViewerBindingUrl(binding.bindingKey);
  const viewerArgs = [
    `'${escapePowerShellText(VIEWER_CLI_ENTRY_PATH)}'`,
    `'--binding=${escapePowerShellText(binding.bindingKey)}'`,
    `'--host=${escapePowerShellText(viewerHostForUrl(DEFAULT_VIEWER_HOST))}'`,
    `'--port=${DEFAULT_VIEWER_PORT}'`,
    `'--intervalMs=${DEFAULT_VIEWER_REFRESH_MS}'`,
  ].join(' ');
  const innerCommand = `$Host.UI.RawUI.WindowTitle = '${escapePowerShellText(title)}'; & '${escapePowerShellText(process.execPath)}' ${viewerArgs}`;
  const script = [
    `$argList = @('-NoLogo', '-NoExit', '-Command', '${escapePowerShellText(innerCommand)}')`,
    `$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -PassThru`,
    '$proc.Id',
  ].join('; ');

  const result = await runPowerShellScript(script);
  const pid = Number.parseInt(result.stdout.trim().split(/\s+/).pop() || '', 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new McpError(ErrorCode.InternalError, `Failed to determine launched viewer PID. stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`);
  }

  return {
    bindingKey: binding.bindingKey,
    pid,
    mode: 'terminal' as const,
    sessionId: binding.sessionId,
    host: binding.host,
    port: binding.port,
    user: binding.user,
    title,
    url: bindingUrl || '',
    scope: binding.scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function launchBrowserViewer(url: string) {
  if (process.platform === 'win32') {
    await runPowerShellScript(`Start-Process '${escapePowerShellText(url)}'`);
    return;
  }

  if (process.platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('open', [url], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`)));
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdg-open', [url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`xdg-open exited with code ${code}`)));
  });
}

async function ensureViewerForSession(
  session: SSHSession,
  options: {
    mode: ViewerLaunchMode;
    scope: ViewerSingletonScope;
  },
) {
  const binding = upsertViewerBinding(session, options.scope);
  const bindingUrl = buildViewerBindingUrl(binding.bindingKey);
  const sessionViewerUrl = buildViewerSessionUrl(session);
  if (!bindingUrl) {
    throw new McpError(ErrorCode.InvalidRequest, 'viewerPort is disabled. Restart the MCP server with --viewerPort=<port> to use viewer auto-open.');
  }

  if (options.mode === 'browser') {
    await launchBrowserViewer(bindingUrl);
    return {
      launched: true,
      reusedExistingProcess: false,
      mode: options.mode,
      scope: options.scope,
      bindingKey: binding.bindingKey,
      viewerUrl: bindingUrl,
      sessionViewerUrl,
      pid: undefined,
    };
  }

  const existing = await refreshViewerProcessState(binding.bindingKey);
  if (existing && existing.url === bindingUrl) {
    const updated: ViewerProcessState = {
      ...existing,
      sessionId: session.sessionId,
      host: session.host,
      port: session.port,
      user: session.user,
      updatedAt: new Date().toISOString(),
      scope: options.scope,
      title: buildViewerBindingTitle(session.host, session.port, session.user),
    };
    viewerProcesses.set(binding.bindingKey, updated);
    await saveViewerProcessState();

    return {
      launched: false,
      reusedExistingProcess: true,
      mode: options.mode,
      scope: options.scope,
      bindingKey: binding.bindingKey,
      viewerUrl: bindingUrl,
      sessionViewerUrl,
      pid: updated.pid,
    };
  }

  if (existing?.pid) {
    await terminateViewerProcess(existing.pid);
    viewerProcesses.delete(binding.bindingKey);
    await saveViewerProcessState();
  }

  const launchedProcess = await launchTerminalViewer(binding);
  viewerProcesses.set(binding.bindingKey, launchedProcess);
  await saveViewerProcessState();

  return {
    launched: true,
    reusedExistingProcess: false,
    mode: options.mode,
    scope: options.scope,
    bindingKey: binding.bindingKey,
    viewerUrl: bindingUrl,
    sessionViewerUrl,
    pid: launchedProcess.pid,
  };
}

function renderViewerHomePage() {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --panel-alt: #0f1319;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --warn: #ffb84d;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    header {
      margin-bottom: 30px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 24px;
      color: var(--accent);
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
    }
    .sessions {
      display: grid;
      gap: 15px;
    }
    .session-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      transition: border-color 0.2s;
    }
    .session-card:hover {
      border-color: var(--accent);
    }
    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .session-title {
      font-weight: bold;
      font-size: 16px;
      color: var(--accent);
    }
    .session-meta {
      font-size: 13px;
      color: var(--muted);
    }
    .session-actions {
      display: flex;
      gap: 10px;
    }
    .btn {
      padding: 6px 12px;
      background: var(--panel-alt);
      border: 1px solid var(--line);
      border-radius: 4px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover {
      background: var(--line);
      border-color: var(--accent);
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--bg);
    }
    .btn-primary:hover {
      background: #5bc4c0;
      border-color: #5bc4c0;
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--muted);
      font-style: italic;
    }
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <header>
    <h1>SSH Session MCP Viewer</h1>
    <div class="subtitle">Real‑time SSH session monitoring</div>
  </header>

  <main>
    <div class="sessions">
      ${(() => {
        const sessionList = [...sessions.values()]
          .filter(s => !s.closed)
          .map(s => s.summary())
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        
        if (sessionList.length === 0) {
          return '<div class="empty-state">No active SSH sessions</div>';
        }
        
        return sessionList.map(session => {
          const sessionUrl = `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
          const bindingKey = buildViewerBindingKeyForSession(session as any, 'connection');
          const bindingUrl = `${baseUrl}/binding/${encodeURIComponent(bindingKey)}`;
          return `
            <div class="session-card">
              <div class="session-header">
                <div>
                  <div class="session-title">${escapeHtml(session.sessionName || session.sessionId)}</div>
                  <div class="session-meta">${session.user}@${session.host}:${session.port}</div>
                </div>
                <div class="session-actions">
                  <a href="${sessionUrl}" class="btn btn-primary" target="_blank">Session View</a>
                  <a href="${bindingUrl}" class="btn" target="_blank">Binding View</a>
                </div>
              </div>
              <div class="session-meta">
                Created: ${new Date(session.createdAt).toLocaleString()}
                • Last activity: ${new Date(session.updatedAt).toLocaleString()}
                ${session.idleExpiresAt ? `• Idle expires: ${new Date(session.idleExpiresAt).toLocaleString()}` : ''}
              </div>
            </div>
          `;
        }).join('');
      })()}
    </div>
  </main>

  <footer>
    <div>SSH Session MCP • Auto‑refresh: \${refreshMs}ms</div>
    <div>Viewer base URL: <code>\${baseUrl}</code></div>
  </footer>

  <script>
    setTimeout(() => location.reload(), \${refreshMs});
  </script>
</body>
</html>`;
}

function renderViewerSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;
  const session = sessions.get(sessionRef) || [...sessions.values()].find(s => s.sessionName === sessionRef);
  const sessionData = session ? session.summary() : null;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>\${sessionData ? escapeHtml(sessionData.sessionName || sessionData.sessionId) : 'Session Not Found'} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --warn: #ffb84d;
      --error: #ff6b6b;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
    }
    .header {
      padding: 15px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .title {
      font-size: 18px;
      font-weight: bold;
      color: var(--accent);
    }
    .meta {
      font-size: 13px;
      color: var(--muted);
    }
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .btn {
      padding: 6px 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
    }
    .btn:hover {
      background: var(--line);
    }
    .dashboard-container {
      padding: 20px;
    }
    .dashboard {
      background: #000;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 15px;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-x: auto;
      min-height: 400px;
    }
    .error {
      padding: 40px 20px;
      text-align: center;
      color: var(--error);
    }
    footer {
      padding: 15px 20px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${sessionData ? escapeHtml(sessionData.sessionName || sessionData.sessionId) : 'Session Not Found'}</div>
      <div class="meta">${sessionData ? `${sessionData.user}@${sessionData.host}:${sessionData.port}` : ''}</div>
    </div>
    <div class="controls">
      <a href="${baseUrl}" class="btn">Home</a>
      <button class="btn" onclick="location.reload()">Refresh</button>
    </div>
  </div>

  <div class="dashboard-container">
    ${sessionData ? `
      <div id="dashboard" class="dashboard">Loading dashboard...</div>
    ` : `
      <div class="error">
        <div style="font-size: 18px; margin-bottom: 10px;">Session not found</div>
        <div>Session reference: ${escapeHtml(sessionRef)}</div>
        <div style="margin-top: 20px;">
          <a href="${baseUrl}" class="btn">Return to Home</a>
        </div>
      </div>
    `}
  </div>

  <footer>
    <div>SSH Session MCP • Auto‑refresh: ${refreshMs}ms</div>
    <div>Session ID: ${escapeHtml(sessionRef)}</div>
  </footer>

  \${sessionData ? \`
    <script>
      const sessionRef = '\${sessionRef}';
      const baseUrl = '\${baseUrl}';
      const refreshMs = \${refreshMs};

      async function loadDashboard() {
        try {
          const response = await fetch(\`\${baseUrl}/api/session/\${encodeURIComponent(sessionRef)}\`);
          if (!response.ok) {
            throw new Error(\`HTTP \${response.status}\`);
          }
          const data = await response.json();
          document.getElementById('dashboard').textContent = data.dashboard;
          
          if (data.summary?.closed) {
            document.getElementById('dashboard').style.color = 'var(--muted)';
            document.getElementById('dashboard').innerHTML += '\\n\\n<span style="color: var(--warn)">[Session closed]</span>';
          }
        } catch (error) {
          document.getElementById('dashboard').textContent = \`Error loading dashboard: \${error.message}\`;
          document.getElementById('dashboard').style.color = 'var(--error)';
        }
      }

      loadDashboard();
      setInterval(loadDashboard, refreshMs);
    </script>
  \` : ''}
</body>
</html>`;
}

function renderViewerBindingPage(bindingKey: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;
  const binding = viewerBindings.get(bindingKey);
  const session = binding ? sessions.get(binding.sessionId) : null;
  const sessionData = session ? session.summary() : null;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>\${sessionData ? escapeHtml(sessionData.sessionName || sessionData.sessionId) : 'Binding Not Found'} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --warn: #ffb84d;
      --error: #ff6b6b;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
    }
    .header {
      padding: 15px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .title {
      font-size: 18px;
      font-weight: bold;
      color: var(--accent);
    }
    .meta {
      font-size: 13px;
      color: var(--muted);
    }
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .btn {
      padding: 6px 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
    }
    .btn:hover {
      background: var(--line);
    }
    .dashboard-container {
      padding: 20px;
    }
    .dashboard {
      background: #000;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 15px;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-x: auto;
      min-height: 400px;
    }
    .error {
      padding: 40px 20px;
      text-align: center;
      color: var(--error);
    }
    footer {
      padding: 15px 20px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${sessionData ? escapeHtml(sessionData.sessionName || sessionData.sessionId) : 'Binding Not Found'}</div>
      <div class="meta">${sessionData ? `${sessionData.user}@${sessionData.host}:${sessionData.port}` : `Binding: ${escapeHtml(bindingKey)}`}</div>
    </div>
    <div class="controls">
      <a href="${baseUrl}" class="btn">Home</a>
      <button class="btn" onclick="location.reload()">Refresh</button>
    </div>
  </div>

  <div class="dashboard-container">
    ${sessionData ? `
      <div id="dashboard" class="dashboard">Loading dashboard...</div>
    ` : `
      <div class="error">
        <div style="font-size: 18px; margin-bottom: 10px;">Binding not found</div>
        <div>Binding key: ${escapeHtml(bindingKey)}</div>
        <div style="margin-top: 20px;">
          <a href="${baseUrl}" class="btn">Return to Home</a>
        </div>
      </div>
    `}
  </div>

  <footer>
    <div>SSH Session MCP • Auto‑refresh: ${refreshMs}ms</div>
    <div>Binding key: ${escapeHtml(bindingKey)}</div>
  </footer>

  \${sessionData ? \`
    <script>
      const bindingKey = '\${bindingKey}';
      const baseUrl = '\${baseUrl}';
      const refreshMs = \${refreshMs};

      async function loadDashboard() {
        try {
          const response = await fetch(\`\${baseUrl}/api/viewer-binding/\${encodeURIComponent(bindingKey)}\`);
          if (!response.ok) {
            throw new Error(\`HTTP \${response.status}\`);
          }
          const data = await response.json();
          document.getElementById('dashboard').textContent = data.dashboard;
          
          if (data.summary?.closed) {
            document.getElementById('dashboard').style.color = 'var(--muted)';
            document.getElementById('dashboard').innerHTML += '\\n\\n<span style="color: var(--warn)">[Session closed]</span>';
          }
        } catch (error) {
          document.getElementById('dashboard').textContent = \`Error loading dashboard: \${error.message}\`;
          document.getElementById('dashboard').style.color = 'var(--error)';
        }
      }

      loadDashboard();
      setInterval(loadDashboard, refreshMs);
    </script>
  \` : ''}
</body>
</html>`;
}

async function startViewerServer() {
  if (DEFAULT_VIEWER_PORT <= 0 || viewerServer) {
    return;
  }

  viewerServer = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const writeJson = (statusCode: number, payload: unknown) => {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload, null, 2));
    };
    const writeHtml = (statusCode: number, html: string) => {
      response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    };
    const writeText = (statusCode: number, text: string) => {
      response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(text);
    };

    if (url.pathname === '/health') {
      writeJson(200, {
        ok: true,
        viewerBaseUrl: getViewerBaseUrl(),
        sessions: sessions.size,
      });
      return;
    }

    if (url.pathname === '/api/sessions') {
      sweepSessions();
      writeJson(200, {
        viewerBaseUrl: getViewerBaseUrl(),
        sessions: [...sessions.values()]
          .map(session => ({
            ...session.summary(),
            viewerUrl: buildViewerSessionUrl(session),
          }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      });
      return;
    }

    if (url.pathname.startsWith('/api/session/')) {
      try {
        const sessionRef = decodeURIComponent(url.pathname.slice('/api/session/'.length));
        const session = resolveSession(sessionRef);
        const width = parsePositiveQueryInt(url.searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH);
        const height = parsePositiveQueryInt(url.searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT);
        const leftChars = parsePositiveQueryInt(url.searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
        const rightEvents = parsePositiveQueryInt(url.searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS);
        const stripAnsiFromLeft = parseBooleanQuery(url.searchParams.get('stripAnsiFromLeft'), true);

        writeJson(200, createViewerPayload(session, {
          width,
          height,
          leftChars,
          rightEvents,
          stripAnsiFromLeft,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(404, { error: message });
      }
      return;
    }

    if (url.pathname.startsWith('/api/viewer-binding/')) {
      try {
        const bindingKey = decodeURIComponent(url.pathname.slice('/api/viewer-binding/'.length));
        const width = parsePositiveQueryInt(url.searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH);
        const height = parsePositiveQueryInt(url.searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT);
        const leftChars = parsePositiveQueryInt(url.searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
        const rightEvents = parsePositiveQueryInt(url.searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS);
        const stripAnsiFromLeft = parseBooleanQuery(url.searchParams.get('stripAnsiFromLeft'), true);

        writeJson(200, createViewerBindingPayload(bindingKey, {
          width,
          height,
          leftChars,
          rightEvents,
          stripAnsiFromLeft,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(404, { error: message });
      }
      return;
    }

    if (url.pathname.startsWith('/session/')) {
      const sessionRef = decodeURIComponent(url.pathname.slice('/session/'.length));
      writeHtml(200, renderViewerSessionPage(sessionRef));
      return;
    }

    if (url.pathname.startsWith('/binding/')) {
      const bindingKey = decodeURIComponent(url.pathname.slice('/binding/'.length));
      writeHtml(200, renderViewerBindingPage(bindingKey));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      writeHtml(200, renderViewerHomePage());
      return;
    }

    writeText(404, 'Not found');
  });

  await new Promise<void>((resolve, reject) => {
    viewerServer!.once('error', reject);
    viewerServer!.listen(DEFAULT_VIEWER_PORT, DEFAULT_VIEWER_HOST, () => {
      viewerServer!.off('error', reject);
      resolve();
    });
  });
}

function closeAllSessions(reason: string) {
  for (const session of sessions.values()) {
    try {
      session.close(reason);
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

const server = new McpServer({
  name: 'ssh-session-mcp',
  version: '1.0.2',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  'ssh-session-open',
  'Open a persistent interactive SSH PTY session with automatic idle cleanup and a split dashboard view.',
  {
    sessionName: z.string().optional().describe('Optional human-readable alias for the session'),
    host: z.string().optional().describe('SSH host. Falls back to server --host if omitted'),
    port: z.number().int().positive().optional().describe('SSH port. Falls back to server --port or 22'),
    user: z.string().optional().describe('SSH username. Falls back to server --user if omitted'),
    password: z.string().optional().describe('SSH password'),
    key: z.string().optional().describe('Path to a private SSH key on the local machine'),
    term: z.string().optional().describe('PTY TERM value'),
    cols: z.number().int().positive().optional().describe('PTY column count'),
    rows: z.number().int().positive().optional().describe('PTY row count'),
    idleTimeoutMs: z.number().int().nonnegative().optional().describe('Auto-close the SSH session after this much inactivity. 0 disables idle cleanup'),
    closedRetentionMs: z.number().int().nonnegative().optional().describe('How long to keep a closed session summary/transcript in memory before pruning'),
    startupInput: z.string().optional().describe('Raw text to send immediately after opening the session'),
    startupInputActor: z.string().optional().describe('Actor label for startupInput, e.g. codex, claude, user'),
    startupWaitMs: z.number().int().nonnegative().optional().describe('How long to wait before capturing the initial dashboard'),
    dashboardWidth: z.number().int().positive().optional().describe('Rendered dashboard width in columns'),
    dashboardHeight: z.number().int().positive().optional().describe('Rendered dashboard height in rows'),
    dashboardLeftChars: z.number().int().positive().optional().describe('How many recent terminal-output chars to use for the left pane'),
    dashboardRightEvents: z.number().int().positive().optional().describe('How many recent input/control/lifecycle events to use for the right pane'),
    stripAnsiFromLeft: z.boolean().optional().describe('Strip ANSI escape sequences from the rendered left pane'),
    includeDashboard: z.boolean().optional().describe('Include the rendered dashboard text in the tool response'),
    autoOpenViewer: z.boolean().optional().describe('Automatically ensure a local viewer is opened for this session'),
    viewerMode: z.enum(['terminal', 'browser']).optional().describe('Viewer launch mode when autoOpenViewer is enabled'),
    viewerSingletonScope: z.enum(['connection', 'session']).optional().describe('How viewer singleton deduplication is scoped when autoOpenViewer is enabled'),
  },
  async ({
    sessionName,
    host,
    port,
    user,
    password,
    key,
    term,
    cols,
    rows,
    idleTimeoutMs,
    closedRetentionMs,
    startupInput,
    startupInputActor,
    startupWaitMs,
    dashboardWidth,
    dashboardHeight,
    dashboardLeftChars,
    dashboardRightEvents,
    stripAnsiFromLeft,
    includeDashboard,
    autoOpenViewer,
    viewerMode,
    viewerSingletonScope,
  }) => {
    const resolvedHost = sanitizeOptionalText(host) || DEFAULT_HOST;
    const resolvedUser = sanitizeOptionalText(user) || DEFAULT_USER;

    if (!resolvedHost) {
      throw new McpError(ErrorCode.InvalidParams, 'host is required unless the server was started with --host');
    }

    if (!resolvedUser) {
      throw new McpError(ErrorCode.InvalidParams, 'user is required unless the server was started with --user');
    }

    const resolvedSessionName = sanitizeOptionalText(sessionName);
    ensureUniqueSessionName(resolvedSessionName);

    const resolvedPort = sanitizePort(port, DEFAULT_PORT);
    const resolvedTerm = sanitizeOptionalText(term) || DEFAULT_TERM;
    const resolvedCols = sanitizePositiveInt(cols, 'cols', DEFAULT_COLS);
    const resolvedRows = sanitizePositiveInt(rows, 'rows', DEFAULT_ROWS);
    const resolvedIdleTimeoutMs = sanitizeNonNegativeInt(idleTimeoutMs, 'idleTimeoutMs', DEFAULT_TIMEOUT);
    const resolvedClosedRetentionMs = sanitizeNonNegativeInt(closedRetentionMs, 'closedRetentionMs', DEFAULT_CLOSED_RETENTION_MS);
    const resolvedWaitMs = sanitizeNonNegativeInt(startupWaitMs, 'startupWaitMs', 200);
    const resolvedDashboardWidth = sanitizePositiveInt(dashboardWidth, 'dashboardWidth', DEFAULT_DASHBOARD_WIDTH);
    const resolvedDashboardHeight = sanitizePositiveInt(dashboardHeight, 'dashboardHeight', DEFAULT_DASHBOARD_HEIGHT);
    const resolvedDashboardLeftChars = sanitizePositiveInt(dashboardLeftChars, 'dashboardLeftChars', DEFAULT_DASHBOARD_LEFT_CHARS);
    const resolvedDashboardRightEvents = sanitizePositiveInt(dashboardRightEvents, 'dashboardRightEvents', DEFAULT_DASHBOARD_RIGHT_EVENTS);
    const resolvedStripAnsi = stripAnsiFromLeft !== false;
    const resolvedIncludeDashboard = includeDashboard !== false;
    const resolvedAutoOpenViewer = autoOpenViewer === true;
    const resolvedViewerMode = viewerModeValue(viewerMode);
    const resolvedViewerScope = viewerScopeValue(viewerSingletonScope);

    const sshConfig: SSHConfig = {
      host: resolvedHost,
      port: resolvedPort,
      username: resolvedUser,
    };

    const resolvedPassword = sanitizeOptionalText(password) || DEFAULT_PASSWORD;
    const resolvedKey = sanitizeOptionalText(key) || DEFAULT_KEY;
    if (resolvedPassword) {
      sshConfig.password = resolvedPassword;
    } else if (resolvedKey) {
      sshConfig.privateKey = await readPrivateKey(resolvedKey);
    }

    const connection = new SSHConnection(sshConfig, SSH_CONNECT_TIMEOUT_MS);
    await connection.connect();

    const sessionId = randomUUID();
    const client = connection.getClient();
    const session = await new Promise<SSHSession>((resolve, reject) => {
      client.shell({ term: resolvedTerm, cols: resolvedCols, rows: resolvedRows }, (err, stream) => {
        if (err) {
          connection.close();
          reject(new McpError(ErrorCode.InternalError, `Failed to open SSH shell: ${err.message}`));
          return;
        }

        resolve(new SSHSession(
          sessionId,
          resolvedSessionName,
          resolvedHost,
          resolvedPort,
          resolvedUser,
          resolvedCols,
          resolvedRows,
          resolvedTerm,
          resolvedIdleTimeoutMs,
          resolvedClosedRetentionMs,
          tuning,
          connection,
          stream,
        ));
      });
    });

    sessions.set(session.sessionId, session);

    if (typeof startupInput === 'string' && startupInput.length > 0) {
      session.write(startupInput, sanitizeActor(startupInputActor, 'agent'));
    }

    if (resolvedWaitMs > 0) {
      await delay(resolvedWaitMs);
    }

    const viewerUrl = buildViewerSessionUrl(session);
    const viewerBinding = upsertViewerBinding(session, resolvedViewerScope);
    const viewerBindingKey = viewerBinding.bindingKey;
    const viewerBindingUrl = buildViewerBindingUrl(viewerBindingKey);
    let viewerState: Awaited<ReturnType<typeof ensureViewerForSession>> | undefined;
    let viewerAutoOpenError: string | undefined;
    if (resolvedAutoOpenViewer) {
      try {
        viewerState = await ensureViewerForSession(session, {
          mode: resolvedViewerMode,
          scope: resolvedViewerScope,
        });
      } catch (error) {
        viewerAutoOpenError = error instanceof Error ? error.message : String(error);
      }
    }
    const dashboard = buildDashboard(session, {
      width: resolvedDashboardWidth,
      height: resolvedDashboardHeight,
      leftChars: resolvedDashboardLeftChars,
      rightEvents: resolvedDashboardRightEvents,
      stripAnsiFromLeft: resolvedStripAnsi,
    });

    return createToolResponse(JSON.stringify({
      ...session.summary(),
      nextOutputOffset: session.currentBufferEnd(),
      nextEventSeq: session.currentEventEnd(),
      dashboardWidth: resolvedDashboardWidth,
      dashboardHeight: resolvedDashboardHeight,
      dashboardLeftChars: resolvedDashboardLeftChars,
      dashboardRightEvents: resolvedDashboardRightEvents,
      stripAnsiFromLeft: resolvedStripAnsi,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerUrl,
      viewerBindingKey,
      viewerBindingUrl,
      autoOpenViewer: resolvedAutoOpenViewer,
      viewerMode: resolvedViewerMode,
      viewerSingletonScope: resolvedViewerScope,
      viewerState,
      viewerAutoOpenError,
    }, null, 2), resolvedIncludeDashboard ? [dashboard] : []);
  },
);

server.tool(
  'ssh-session-send',
  'Send raw input to an interactive SSH PTY session. Actor is shown in the dashboard right pane.',
  {
    session: z.string().describe('Session id or unique session name'),
    input: z.string().describe('Raw text to send into the PTY'),
    appendNewline: z.boolean().optional().describe('Append a newline after the input'),
    actor: z.string().optional().describe('Label for the sender shown in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, input, appendNewline, actor }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    if (input.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'input cannot be empty');
    }

    const payload = appendNewline === true ? `${input}\n` : input;
    const resolvedActor = sanitizeActor(actor, 'agent');
    target.write(payload, resolvedActor);

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      actor: resolvedActor,
      sentChars: payload.length,
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, null, 2));
  },
);

server.tool(
  'ssh-session-read',
  'Read raw buffered terminal output from an SSH PTY session. Supports optional long-polling for new terminal output.',
  {
    session: z.string().describe('Session id or unique session name'),
    offset: z.number().int().nonnegative().optional().describe('Read from this output offset. If omitted, return the latest tail'),
    maxChars: z.number().int().positive().optional().describe('Maximum chars to return'),
    waitForChangeMs: z.number().int().nonnegative().optional().describe('Wait up to this many milliseconds for new terminal output before returning'),
  },
  async ({ session, offset, maxChars, waitForChangeMs }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    const resolvedMaxChars = sanitizePositiveInt(maxChars, 'maxChars', DEFAULT_READ_CHARS);
    const resolvedWaitMs = sanitizeNonNegativeInt(waitForChangeMs, 'waitForChangeMs', 0);
    const baselineOffset = typeof offset === 'number' ? offset : target.currentBufferEnd();

    if (resolvedWaitMs > 0) {
      await target.waitForChange({ outputOffset: baselineOffset, waitMs: resolvedWaitMs });
    }

    const snapshot = target.read(offset, resolvedMaxChars);

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      requestedOffset: snapshot.requestedOffset,
      effectiveOffset: snapshot.effectiveOffset,
      nextOffset: snapshot.nextOffset,
      truncatedBefore: snapshot.truncatedBefore,
      truncatedAfter: snapshot.truncatedAfter,
      returnedChars: snapshot.output.length,
      waitedMs: resolvedWaitMs,
    }, null, 2), [snapshot.output.length > 0 ? `[output]\n${snapshot.output}` : '']);
  },
);

server.tool(
  'ssh-session-watch',
  'Long-poll an SSH PTY session and render a split dashboard: left pane is remote terminal output, right pane is user/agent inputs and session lifecycle.',
  {
    session: z.string().describe('Session id or unique session name'),
    outputOffset: z.number().int().nonnegative().optional().describe('Wait until terminal output grows beyond this offset'),
    eventSeq: z.number().int().nonnegative().optional().describe('Wait until transcript events grow beyond this sequence number'),
    waitForChangeMs: z.number().int().nonnegative().optional().describe('Long-poll duration in milliseconds'),
    dashboardWidth: z.number().int().positive().optional().describe('Rendered dashboard width in columns'),
    dashboardHeight: z.number().int().positive().optional().describe('Rendered dashboard height in rows'),
    dashboardLeftChars: z.number().int().positive().optional().describe('How many recent terminal-output chars to use for the left pane'),
    dashboardRightEvents: z.number().int().positive().optional().describe('How many recent input/control/lifecycle events to use for the right pane'),
    stripAnsiFromLeft: z.boolean().optional().describe('Strip ANSI escape sequences from the rendered left pane'),
    includeDashboard: z.boolean().optional().describe('Include the rendered dashboard text in the tool response'),
  },
  async ({
    session,
    outputOffset,
    eventSeq,
    waitForChangeMs,
    dashboardWidth,
    dashboardHeight,
    dashboardLeftChars,
    dashboardRightEvents,
    stripAnsiFromLeft,
    includeDashboard,
  }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    const resolvedWaitMs = sanitizeNonNegativeInt(waitForChangeMs, 'waitForChangeMs', DEFAULT_WATCH_WAIT_MS);
    const resolvedDashboardWidth = sanitizePositiveInt(dashboardWidth, 'dashboardWidth', DEFAULT_DASHBOARD_WIDTH);
    const resolvedDashboardHeight = sanitizePositiveInt(dashboardHeight, 'dashboardHeight', DEFAULT_DASHBOARD_HEIGHT);
    const resolvedDashboardLeftChars = sanitizePositiveInt(dashboardLeftChars, 'dashboardLeftChars', DEFAULT_DASHBOARD_LEFT_CHARS);
    const resolvedDashboardRightEvents = sanitizePositiveInt(dashboardRightEvents, 'dashboardRightEvents', DEFAULT_DASHBOARD_RIGHT_EVENTS);
    const resolvedStripAnsi = stripAnsiFromLeft !== false;
    const resolvedIncludeDashboard = includeDashboard !== false;
    const baselineOutputOffset = typeof outputOffset === 'number' ? outputOffset : target.currentBufferEnd();
    const baselineEventSeq = typeof eventSeq === 'number' ? eventSeq : target.currentEventEnd();

    if (resolvedWaitMs > 0) {
      await target.waitForChange({
        outputOffset: baselineOutputOffset,
        eventSeq: baselineEventSeq,
        waitMs: resolvedWaitMs,
      });
    }

    const nextOutputOffset = target.currentBufferEnd();
    const nextEventSeq = target.currentEventEnd();
    const dashboard = buildDashboard(target, {
      width: resolvedDashboardWidth,
      height: resolvedDashboardHeight,
      leftChars: resolvedDashboardLeftChars,
      rightEvents: resolvedDashboardRightEvents,
      stripAnsiFromLeft: resolvedStripAnsi,
    });

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      requestedOutputOffset: typeof outputOffset === 'number' ? outputOffset : null,
      requestedEventSeq: typeof eventSeq === 'number' ? eventSeq : null,
      waitedMs: resolvedWaitMs,
      outputChanged: nextOutputOffset > baselineOutputOffset,
      eventChanged: nextEventSeq > baselineEventSeq,
      nextOutputOffset,
      nextEventSeq,
      dashboardWidth: resolvedDashboardWidth,
      dashboardHeight: resolvedDashboardHeight,
      dashboardLeftChars: resolvedDashboardLeftChars,
      dashboardRightEvents: resolvedDashboardRightEvents,
      stripAnsiFromLeft: resolvedStripAnsi,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerUrl: buildViewerSessionUrl(target),
    }, null, 2), resolvedIncludeDashboard ? [dashboard] : []);
  },
);

server.tool(
  'ssh-session-control',
  'Send a control key to an interactive SSH PTY session. Actor is shown in the dashboard right pane.',
  {
    session: z.string().describe('Session id or unique session name'),
    control: z.enum(['ctrl_c', 'ctrl_d', 'enter', 'tab', 'esc', 'up', 'down', 'left', 'right', 'backspace']).describe('Control key to send'),
    actor: z.string().optional().describe('Label for the sender shown in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, control, actor }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    const resolvedActor = sanitizeActor(actor, 'agent');
    target.sendControl(control, resolvedActor);

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      actor: resolvedActor,
      control,
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, null, 2));
  },
);

server.tool(
  'ssh-session-resize',
  'Resize the PTY window of an interactive SSH session.',
  {
    session: z.string().describe('Session id or unique session name'),
    cols: z.number().int().positive().describe('New column count'),
    rows: z.number().int().positive().describe('New row count'),
  },
  async ({ session, cols, rows }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    target.resize(
      sanitizePositiveInt(cols, 'cols', DEFAULT_COLS),
      sanitizePositiveInt(rows, 'rows', DEFAULT_ROWS),
    );

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, null, 2));
  },
);

server.tool(
  'ssh-session-list',
  'List tracked SSH PTY sessions. Closed sessions are kept briefly for inspection, then automatically pruned.',
  {
    includeClosed: z.boolean().optional().describe('Include recently closed retained sessions'),
  },
  async ({ includeClosed }) => {
    sweepSessions();

    const tracked = [...sessions.values()]
      .filter(session => includeClosed === true || !session.closed)
      .map(session => session.summary())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return createToolResponse(JSON.stringify({ sessions: tracked }, null, 2));
  },
);

server.tool(
  'ssh-viewer-ensure',
  'Ensure that a viewer exists for a session. Terminal mode is singleton-scoped and will reuse a running viewer instead of opening duplicates.',
  {
    session: z.string().describe('Session id or unique session name'),
    mode: z.enum(['terminal', 'browser']).optional().describe('Viewer launch mode'),
    singletonScope: z.enum(['connection', 'session']).optional().describe('Deduplication scope for terminal viewers'),
  },
  async ({ session, mode, singletonScope }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    const result = await ensureViewerForSession(target, {
      mode: viewerModeValue(mode),
      scope: viewerScopeValue(singletonScope),
    });

    return createToolResponse(JSON.stringify({
      ...target.summary(),
      viewerBaseUrl: getViewerBaseUrl(),
      viewerUrl: result.viewerUrl,
      sessionViewerUrl: result.sessionViewerUrl,
      bindingKey: result.bindingKey,
      mode: result.mode,
      scope: result.scope,
      launched: result.launched,
      reusedExistingProcess: result.reusedExistingProcess,
      pid: result.pid,
    }, null, 2));
  },
);

server.tool(
  'ssh-viewer-list',
  'List persisted local viewer processes and their current binding state.',
  {},
  async () => {
    await loadViewerProcessState();
    let pruned = false;

    for (const [bindingKey, record] of viewerProcesses.entries()) {
      if (record.mode === 'terminal' && record.pid && !viewerProcessAlive(record.pid)) {
        viewerProcesses.delete(bindingKey);
        pruned = true;
      }
    }

    if (pruned) {
      await saveViewerProcessState();
    }

    const records = [...viewerProcesses.values()]
      .map(record => ({
        ...record,
        alive: viewerProcessAlive(record.pid),
        bindingUrl: buildViewerBindingUrl(record.bindingKey),
        sessionViewerUrl: sessions.get(record.sessionId)
          ? buildViewerSessionUrl(sessions.get(record.sessionId)!)
          : undefined,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return createToolResponse(JSON.stringify({
      viewerBaseUrl: getViewerBaseUrl(),
      viewers: records,
      bindings: [...viewerBindings.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }, null, 2));
  },
);

server.tool(
  'ssh-session-close',
  'Close an interactive SSH PTY session immediately and remove it from the MCP server.',
  {
    session: z.string().describe('Session id or unique session name'),
  },
  async ({ session }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    const summary = target.summary();
    target.close();
    sessions.delete(target.sessionId);

    return createToolResponse(JSON.stringify({
      ...summary,
      removed: true,
    }, null, 2));
  },
);

async function main() {
  await loadViewerProcessState();
  await startViewerServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const sweepTimer = setInterval(() => {
    try {
      sweepSessions();
    } catch {
      // ignore
    }
  }, DEFAULT_IDLE_SWEEP_MS);
  sweepTimer.unref?.();

  const cleanup = () => {
    clearInterval(sweepTimer);
    viewerServer?.close();
    closeAllSessions('mcp server shutdown');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    clearInterval(sweepTimer);
    viewerServer?.close();
    closeAllSessions('process exit');
  });
}

if (isCliEnabled) {
  main().catch(error => {
    console.error('Fatal error in main():', error);
    closeAllSessions('fatal mcp server error');
    process.exit(1);
  });
}

export { parseArgv, validateConfig };
export {
  createBufferSnapshot,
  createEventSnapshot,
  getControlSequence,
  normalizeTerminalInput,
  renderSplitDashboard,
  stripAnsi,
} from './shared.js';
