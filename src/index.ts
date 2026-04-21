#!/usr/bin/env node

import { promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';

import {
  withToolContract,
  type FailureCategory,
  type ResultStatus,
} from './contracts.js';
import {
  delay,
  normalizePaneText,
  renderTerminalDashboard,
  renderTranscriptEvent,
  renderViewerTranscript,
  sanitizeActor,
  sanitizeNonNegativeInt,
  sanitizeOptionalText,
  sanitizePort,
  sanitizePositiveInt,
  sanitizeRequiredText,
  stripAnsi,
} from './shared.js';
import {
  SSHConnection,
  SSHSession,
  DEFAULT_PROMPT_PATTERNS,
  type SSHConfig,
  type SessionMetadata,
  type SessionProfileSource,
  type SessionTuning,
  type SessionWriteRecord,
  type CompletionResult,
} from './session.js';
import { buildDiagnosticsOverview, buildSessionDiagnosticReport } from './diagnostics.js';
import { resolveLoggerConfig, SessionLogger, summarizeCommandMeta } from './logger.js';
import { buildReadMoreHint, buildReadProgress, buildSnapshotReadMore } from './paging.js';
import {
  loadProfiles,
  resolveDefaultDeviceId,
  resolveDeviceProfile,
  summarizeAuth,
  type DeviceProfile,
  type LoadedProfiles,
  type RuntimeDefaults,
} from './profiles.js';
import {
  resolveInstanceId,
  resolveRuntimePaths,
  resolveViewerPortSetting,
  type ViewerPortSetting,
} from './runtime.js';

import {
  type OperationMode,
  validateCommand,
  detectTerminalMode,
  isKnownSlowCommand,
} from './validation.js';

import { tryParseCommandOutput } from './parsers.js';

function loadDotEnv() {
  try {
    const envPath = pathResolve(fileURLToPath(import.meta.url), '../../.env');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env not found, that's fine
  }
}

loadDotEnv();

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

const DEFAULT_HOST = argvConfig.host || process.env.SSH_HOST;
const DEFAULT_PORT = argvConfig.port ? parseInt(argvConfig.port, 10) : (process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22);
const DEFAULT_USER = argvConfig.user || process.env.SSH_USER;
const DEFAULT_PASSWORD = argvConfig.password || process.env.SSH_PASSWORD;
const DEFAULT_KEY = argvConfig.key || process.env.SSH_KEY;
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
const MAX_HISTORY_LINES = argvConfig.maxHistoryLines ? parseInt(argvConfig.maxHistoryLines, 10) : 4000;
const INSTANCE_ID = resolveInstanceId(argvConfig.instance || process.env.SSH_MCP_INSTANCE);
const RUNTIME_PATHS = resolveRuntimePaths(INSTANCE_ID);
const PROFILES: LoadedProfiles = loadProfiles({
  argvPath: argvConfig.config,
  cwd: process.cwd(),
  envPath: process.env.SSH_MCP_CONFIG,
});
const CONFIG_DEFAULTS: RuntimeDefaults | undefined = PROFILES.config?.defaults;
const DEFAULT_VIEWER_HOST = argvConfig.viewerHost || process.env.VIEWER_HOST || CONFIG_DEFAULTS?.viewerHost || '127.0.0.1';
const VIEWER_PORT_SETTING: ViewerPortSetting = resolveViewerPortSetting(
  argvConfig.viewerPort
  || process.env.VIEWER_PORT
  || (typeof CONFIG_DEFAULTS?.viewerPort === 'number' ? String(CONFIG_DEFAULTS.viewerPort) : CONFIG_DEFAULTS?.viewerPort),
);
const DEFAULT_VIEWER_REFRESH_MS = argvConfig.viewerRefreshMs ? parseInt(argvConfig.viewerRefreshMs, 10) : 1000;
const LOG_CONFIG = resolveLoggerConfig(
  argvConfig.logMode || process.env.SSH_MCP_LOG_MODE || CONFIG_DEFAULTS?.logMode,
  argvConfig.logDir || process.env.SSH_MCP_LOG_DIR || CONFIG_DEFAULTS?.logDir,
  RUNTIME_PATHS.logDir,
);
const SSH_CONNECT_TIMEOUT_MS = 30000;
const AUTO_OPEN_TERMINAL = argvConfig.autoOpenTerminal === 'true'
  || argvConfig.autoOpenTerminal === '1'
  || process.env.AUTO_OPEN_TERMINAL === 'true'
  || process.env.AUTO_OPEN_TERMINAL === '1'
  || CONFIG_DEFAULTS?.autoOpenTerminal === true;
const VIEWER_LAUNCH_MODE: ViewerLaunchMode = (
  argvConfig.viewerLaunchMode
  || process.env.VIEWER_LAUNCH_MODE
  || CONFIG_DEFAULTS?.viewerMode
  || 'browser'
) as ViewerLaunchMode;
let OPERATION_MODE: OperationMode = (
  argvConfig.mode
  || process.env.SSH_MCP_MODE
  || CONFIG_DEFAULTS?.mode
  || 'safe'
) as OperationMode;
const USE_SENTINEL_MARKER = (argvConfig.useMarker || process.env.SSH_MCP_USE_MARKER || 'true') !== 'false';
const VIEWER_STATE_FILE = RUNTIME_PATHS.viewerStateFile;
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
let viewerWss: WebSocketServer | undefined;
let viewerStateLoaded = false;
let activeSessionId: string | undefined;
let actualViewerPort = VIEWER_PORT_SETTING.mode === 'fixed' ? VIEWER_PORT_SETTING.port || 0 : 0;
const logger = new SessionLogger(LOG_CONFIG);

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
    'maxHistoryLines',
    'viewerPort',
    'viewerRefreshMs',
  ];

  const errors = numericFields
    .filter(field => config[field] && Number.isNaN(Number(config[field])))
    .map(field => `Invalid --${field}`);

  if (config.viewerPort && config.viewerPort !== 'auto') {
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

function buildConnectionKey(host: string, port: number, user: string, connectionName?: string) {
  const base = `${user}@${host}:${port}`;
  return connectionName ? `${base}/${connectionName}` : base;
}

function sessionConnectionName(session: SSHSession | ReturnType<SSHSession['summary']>) {
  return session instanceof SSHSession
    ? session.metadata.connectionName
    : session.connectionName;
}

function buildViewerBindingKeyForSession(session: SSHSession | ReturnType<SSHSession['summary']>, scope: ViewerSingletonScope) {
  if (scope === 'session') {
    return `session:${session.sessionId}`;
  }

  return `connection:${buildConnectionKey(session.host, session.port, session.user, sessionConnectionName(session))}`;
}

function buildViewerBindingTitle(host: string, port: number, user: string) {
  return `SSH Session MCP Viewer - ${INSTANCE_ID} - ${user}@${host}:${port}`;
}

function buildViewerBindingUrl(bindingKey: string) {
  const baseUrl = getViewerBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  // PREPARE_DEPRECATION: This still returns the legacy /binding/* browser entry for compatibility.
  // New code that wants the primary browser terminal should move toward /terminal/binding/*.
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
  await fs.mkdir(RUNTIME_PATHS.instanceDir, { recursive: true });
  await fs.writeFile(VIEWER_STATE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

async function saveServerInfoState() {
  await fs.mkdir(RUNTIME_PATHS.instanceDir, { recursive: true });
  await fs.writeFile(RUNTIME_PATHS.serverInfoFile, JSON.stringify({
    instanceId: INSTANCE_ID,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    viewerHost: DEFAULT_VIEWER_HOST,
    viewerPort: actualViewerPort,
    viewerBaseUrl: getViewerBaseUrl(),
    configPath: PROFILES.path,
  }, null, 2), 'utf8');
}

async function removeServerInfoState() {
  try {
    await fs.unlink(RUNTIME_PATHS.serverInfoFile);
  } catch {
    // ignore
  }
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
  const connectionKey = buildConnectionKey(session.host, session.port, session.user, session.metadata.connectionName);
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
  maxHistoryLines: MAX_HISTORY_LINES,
};

const sessions = new Map<string, SSHSession>();

// --- Async command tracking (Phase D) ---

interface RunningCommand {
  commandId: string;
  sessionId: string;
  command: string;
  commandProgram?: string;
  startOffset: number;
  startedAt: string;
  startTime: number;
  status: 'running' | 'completed' | 'interrupted';
  output?: string;
  completedAt?: number;
  completionReason?: 'prompt' | 'idle' | 'timeout' | 'sentinel';
  exitCode?: number;
  sentinelMarker?: string;
  sentinelSuffix?: string;
}

const runningCommands = new Map<string, RunningCommand>();

function logServerEvent(event: string, data?: Record<string, unknown>) {
  void logger.logServer(event, {
    instanceId: INSTANCE_ID,
    ...data,
  });
}

function logSessionEvent(sessionId: string, event: string, data?: Record<string, unknown>) {
  void logger.logSession(sessionId, event, {
    instanceId: INSTANCE_ID,
    ...data,
  });
}

function sessionDisplayName(session: SSHSession | ReturnType<SSHSession['summary']>) {
  return session instanceof SSHSession
    ? session.metadata.sessionRef || session.sessionName || session.sessionId
    : session.sessionRef || session.sessionName || session.sessionId;
}

function sessionReadRef(session: SSHSession) {
  return session.metadata.sessionRef || session.sessionName || session.sessionId;
}

function pickMostRecentOpenSession() {
  return [...sessions.values()]
    .filter(session => !session.closed)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function setActiveSession(session: SSHSession | undefined) {
  activeSessionId = session?.sessionId;
}

function refreshActiveSession() {
  if (activeSessionId) {
    const active = sessions.get(activeSessionId);
    if (active && !active.closed) {
      return active;
    }
  }

  const next = pickMostRecentOpenSession();
  activeSessionId = next?.sessionId;
  return next;
}

function allocateConnectionName(deviceId: string, requested: string | undefined) {
  const normalizedRequested = sanitizeOptionalText(requested);
  const activeDeviceSessions = [...sessions.values()]
    .filter(session => !session.closed && session.metadata.deviceId === deviceId)
    .map(session => session.metadata.connectionName)
    .filter((value): value is string => typeof value === 'string');

  if (normalizedRequested) {
    if (activeDeviceSessions.includes(normalizedRequested)) {
      throw new McpError(ErrorCode.InvalidParams, `Connection name already exists on device "${deviceId}": ${normalizedRequested}`);
    }
    return normalizedRequested;
  }

  if (!activeDeviceSessions.includes('main')) {
    return 'main';
  }

  let index = 2;
  while (activeDeviceSessions.includes(`main-${index}`)) {
    index += 1;
  }

  return `main-${index}`;
}

function buildSessionMetadata(options: {
  connectionName?: string;
  deviceId?: string;
  profileSource: SessionProfileSource;
  sessionId: string;
  sessionName?: string;
}): SessionMetadata {
  const sessionName = sanitizeOptionalText(options.sessionName);
  const connectionName = sanitizeOptionalText(options.connectionName);
  const deviceId = sanitizeOptionalText(options.deviceId);
  const sessionRef = deviceId && connectionName
    ? `${deviceId}/${connectionName}`
    : (sessionName || options.sessionId);

  return {
    instanceId: INSTANCE_ID,
    deviceId,
    connectionName,
    sessionRef,
    profileSource: options.profileSource,
  };
}

function resolveConfiguredDefaultDeviceId() {
  return resolveDefaultDeviceId(PROFILES);
}

function resolveProfileOrThrow(deviceId: string) {
  const profile = resolveDeviceProfile(PROFILES, deviceId);
  if (!profile) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown device profile: ${deviceId}`);
  }
  return profile;
}

function findOpenSessionByName(sessionName: string) {
  return [...sessions.values()].find(session => !session.closed && session.sessionName === sessionName);
}

function findOpenProfileSession(deviceId: string, connectionName: string) {
  return [...sessions.values()].find(session =>
    !session.closed
    && session.metadata.deviceId === deviceId
    && session.metadata.connectionName === connectionName,
  );
}

function inferProfileSource(options: {
  deviceId?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  key?: string;
}): SessionProfileSource {
  if (sanitizeOptionalText(options.deviceId)) {
    return 'profile';
  }

  if (
    sanitizeOptionalText(options.host)
    || sanitizeOptionalText(options.user)
    || sanitizeOptionalText(options.password)
    || sanitizeOptionalText(options.key)
    || typeof options.port === 'number'
  ) {
    return 'manual';
  }

  return 'legacy-env';
}

function findRunningCommandForSession(sessionId: string) {
  for (const entry of runningCommands.values()) {
    if (entry.sessionId === sessionId && entry.status === 'running') {
      return entry;
    }
  }
  return undefined;
}

function buildSessionDiagnostics(session: SSHSession) {
  const history = session.historyStats();
  const binding = [...viewerBindings.values()].find(candidate => candidate.sessionId === session.sessionId);
  const viewerProcess = binding ? viewerProcesses.get(binding.bindingKey) : undefined;
  const staleViewerProcess = viewerProcess?.mode === 'terminal'
    ? Boolean(viewerProcess.pid && !viewerProcessAlive(viewerProcess.pid))
    : false;
  const runningCommand = findRunningCommandForSession(session.sessionId);

  return buildSessionDiagnosticReport({
    session: session.summary(),
    terminalMode: detectTerminalMode(session.buffer.slice(-2000)),
    historyLineStart: history.lineStart,
    historyLineEnd: history.lineEnd,
    historyPendingOutput: history.pendingOutput,
    runningCommand: runningCommand ? {
      commandId: runningCommand.commandId,
      program: runningCommand.commandProgram,
      startedAt: runningCommand.startedAt,
      status: runningCommand.status,
    } : undefined,
    viewer: binding ? {
      bindingKey: binding.bindingKey,
      mode: viewerProcess?.mode,
      pid: viewerProcess?.pid,
      reused: viewerProcess ? true : undefined,
    } : undefined,
    staleViewerProcess,
    logDir: LOG_CONFIG.dir,
    logMode: LOG_CONFIG.mode,
  });
}

function cleanCommandOutput(output: string, command: string, options: {
  sentinelMarker?: string;
  sentinelSuffix?: string;
} = {}) {
  let cleaned = stripAnsi(output);
  cleaned = stripCommandEcho(cleaned, command);

  if (options.sentinelMarker) {
    cleaned = stripSentinelFromOutput(cleaned, options.sentinelMarker, options.sentinelSuffix);
  }

  return cleaned;
}

function startBackgroundMonitor(entry: RunningCommand, session: SSHSession): void {
  session.waitForCompletion({
    startOffset: entry.startOffset,
    maxWaitMs: 5 * 60 * 1000,
    idleMs: 3000,
    promptPatterns: DEFAULT_PROMPT_PATTERNS,
    sentinel: entry.sentinelMarker,
  }).then((result) => {
    const stored = runningCommands.get(entry.commandId);
    if (!stored || stored.status !== 'running') return;

    if (result.reason === 'timeout') {
      startBackgroundMonitor(stored, session);
      return;
    }

    const snapshot = session.read(entry.startOffset, 32000);
    const output = cleanCommandOutput(snapshot.output, stored.command, {
      sentinelMarker: stored.sentinelMarker,
      sentinelSuffix: stored.sentinelSuffix,
    });
    stored.status = 'completed';
    stored.output = output;
    stored.completedAt = Date.now();
    stored.completionReason = result.reason;
    stored.exitCode = result.exitCode;
    logSessionEvent(stored.sessionId, 'command.completed', {
      commandId: stored.commandId,
      completionReason: stored.completionReason,
      exitCode: stored.exitCode,
      elapsedMs: stored.completedAt - stored.startTime,
      status: stored.status,
      ...summarizeCommandMeta(stored.command),
    });
  }).catch(() => {
    const stored = runningCommands.get(entry.commandId);
    if (stored && stored.status === 'running') {
      stored.status = 'interrupted';
      stored.completedAt = Date.now();
      logSessionEvent(stored.sessionId, 'command.interrupted', {
        commandId: stored.commandId,
        elapsedMs: stored.completedAt - stored.startTime,
        status: stored.status,
        ...summarizeCommandMeta(stored.command),
      });
    }
  });
}

function sweepSessions(nowMs = Date.now()) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.shouldCloseForIdle(nowMs)) {
      logSessionEvent(sessionId, 'session.idle_timeout', { idleTimeoutMs: session.idleTimeoutMs });
      logServerEvent('session.idle_timeout', { sessionId, idleTimeoutMs: session.idleTimeoutMs });
      session.finalize(`idle timeout after ${session.idleTimeoutMs}ms without input/output`);
      continue;
    }

    if (session.shouldPrune(nowMs)) {
      logSessionEvent(sessionId, 'session.pruned', {});
      logServerEvent('session.pruned', { sessionId });
      sessions.delete(sessionId);
      if (activeSessionId === sessionId) {
        setActiveSession(undefined);
      }
    }
  }

  // Clean up stale running commands
  for (const [cmdId, entry] of runningCommands.entries()) {
    if (!sessions.has(entry.sessionId)) {
      runningCommands.delete(cmdId);
      continue;
    }
    // Clean completed entries after 5 minutes (reduced from 10)
    if (entry.status !== 'running' && entry.completedAt && nowMs - entry.completedAt > 5 * 60 * 1000) {
      logSessionEvent(entry.sessionId, 'command.evicted', {
        commandId: entry.commandId,
        status: entry.status,
      });
      runningCommands.delete(cmdId);
      continue;
    }
    // Clean stuck running entries after 10 minutes (safety net)
    if (entry.status === 'running' && nowMs - entry.startTime > 10 * 60 * 1000) {
      entry.status = 'interrupted';
      entry.completedAt = nowMs;
      logSessionEvent(entry.sessionId, 'command.interrupted', {
        commandId: entry.commandId,
        elapsedMs: entry.completedAt - entry.startTime,
        status: entry.status,
        ...summarizeCommandMeta(entry.command),
      });
      runningCommands.delete(cmdId);
    }
  }
}

function resolveSession(sessionRef?: string): SSHSession {
  sweepSessions();

  const explicitRef = sanitizeOptionalText(sessionRef);
  if (!explicitRef) {
    const active = refreshActiveSession();
    if (active) {
      return active;
    }

    const openSessions = [...sessions.values()].filter(session => !session.closed);
    if (openSessions.length === 1) {
      return openSessions[0];
    }

    if (openSessions.length > 1) {
      throw new McpError(ErrorCode.InvalidParams, 'Multiple active sessions exist. Pass session explicitly or set an active session first.');
    }

    throw new McpError(ErrorCode.InvalidParams, 'No active session available.');
  }

  if (sessions.has(explicitRef)) {
    return sessions.get(explicitRef)!;
  }

  const allMatches = [...sessions.values()].filter(session =>
    session.metadata.sessionRef === explicitRef || session.sessionName === explicitRef,
  );
  const activeMatches = allMatches.filter(session => !session.closed);

  if (activeMatches.length === 1) {
    return activeMatches[0];
  }

  if (activeMatches.length > 1) {
    throw new McpError(ErrorCode.InvalidParams, `Multiple active sessions match "${explicitRef}". Use the sessionId instead.`);
  }

  if (allMatches.length === 1) {
    return allMatches[0];
  }

  if (allMatches.length > 1) {
    throw new McpError(ErrorCode.InvalidParams, `Multiple retained sessions match "${explicitRef}". Use the sessionId instead.`);
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown session: ${explicitRef}`);
}

function resolveSessionForBinding(bindingKey: string) {
  const binding = viewerBindings.get(bindingKey);
  if (!binding) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown viewer binding: ${bindingKey}`);
  }

  const session = sessions.get(binding.sessionId);
  if (!session) {
    throw new McpError(ErrorCode.InvalidParams, `Viewer binding ${bindingKey} is not attached to an active session`);
  }

  return {
    binding,
    session,
  };
}

function resolveAttachTarget(kind: 'session' | 'binding', ref: string) {
  if (kind === 'binding') {
    return resolveSessionForBinding(ref);
  }

  return {
    binding: undefined,
    session: resolveSession(ref),
  };
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

function resolvePassword(options: {
  explicitPassword?: string;
  profile?: DeviceProfile;
}) {
  const explicitPassword = sanitizeOptionalText(options.explicitPassword);
  if (explicitPassword) {
    return explicitPassword;
  }

  const passwordEnv = options.profile?.auth?.passwordEnv;
  if (passwordEnv && process.env[passwordEnv]) {
    return process.env[passwordEnv];
  }

  return DEFAULT_PASSWORD;
}

async function resolvePrivateKey(options: {
  explicitKeyPath?: string;
  profile?: DeviceProfile;
}) {
  const explicitKeyPath = sanitizeOptionalText(options.explicitKeyPath);
  if (explicitKeyPath) {
    return readPrivateKey(explicitKeyPath);
  }

  const profileKeyPath = sanitizeOptionalText(options.profile?.auth?.keyPath);
  if (profileKeyPath) {
    return readPrivateKey(profileKeyPath);
  }

  return readPrivateKey(DEFAULT_KEY);
}

async function openSSHSession(options: {
  cols: number;
  closedRetentionMs: number;
  host: string;
  idleTimeoutMs: number;
  keyPath?: string;
  metadata: SessionMetadata;
  password?: string;
  profile?: DeviceProfile;
  port: number;
  rows: number;
  sessionId: string;
  sessionName?: string;
  term: string;
  user: string;
}) {
  const sshConfig: SSHConfig = {
    host: options.host,
    port: options.port,
    username: options.user,
  };

  const resolvedPassword = resolvePassword({
    explicitPassword: options.password,
    profile: options.profile,
  });
  if (resolvedPassword) {
    sshConfig.password = resolvedPassword;
  } else {
    const privateKey = await resolvePrivateKey({
      explicitKeyPath: options.keyPath,
      profile: options.profile,
    });
    if (privateKey) {
      sshConfig.privateKey = privateKey;
    }
  }

  const connection = new SSHConnection(sshConfig, SSH_CONNECT_TIMEOUT_MS);
  await connection.connect();

  const client = connection.getClient();
  return new Promise<SSHSession>((resolve, reject) => {
    client.shell({ term: options.term, cols: options.cols, rows: options.rows }, (err, stream) => {
      if (err) {
        connection.close();
        reject(new McpError(ErrorCode.InternalError, `Failed to open SSH shell: ${err.message}`));
        return;
      }

      resolve(new SSHSession(
        options.sessionId,
        options.sessionName,
        options.metadata,
        options.host,
        options.port,
        options.user,
        options.cols,
        options.rows,
        options.term,
        options.idleTimeoutMs,
        options.closedRetentionMs,
        tuning,
        connection,
        stream,
      ));
    });
  });
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

function createJsonToolResponse(payload: object, extraTexts: string[] = []) {
  return createToolResponse(JSON.stringify(payload, null, 2), extraTexts);
}

function applyToolContract(
  payload: object,
  contract: {
    resultStatus: ResultStatus;
    summary: string;
    nextAction?: string;
    failureCategory?: FailureCategory;
    evidence?: Array<string | undefined | null>;
  },
) {
  return withToolContract(payload, {
    ...contract,
    evidence: (contract.evidence || []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSentinelCommandSuffix(sentinelMarker: string): string {
  // Use braces so the shell expands __MCP_EC rather than looking up __MCP_EC___.
  return `; __MCP_EC=$?; printf "%s%s___\\n" "${sentinelMarker}" "\${__MCP_EC}"`;
}

function stripSentinelFromOutput(output: string, sentinelMarker: string, sentinelSuffix?: string): string {
  let cleaned = output;

  // Remove only the injected command suffix from the echoed command, not the whole line.
  if (sentinelSuffix) {
    cleaned = cleaned.replaceAll(sentinelSuffix, '');
  }

  // Remove the actual sentinel output token. Keep everything else untouched even if PTY output
  // is packed into a single \r-delimited line, otherwise we can accidentally drop real logs.
  const sentinelPattern = new RegExp(`${escapeRegExp(sentinelMarker)}(?:\\d+___)?`, 'g');
  cleaned = cleaned.replace(sentinelPattern, '');

  return cleaned;
}

function stripCommandEcho(output: string, _command: string): string {
  // Disabled: automatic echo stripping is too risky for multi-line commands.
  // The PTY echoes back the entire command (including multi-line Python scripts),
  // and fuzzy matching can accidentally strip real output.
  // AI agents can handle seeing the command echo — it's better than losing output.
  return output;
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
  const transcriptSnapshot = session.readEvents(
    undefined,
    Math.max(options.rightEvents * 8, options.height * 12, 120),
    Math.max(options.leftChars, options.width * options.height * 2),
  );
  const transcriptText = renderViewerTranscript(transcriptSnapshot.events, options.stripAnsiFromLeft);
  const titleBase = `SSH ${sessionDisplayName(session)} ${session.user}@${session.host}:${session.port}`;
  const title = session.closed ? `${titleBase} [closed]` : titleBase;

  return {
    terminalText,
    conversationText,
    transcriptText,
    leftTitle: title,
    rightTitle: '',
    dashboard: renderTerminalDashboard({
      title,
      bodyText: transcriptText,
      width: options.width,
      height: options.height,
      emptyPlaceholder: '(no terminal activity yet)',
    }),
  };
}

function viewerHostForUrl(host: string) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host;
}

function getViewerBaseUrl() {
  if (actualViewerPort <= 0) {
    return undefined;
  }

  return `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${actualViewerPort}`;
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

function parseOptionalNonNegativeQueryInt(raw: string | null) {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNonNegativeQueryInt(raw: string | null, fallback: number) {
  const parsed = parseOptionalNonNegativeQueryInt(raw);
  return typeof parsed === 'number' ? parsed : fallback;
}

function parseBooleanQuery(raw: string | null, fallback: boolean) {
  if (!raw) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

async function readJsonRequestBody(request: AsyncIterable<Buffer | string>) {
  let body = '';

  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (body.length > 1024 * 1024) {
      throw new McpError(ErrorCode.InvalidRequest, 'Request body exceeds 1 MiB');
    }
  }

  if (body.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InvalidRequest, `Invalid JSON body: ${message}`);
  }
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
    transcriptText: state.transcriptText,
    leftTitle: state.leftTitle,
    rightTitle: state.rightTitle,
  };
}

function createAttachPayload(
  session: SSHSession,
  options: {
    bindingKey?: string;
    eventSeq?: number;
    maxChars: number;
    maxEvents: number;
    outputOffset?: number;
  },
) {
  const outputSnapshot = session.read(options.outputOffset, options.maxChars);
  const eventSnapshot = session.readEvents(
    options.eventSeq,
    options.maxEvents,
    Math.max(options.maxChars * 4, DEFAULT_DASHBOARD_LEFT_CHARS),
  );
  const binding = options.bindingKey ? viewerBindings.get(options.bindingKey) ?? null : null;

  return {
    summary: session.summary(),
    binding,
    bindingKey: binding?.bindingKey,
    viewerBaseUrl: getViewerBaseUrl(),
    viewerUrl: buildViewerSessionUrl(session),
    output: outputSnapshot.output,
    requestedOutputOffset: outputSnapshot.requestedOffset,
    effectiveOutputOffset: outputSnapshot.effectiveOffset,
    nextOutputOffset: outputSnapshot.nextOffset,
    outputAvailableStart: outputSnapshot.availableStart,
    outputAvailableEnd: outputSnapshot.availableEnd,
    outputTruncatedBefore: outputSnapshot.truncatedBefore,
    outputTruncatedAfter: outputSnapshot.truncatedAfter,
    requestedEventSeq: eventSnapshot.requestedEventSeq,
    effectiveEventSeq: eventSnapshot.effectiveEventSeq,
    nextEventSeq: eventSnapshot.nextEventSeq,
    eventAvailableStartSeq: eventSnapshot.availableStartSeq,
    eventAvailableEndSeq: eventSnapshot.availableEndSeq,
    eventTruncatedBefore: eventSnapshot.truncatedBefore,
    eventTruncatedAfter: eventSnapshot.truncatedAfter,
    events: eventSnapshot.events.filter(event => event.type !== 'output'),
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
    const transcriptText = terminalText;
    const leftTitle = `Viewer ${bindingKey}`;
    const rightTitle = '';

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
      dashboard: renderTerminalDashboard({
        title: leftTitle,
        bodyText: transcriptText,
        width: options.width,
        height: options.height,
        emptyPlaceholder: '(viewer binding is not attached to any SSH session yet)',
      }),
      terminalText,
      conversationText,
      transcriptText,
      leftTitle,
      rightTitle,
    };
  }

  const session = sessions.get(binding.sessionId);
  if (!session) {
    const terminalText = `(binding ${binding.bindingKey} is waiting for session ${binding.sessionId})`;
    const conversationText = '(no user/agent input yet)';
    const transcriptText = terminalText;
    const leftTitle = `Viewer ${binding.user}@${binding.host}:${binding.port}`;
    const rightTitle = '';

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
      dashboard: renderTerminalDashboard({
        title: leftTitle,
        bodyText: transcriptText,
        width: options.width,
        height: options.height,
        emptyPlaceholder: `(binding ${binding.bindingKey} is waiting for session ${binding.sessionId})`,
      }),
      terminalText,
      conversationText,
      transcriptText,
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
  if (!getViewerBaseUrl() || actualViewerPort <= 0) {
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
    `'--port=${actualViewerPort}'`,
    `'--intervalMs=${DEFAULT_VIEWER_REFRESH_MS}'`,
    '\'--interactive=true\'',
    '\'--statusBar=false\'',
    '\'--helpFooter=false\'',
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
    logSessionEvent(session.sessionId, 'viewer.opened', {
      bindingKey: binding.bindingKey,
      mode: options.mode,
      scope: options.scope,
    });
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
    logSessionEvent(session.sessionId, 'viewer.reused', {
      bindingKey: binding.bindingKey,
      mode: options.mode,
      pid: updated.pid,
      scope: options.scope,
    });

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
  logSessionEvent(session.sessionId, 'viewer.opened', {
    bindingKey: binding.bindingKey,
    mode: options.mode,
    pid: launchedProcess.pid,
    scope: options.scope,
  });

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
          // PREPARE_DEPRECATION: Session View / Binding View keep old polling pages reachable during transition.
          const sessionUrl = `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
          const terminalUrl = `${baseUrl}/terminal/session/${encodeURIComponent(session.sessionId)}`;
          const bindingKey = buildViewerBindingKeyForSession(session, 'connection');
          const bindingUrl = `${baseUrl}/binding/${encodeURIComponent(bindingKey)}`;
          return `
            <div class="session-card">
              <div class="session-header">
                <div>
                  <div class="session-title">${escapeHtml(sessionDisplayName(session))}</div>
                  <div class="session-meta">${session.user}@${session.host}:${session.port}${session.deviceId ? ` • device=${escapeHtml(session.deviceId)}` : ''}${session.connectionName ? ` • connection=${escapeHtml(session.connectionName)}` : ''}</div>
                </div>
                <div class="session-actions">
                  <a href="${terminalUrl}" class="btn btn-primary" target="_blank">Terminal</a>
                  <a href="${sessionUrl}" class="btn" target="_blank">Session View</a>
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

function renderViewerErrorPage(options: {
  baseUrl: string;
  detail: string;
  footerLabel: string;
  footerValue: string;
  title: string;
}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11151c;
      --panel: #1a2029;
      --line: #2b3442;
      --text: #e8edf5;
      --muted: #9aabbd;
      --accent: #6dd3ce;
      --error: #ff6b6b;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .header, footer {
      padding: 16px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    footer {
      border-bottom: 0;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .body {
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .error {
      max-width: 720px;
      width: 100%;
      background: #0b0f15;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }
    .title {
      color: var(--error);
      font-size: 20px;
      margin-bottom: 12px;
    }
    .detail {
      color: var(--muted);
      white-space: pre-wrap;
      margin-bottom: 20px;
    }
    .btn {
      display: inline-block;
      padding: 8px 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="header">SSH Session MCP Viewer</div>
  <div class="body">
    <div class="error">
      <div class="title">${escapeHtml(options.title)}</div>
      <div class="detail">${escapeHtml(options.detail)}</div>
      <a class="btn" href="${options.baseUrl}">Return to Home</a>
    </div>
  </div>
  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)}</footer>
</body>
</html>`;
}

// PREPARE_DEPRECATION: Legacy browser attach page based on HTTP polling + normalized text rendering.
// Keep it for compatibility with older links for now; preferred browser entrypoints are the xterm-based /terminal/* routes.
function renderInteractiveAttachPage(options: {
  actor: string;
  attachPath: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}) {
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Session MCP Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --panel-alt: #0f141b;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #91a0b3;
      --accent: #72d6d1;
      --warn: #ffbc6d;
      --error: #ff6b6b;
      --user: #2f81f7;
      --codex: #ff9f43;
      --claude: #b197fc;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top, #182232 0%, #0d1117 55%, #090c11 100%);
      color: var(--text);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .header, footer {
      padding: 16px 20px;
      background: rgba(22, 27, 34, 0.96);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    footer {
      border-bottom: 0;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 6px;
    }
    .subtitle, .meta {
      color: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .btn, .actor {
      height: 36px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--panel-alt);
      color: var(--text);
      font: inherit;
    }
    .btn {
      cursor: pointer;
    }
    .btn:hover, .actor:focus, .terminal-shell:focus-within {
      border-color: var(--accent);
    }
    .btn.primary {
      background: var(--accent);
      color: #08242a;
      border-color: transparent;
      font-weight: 700;
    }
    .page {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 12px;
      padding: 16px 20px;
      min-height: 0;
    }
    .notice {
      color: var(--warn);
      font-size: 12px;
      background: rgba(255, 188, 109, 0.08);
      border: 1px solid rgba(255, 188, 109, 0.18);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .terminal-shell {
      min-height: 0;
      display: grid;
      grid-template-rows: 1fr auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(6, 10, 15, 0.92);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
    }
    .terminal-wrap {
      min-height: 0;
      overflow: auto;
      padding: 18px;
    }
    .terminal {
      margin: 0;
      min-height: 100%;
      color: var(--text);
      font-size: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      outline: none;
      caret-color: transparent;
    }
    .status {
      padding: 10px 14px;
      border-top: 1px solid var(--line);
      background: #1f2630;
      color: #f5f7fa;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status.user { background: var(--user); }
    .status.codex { background: var(--codex); color: #1a140a; }
    .status.claude { background: var(--claude); }
    .status.session { background: #4b5563; }
    .status.error { background: var(--error); }
    .status.idle { background: #253041; }
    .shortcut-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .shortcut-row code {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--text);
    }
    @media (max-width: 900px) {
      .header {
        flex-direction: column;
      }
      .actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${escapeHtml(options.title)}</div>
      <div class="subtitle">${escapeHtml(options.subtitle)}</div>
      <div class="meta">${escapeHtml(options.meta)}</div>
    </div>
    <div class="actions">
      <a href="${options.baseUrl}" class="btn">Home</a>
      <select id="actor" class="actor">
        <option value="user"${options.actor === 'user' ? ' selected' : ''}>user</option>
        <option value="codex"${options.actor === 'codex' ? ' selected' : ''}>codex</option>
        <option value="claude"${options.actor === 'claude' ? ' selected' : ''}>claude</option>
      </select>
      <button id="focusBtn" class="btn primary" type="button">Focus</button>
      <button data-control="ctrl_c" class="btn" type="button">Ctrl+C</button>
      <button data-control="ctrl_d" class="btn" type="button">Ctrl+D</button>
      <button id="clearBtn" class="btn" type="button">Clear View</button>
    </div>
  </div>

  <div class="page">
    <div class="notice">Browser attach beta: this page shares the same SSH PTY with AI and supports manual input, but it normalizes ANSI/cursor control for web display. For highest terminal fidelity, continue to use the terminal attach viewer.</div>
    <div class="terminal-shell" id="terminalShell">
      <div class="terminal-wrap" id="terminalWrap">
        <pre id="terminal" class="terminal" tabindex="0">Connecting...</pre>
      </div>
      <div id="statusBar" class="status idle">[browser attach] connecting...</div>
    </div>
    <div class="shortcut-row">
      <span>Shortcuts:</span>
      <code>Enter</code><span>send line</span>
      <code>Tab</code><span>forward tab</span>
      <code>Arrow keys</code><span>forward navigation</span>
      <code>Ctrl+C</code><span>interrupt</span>
      <code>Ctrl+D</code><span>EOF</span>
      <code>Paste</code><span>send clipboard text</span>
    </div>
  </div>

  <footer>${escapeHtml(options.footerLabel)}: ${escapeHtml(options.footerValue)} • Browser attach refresh: ${refreshMs}ms</footer>

  <script>
    const attachBasePath = ${JSON.stringify(options.attachPath)};
    const refreshMs = ${refreshMs};
    const actorEl = document.getElementById('actor');
    const focusBtn = document.getElementById('focusBtn');
    const clearBtn = document.getElementById('clearBtn');
    const terminalEl = document.getElementById('terminal');
    const terminalWrapEl = document.getElementById('terminalWrap');
    const statusBarEl = document.getElementById('statusBar');
    const controlButtons = Array.from(document.querySelectorAll('[data-control]'));
    const state = {
      currentLine: '',
      eventSeq: undefined,
      outputOffset: undefined,
      lastEvent: undefined,
      lastStatusText: '[browser attach] connecting...',
      initialized: false,
      polling: false,
      closed: false,
      sendQueue: Promise.resolve(),
      resizeTimer: undefined,
    };
    const ansiPattern = /\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\].*?(?:\\u0007|\\u001B\\\\))/g;

    function stripAnsi(text) {
      return text.replace(ansiPattern, '');
    }

    function normalizeBrowserOutput(text) {
      return stripAnsi(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    }

    function normalizeTransportData(text) {
      return text.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
    }

    function summarizeEvent(event) {
      const compact = String(event.text || '').replace(/\\s+/g, ' ').trim();
      const clipped = compact.length > 96 ? compact.slice(0, 93) + '...' : compact;
      if (event.type === 'input') {
        return '[' + (event.actor || 'agent') + '] ' + (clipped || '<newline>');
      }
      if (event.type === 'control') {
        return '[' + (event.actor || 'agent') + '] <' + (clipped || 'control') + '>';
      }
      return '[session] ' + clipped;
    }

    function eventTheme(event, text) {
      if (text.startsWith('[browser attach] error')) return 'error';
      if (!event) return 'idle';
      if (event.actor === 'user') return 'user';
      if (event.actor === 'codex') return 'codex';
      if (event.actor === 'claude') return 'claude';
      return 'session';
    }

    function setStatus(text, event) {
      state.lastStatusText = text;
      statusBarEl.textContent = text;
      statusBarEl.className = 'status ' + eventTheme(event, text);
    }

    function appendOutput(output) {
      if (!output) return;
      const normalized = normalizeBrowserOutput(output);
      const nearBottom = terminalWrapEl.scrollTop + terminalWrapEl.clientHeight >= terminalWrapEl.scrollHeight - 36;
      if (terminalEl.textContent === 'Connecting...') {
        terminalEl.textContent = '';
      }
      terminalEl.textContent += normalized;
      if (terminalEl.textContent.length > 280000) {
        terminalEl.textContent = terminalEl.textContent.slice(-220000);
      }
      if (nearBottom) {
        terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
      }
    }

    function enqueue(task) {
      state.sendQueue = state.sendQueue.then(task).catch(function (error) {
        setStatus('[browser attach] error: ' + (error && error.message ? error.message : String(error)));
      });
      return state.sendQueue;
    }

    async function postJson(suffix, payload) {
      const response = await fetch(attachBasePath + suffix, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + await response.text());
      }
      return response.json();
    }

    function getActor() {
      return actorEl.value || 'user';
    }

    function focusTerminal() {
      terminalEl.focus();
      terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
    }

    function buildPasteRecords(text) {
      const records = [];
      const normalized = String(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (const character of normalized) {
        if (character === '\\n') {
          records.push({
            actor: getActor(),
            text: state.currentLine.length > 0 ? state.currentLine : '<newline>',
            type: 'input'
          });
          state.currentLine = '';
          continue;
        }
        if (character === '\\t') {
          state.currentLine += '\\t';
          continue;
        }
        if (character >= ' ') {
          state.currentLine += character;
        }
      }
      return records;
    }

    function sendRaw(data, records) {
      return enqueue(function () {
        return postJson('/input', {
          data: data,
          records: records || []
        });
      });
    }

    function sendControl(control, sequence) {
      if (control === 'ctrl_c') {
        state.currentLine = '';
      }
      return sendRaw(sequence, [{
        actor: getActor(),
        text: control,
        type: 'control'
      }]);
    }

    function estimateTerminalSize() {
      const rect = terminalWrapEl.getBoundingClientRect();
      const styles = window.getComputedStyle(terminalEl);
      const fontSize = Number.parseFloat(styles.fontSize || '14') || 14;
      const lineHeight = Number.parseFloat(styles.lineHeight || String(fontSize * 1.45)) || fontSize * 1.45;
      const charWidth = fontSize * 0.62;
      const cols = Math.max(40, Math.floor((rect.width - 36) / charWidth));
      const rows = Math.max(12, Math.floor((rect.height - 36) / lineHeight));
      return { cols, rows };
    }

    function scheduleResize() {
      if (state.resizeTimer) {
        window.clearTimeout(state.resizeTimer);
      }
      state.resizeTimer = window.setTimeout(function () {
        const size = estimateTerminalSize();
        enqueue(function () {
          return postJson('/resize', size);
        });
      }, 120);
    }

    async function pollOnce(waitMs) {
      const url = new URL(attachBasePath, window.location.origin);
      url.searchParams.set('maxChars', '16000');
      url.searchParams.set('maxEvents', '120');
      url.searchParams.set('waitMs', String(waitMs));
      if (typeof state.outputOffset === 'number') {
        url.searchParams.set('outputOffset', String(state.outputOffset));
      }
      if (typeof state.eventSeq === 'number') {
        url.searchParams.set('eventSeq', String(state.eventSeq));
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + await response.text());
      }

      const payload = await response.json();
      appendOutput(payload.output || '');
      if (Array.isArray(payload.events) && payload.events.length > 0) {
        const latestEvent = payload.events[payload.events.length - 1];
        state.lastEvent = latestEvent;
        const time = String(latestEvent.at || '').slice(11, 19);
        setStatus((time ? time + ' ' : '') + summarizeEvent(latestEvent), latestEvent);
      } else if (!state.initialized) {
        setStatus('[browser attach] connected');
      }

      state.outputOffset = payload.nextOutputOffset;
      state.eventSeq = payload.nextEventSeq;
      state.initialized = true;
      state.closed = payload.summary && payload.summary.closed === true;

      if (state.closed && !state.lastStatusText.includes('[closed]')) {
        setStatus('[browser attach] session closed');
      }
    }

    async function pollLoop() {
      if (state.polling) return;
      state.polling = true;
      while (true) {
        try {
          await pollOnce(state.initialized ? refreshMs : 0);
        } catch (error) {
          setStatus('[browser attach] error: ' + (error && error.message ? error.message : String(error)));
          await new Promise(function (resolve) { window.setTimeout(resolve, Math.min(refreshMs, 800)); });
        }
      }
    }

    terminalEl.addEventListener('keydown', function (event) {
      if (event.metaKey) return;

      if (event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
          event.preventDefault();
          void sendControl('ctrl_c', '\\u0003');
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          void sendControl('ctrl_d', '\\u0004');
          return;
        }
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const recordText = state.currentLine.length > 0 ? state.currentLine : '<newline>';
        state.currentLine = '';
        void sendRaw('\\r', [{
          actor: getActor(),
          text: recordText,
          type: 'input'
        }]);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        state.currentLine = state.currentLine.slice(0, -1);
        void sendRaw('\\u007f', []);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        state.currentLine += '\\t';
        void sendRaw('\\t', []);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        void sendRaw('\\u001b[A', []);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        void sendRaw('\\u001b[B', []);
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void sendRaw('\\u001b[D', []);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void sendRaw('\\u001b[C', []);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        void sendRaw('\\u001b', []);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
        event.preventDefault();
        state.currentLine += event.key;
        void sendRaw(event.key, []);
      }
    });

    terminalEl.addEventListener('paste', function (event) {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text');
      const records = buildPasteRecords(text);
      void sendRaw(normalizeTransportData(text), records);
    });

    focusBtn.addEventListener('click', function () {
      focusTerminal();
    });

    clearBtn.addEventListener('click', function () {
      terminalEl.textContent = '';
      focusTerminal();
    });

    controlButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        const control = button.getAttribute('data-control');
        if (control === 'ctrl_c') {
          void sendControl('ctrl_c', '\\u0003');
          return;
        }
        if (control === 'ctrl_d') {
          void sendControl('ctrl_d', '\\u0004');
        }
      });
    });

    actorEl.addEventListener('change', function () {
      setStatus('[browser attach] actor -> ' + getActor());
      focusTerminal();
    });

    window.addEventListener('resize', scheduleResize);
    terminalWrapEl.addEventListener('click', focusTerminal);
    window.addEventListener('load', function () {
      focusTerminal();
      scheduleResize();
      void pollLoop();
    });
  </script>
</body>
</html>`;
}

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /session/* browser page.
function renderViewerSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  let sessionData: ReturnType<SSHSession['summary']> | null = null;

  try {
    sessionData = resolveSession(sessionRef).summary();
  } catch {
    sessionData = null;
  }

  if (!sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Session reference: ${sessionRef}`,
      footerLabel: 'Session ID',
      footerValue: sessionRef,
      title: 'Session not found',
    });
  }

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/session/${encodeURIComponent(sessionRef)}`,
    baseUrl,
    footerLabel: 'Session ID',
    footerValue: sessionRef,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}\nCreated: ${new Date(sessionData.createdAt).toLocaleString()}\nLast activity: ${new Date(sessionData.updatedAt).toLocaleString()}`,
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}

// PREPARE_DEPRECATION: Compatibility wrapper for the legacy /binding/* browser page.
function renderViewerBindingPage(bindingKey: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const binding = viewerBindings.get(bindingKey);
  const session = binding ? sessions.get(binding.sessionId) : null;
  const sessionData = session ? session.summary() : null;

  if (!binding || !sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Binding key: ${bindingKey}`,
      footerLabel: 'Binding key',
      footerValue: bindingKey,
      title: 'Binding not found',
    });
  }

  return renderInteractiveAttachPage({
    actor: 'user',
    attachPath: `/api/attach/binding/${encodeURIComponent(bindingKey)}`,
    baseUrl,
    footerLabel: 'Binding key',
    footerValue: bindingKey,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}\nBinding: ${bindingKey}\nCreated: ${new Date(sessionData.createdAt).toLocaleString()}\nLast activity: ${new Date(sessionData.updatedAt).toLocaleString()}`,
    subtitle: 'Interactive browser attach view',
    title: sessionDisplayName(sessionData),
  });
}

function broadcastLock(session: SSHSession) {
  logSessionEvent(session.sessionId, 'session.lock', { lock: session.inputLock });
  if (!viewerWss) return;
  const msg = JSON.stringify({ type: 'lock', lock: session.inputLock });
  for (const client of viewerWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch { /* ignore */ }
    }
  }
}

function handleWsAttach(ws: WebSocket, kind: 'session' | 'binding', ref: string, rawOffset?: number) {
  let session: SSHSession;
  let bindingKey: string | undefined;

  try {
    const target = resolveAttachTarget(kind, ref);
    session = target.session;
    bindingKey = target.binding?.bindingKey;
  } catch (err) {
    ws.close(4004, err instanceof Error ? err.message : 'session not found');
    return;
  }

  const currentRawEnd = session.currentRawBufferEnd();

  ws.send(JSON.stringify({
    type: 'init',
    summary: session.summary(),
    bindingKey,
    rawBufferEnd: currentRawEnd,
  }));

  if (typeof rawOffset === 'number' && rawOffset >= session.rawBufferStart && rawOffset < currentRawEnd) {
    const slice = session.rawBuffer.slice(rawOffset - session.rawBufferStart);
    if (slice.length > 0) {
      ws.send(Buffer.from(slice), { binary: true });
    }
  } else if (typeof rawOffset !== 'number' || rawOffset < session.rawBufferStart) {
    if (session.rawBuffer.length > 0) {
      ws.send(Buffer.from(session.rawBuffer), { binary: true });
    }
  }

  const recentEvents = session.getConversationEvents(50);
  for (const event of recentEvents) {
    ws.send(JSON.stringify({ type: 'event', seq: event.seq, at: event.at, eventType: event.type, text: event.text, actor: event.actor }));
  }

  const unsubOutput = session.onRawOutput((chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  const unsubEvent = session.onEvent((event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', seq: event.seq, at: event.at, eventType: event.type, text: event.text, actor: event.actor }));
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'lock' && typeof msg.lock === 'string') {
        const validLocks = ['none', 'agent', 'user'];
        if (validLocks.includes(msg.lock)) {
          session.inputLock = msg.lock as 'none' | 'agent' | 'user';
          broadcastLock(session);
        }
        return;
      }

      if (msg.type === 'mode' && typeof msg.mode === 'string') {
        const validModes = ['safe', 'full'];
        if (validModes.includes(msg.mode)) {
          OPERATION_MODE = msg.mode as OperationMode;
          logServerEvent('operation_mode.changed', { mode: OPERATION_MODE, sessionId: session.sessionId });
          // Broadcast mode change to all WS clients
          if (viewerWss) {
            const modeMsg = JSON.stringify({ type: 'mode', mode: OPERATION_MODE });
            for (const client of viewerWss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                try { client.send(modeMsg); } catch { /* ignore */ }
              }
            }
          }
        }
        return;
      }

      if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length > 0) {
        // Check lock: browser input is always 'user' source
        if (session.inputLock === 'agent') {
          ws.send(JSON.stringify({ type: 'lock_rejected', lock: session.inputLock, message: 'Input locked by AI agent. Switch to "common" or "user" mode to type.' }));
          return;
        }
        const records: SessionWriteRecord[] = [];
        if (Array.isArray(msg.records)) {
          for (const r of msg.records) {
            if (r && (r.type === 'input' || r.type === 'control') && typeof r.text === 'string') {
              records.push({ actor: sanitizeActor(r.actor, 'user'), text: r.text, type: r.type });
            }
          }
        }
        session.writeRaw(msg.data, records);
        logSessionEvent(session.sessionId, 'session.input', {
          actor: records[0]?.actor || 'user',
          sentChars: msg.data.length,
        });
      }

      if (msg.type === 'control' && typeof msg.key === 'string') {
        if (session.inputLock === 'agent') {
          ws.send(JSON.stringify({ type: 'lock_rejected', lock: session.inputLock, message: 'Input locked by AI agent.' }));
          return;
        }
        session.sendControl(msg.key as any, sanitizeActor(msg.actor, 'user'));
        logSessionEvent(session.sessionId, 'session.control', {
          actor: sanitizeActor(msg.actor, 'user'),
          control: msg.key,
        });
      }

      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        session.resize(
          sanitizePositiveInt(msg.cols, 'cols', session.cols),
          sanitizePositiveInt(msg.rows, 'rows', session.rows),
        );
      }
    } catch {
      // ignore invalid messages
    }
  });

  const cleanup = () => {
    unsubOutput();
    unsubEvent();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function renderXtermTerminalPage(options: {
  attachKind: 'session' | 'binding';
  attachRef: string;
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  meta: string;
  subtitle: string;
  title: string;
}) {
  const wsProtocol = 'ws';
  const wsPath = options.attachKind === 'binding'
    ? `/ws/attach/binding/${encodeURIComponent(options.attachRef)}`
    : `/ws/attach/session/${encodeURIComponent(options.attachRef)}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} • SSH Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --line: #2f3845;
      --text: #e6edf3;
      --muted: #91a0b3;
      --accent: #72d6d1;
      --user: #2f81f7;
      --codex: #ff9f43;
      --claude: #b197fc;
      --locked: #f85149;
      font-family: Consolas, "SFMono-Regular", "Courier New", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); }
    body { display: flex; flex-direction: column; }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
      flex-shrink: 0; gap: 12px;
    }
    .header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .header-title { font-size: 15px; font-weight: 700; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .header-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
    .btn {
      height: 30px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--line);
      background: rgba(255,255,255,0.04); color: var(--text); font: inherit; font-size: 12px; cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex-shrink: 0; }
    .conn-dot.disconnected { background: #f85149; }
    #terminal-container { flex: 1; min-height: 0; padding: 4px; }
    .status-bar {
      padding: 6px 16px; border-top: 1px solid var(--line); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
      background: #1f2630; color: #f5f7fa; transition: background 0.2s;
    }
    .status-bar.user { background: var(--user); }
    .status-bar.codex { background: var(--codex); color: #1a140a; }
    .status-bar.claude { background: var(--claude); }
    .status-bar.session { background: #4b5563; }
    .status-bar.error { background: #f85149; }
    .status-bar.locked { background: var(--locked); }
    .lock-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; margin-left: 8px;
    }
    .lock-badge.agent { background: var(--claude); color: #fff; }
    .lock-badge.user-lock { background: var(--user); color: #fff; }
    .lock-badge.none { background: rgba(255,255,255,0.1); color: var(--muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="conn-dot" id="connDot"></div>
      <div class="header-title" id="headerTitle">${escapeHtml(options.title)}</div>
      <div class="header-meta" id="headerMeta">${escapeHtml(options.meta)}</div>
    </div>
    <div class="header-actions">
      <a href="${options.baseUrl}" class="btn">Home</a>
      <select id="actorSelect" class="btn" title="Switch input mode: common = both can type, user = only you type (AI blocked), claude/codex = AI types (your input blocked)">
        <option value="common" selected>common</option>
        <option value="user">user</option>
        <option value="codex">codex</option>
        <option value="claude">claude</option>
      </select>
      <select id="modeSelect" class="btn" title="Operation mode: safe = blocks dangerous commands, full = AI has full control">
        <option value="safe"${OPERATION_MODE === 'safe' ? ' selected' : ''}>safe</option>
        <option value="full"${OPERATION_MODE === 'full' ? ' selected' : ''}>full</option>
      </select>
      <span id="lockBadge" class="lock-badge none">unlocked</span>
    </div>
  </div>
  <div id="terminal-container"></div>
  <div class="status-bar" id="statusBar">Connecting...</div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
  (function() {
    var wsPath = ${JSON.stringify(wsPath)};
    var terminal = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 14,
      fontFamily: 'Consolas, "SFMono-Regular", "Courier New", monospace',
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#72d6d1',
        selectionBackground: 'rgba(114,214,209,0.3)',
      },
      allowProposedApi: true,
    });
    var fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    var connDot = document.getElementById('connDot');
    var statusBar = document.getElementById('statusBar');
    var actorSelect = document.getElementById('actorSelect');
    var lockBadge = document.getElementById('lockBadge');
    var headerTitle = document.getElementById('headerTitle');
    var ws = null;
    var currentLine = '';
    var reconnectTimer = null;
    var knownRawChars = 0;
    var isFirstConnect = true;
    var currentLock = 'none';
    var scrollTimer = null;
    var offsetDecoder = null;

    function getActor() { var v = actorSelect.value; return (v && v !== 'common') ? v : 'user'; }

    function isUserBlocked() {
      return currentLock === 'agent';
    }

    function updateLockUI(lock) {
      currentLock = lock;
      if (lock === 'agent') {
        lockBadge.textContent = 'AI active';
        lockBadge.className = 'lock-badge agent';
      } else if (lock === 'user') {
        lockBadge.textContent = 'user active';
        lockBadge.className = 'lock-badge user-lock';
      } else {
        lockBadge.textContent = 'unlocked';
        lockBadge.className = 'lock-badge none';
      }
      // Sync dropdown to match lock state
      if (lock === 'user' && actorSelect.value !== 'user') {
        actorSelect.value = 'user';
      } else if (lock === 'none' && actorSelect.value !== 'common') {
        actorSelect.value = 'common';
      }
    }

    function setStatus(text, theme) {
      statusBar.textContent = text;
      statusBar.className = 'status-bar' + (theme ? ' ' + theme : '');
    }

    function scheduleScrollToBottom() {
      if (scrollTimer !== null) return;
      scrollTimer = window.requestAnimationFrame(function() {
        scrollTimer = null;
        terminal.scrollToBottom();
      });
    }

    function eventTheme(event) {
      if (!event) return '';
      if (event.actor === 'user') return 'user';
      if (event.actor === 'codex') return 'codex';
      if (event.actor === 'claude') return 'claude';
      return 'session';
    }

    function summarizeEvent(event) {
      var compact = String(event.text || '').replace(/\\s+/g, ' ').trim();
      var clipped = compact.length > 80 ? compact.slice(0, 77) + '...' : compact;
      if (event.eventType === 'input') return '[' + (event.actor || 'agent') + '] ' + (clipped || '<newline>');
      if (event.eventType === 'control') return '[' + (event.actor || 'agent') + '] <' + clipped + '>';
      return '[session] ' + clipped;
    }

    function connect() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.onclose = null; ws.close(); } catch(e) {} ws = null; }
      offsetDecoder = new window.TextDecoder('utf-8');
      var loc = window.location;
      var wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + wsPath;
      if (!isFirstConnect && knownRawChars > 0) {
        wsUrl += (wsUrl.indexOf('?') === -1 ? '?' : '&') + 'rawOffset=' + knownRawChars;
      }
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        connDot.className = 'conn-dot';
        if (isFirstConnect) { isFirstConnect = false; }
        currentLine = '';
        setStatus('Connected as ' + getActor(), '');
        scheduleScrollToBottom();
      };

      ws.onmessage = function(evt) {
        if (evt.data instanceof ArrayBuffer) {
          var chunk = new Uint8Array(evt.data);
          terminal.write(chunk, function() {
            scheduleScrollToBottom();
          });
          if (offsetDecoder) {
            knownRawChars += offsetDecoder.decode(chunk, { stream: true }).length;
          }
          return;
        }
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'init' && msg.summary) {
            var s = msg.summary;
            headerTitle.textContent = (s.sessionName || s.sessionId || 'SSH') + ' ' + s.user + '@' + s.host + ':' + s.port;
            document.title = headerTitle.textContent + ' \\u2022 SSH Terminal';
            if (s.inputLock) { updateLockUI(s.inputLock); }
            scheduleScrollToBottom();
          }
          if (msg.type === 'event') {
            var time = String(msg.at || '').slice(11, 19);
            setStatus((time ? time + ' ' : '') + summarizeEvent(msg), eventTheme(msg));
          }
          if (msg.type === 'lock') {
            updateLockUI(msg.lock);
          }
          if (msg.type === 'mode') {
            modeSelect.value = msg.mode;
          }
          if (msg.type === 'lock_rejected') {
            setStatus('Input blocked: AI is active. Switch to "common" or "user" to type.', 'locked');
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        connDot.className = 'conn-dot disconnected';
        setStatus('Disconnected. Reconnecting...', 'error');
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = function() {};
    }

    function sendJson(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }

    terminal.onData(function(data) {
      if (isUserBlocked()) {
        setStatus('Input blocked: AI is active. Switch to "common" or "user" to type.', 'locked');
        return;
      }
      var records = [];
      var normalized = data.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (var i = 0; i < normalized.length; i++) {
        var ch = normalized[i];
        if (ch === '\\n') {
          records.push({ actor: getActor(), text: currentLine.length > 0 ? currentLine : '<newline>', type: 'input' });
          currentLine = '';
        } else if (ch === '\\u007f' || ch === '\\b') {
          currentLine = currentLine.slice(0, -1);
        } else if (ch === '\\u0003') {
          currentLine = '';
          records.push({ actor: getActor(), text: 'ctrl_c', type: 'control' });
        } else if (ch === '\\u0004') {
          records.push({ actor: getActor(), text: 'ctrl_d', type: 'control' });
        } else if (ch >= ' ') {
          currentLine += ch;
        }
      }
      var transportData = data.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
      sendJson({ type: 'input', data: transportData, records: records });
    });

    terminal.onBinary(function(data) {
      if (isUserBlocked()) return;
      sendJson({ type: 'input', data: data, records: [] });
    });

    window.addEventListener('resize', function() {
      fitAddon.fit();
      scheduleScrollToBottom();
    });

    terminal.onResize(function(size) {
      sendJson({ type: 'resize', cols: size.cols, rows: size.rows });
      scheduleScrollToBottom();
    });

    actorSelect.addEventListener('change', function() {
      var actor = getActor();
      if (actor === 'common') {
        sendJson({ type: 'lock', lock: 'none' });
        updateLockUI('none');
        setStatus('Switched to common mode. Both user and AI can type.', 'user');
      } else if (actor === 'user') {
        sendJson({ type: 'lock', lock: 'user' });
        updateLockUI('user');
        setStatus('Switched to user mode. AI input is blocked.', 'user');
      } else {
        sendJson({ type: 'lock', lock: 'agent' });
        updateLockUI('agent');
        setStatus('Switched to ' + actor + ' mode. AI controls the terminal. Your input is blocked.', 'claude');
      }
      terminal.focus();
    });

    var modeSelect = document.getElementById('modeSelect');
    modeSelect.addEventListener('change', function() {
      var newMode = modeSelect.value;
      if (newMode === 'full') {
        var confirmed = confirm('Warning: Full mode allows AI to execute dangerous commands (rm -rf, mkfs, etc.) without blocking.\\n\\nAre you sure you want to switch to full mode?');
        if (!confirmed) {
          modeSelect.value = 'safe';
          return;
        }
      }
      sendJson({ type: 'mode', mode: newMode });
      setStatus('Operation mode switched to: ' + newMode, newMode === 'full' ? 'error' : 'user');
      terminal.focus();
    });

    connect();
    terminal.focus();
    scheduleScrollToBottom();
  })();
  </script>
</body>
</html>`;
}

function renderXtermSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  let sessionData: ReturnType<SSHSession['summary']> | null = null;

  try {
    sessionData = resolveSession(sessionRef).summary();
  } catch {
    sessionData = null;
  }

  if (!sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Session reference: ${sessionRef}`,
      footerLabel: 'Session ID',
      footerValue: sessionRef,
      title: 'Session not found',
    });
  }

  return renderXtermTerminalPage({
    attachKind: 'session',
    attachRef: sessionRef,
    baseUrl,
    footerLabel: 'Session ID',
    footerValue: sessionRef,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}`,
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}

function renderXtermBindingPage(bindingKey: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const binding = viewerBindings.get(bindingKey);
  const session = binding ? sessions.get(binding.sessionId) : null;
  const sessionData = session ? session.summary() : null;

  if (!binding || !sessionData) {
    return renderViewerErrorPage({
      baseUrl,
      detail: `Binding key: ${bindingKey}`,
      footerLabel: 'Binding key',
      footerValue: bindingKey,
      title: 'Binding not found',
    });
  }

  return renderXtermTerminalPage({
    attachKind: 'binding',
    attachRef: bindingKey,
    baseUrl,
    footerLabel: 'Binding key',
    footerValue: bindingKey,
    meta: `${sessionData.user}@${sessionData.host}:${sessionData.port}`,
    subtitle: 'Shared SSH Terminal',
    title: sessionDisplayName(sessionData),
  });
}

async function startViewerServer() {
  if (!VIEWER_PORT_SETTING.enabled || viewerServer) {
    return;
  }

  viewerServer = createServer((request, response) => {
    void (async () => {
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
      const writeError = (statusCode: number, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(statusCode, { error: message });
      };

      const attachPrefixes = {
        binding: '/api/attach/binding/',
        session: '/api/attach/session/',
      } as const;

      const tryMatchAttachRoute = (kind: 'binding' | 'session', suffix: '' | '/input' | '/resize') => {
        const prefix = `${attachPrefixes[kind]}`;
        if (!url.pathname.startsWith(prefix)) {
          return undefined;
        }

        const rest = url.pathname.slice(prefix.length);
        if (!rest) {
          return undefined;
        }

        if (!suffix) {
          if (rest.endsWith('/input') || rest.endsWith('/resize')) {
            return undefined;
          }

          return decodeURIComponent(rest);
        }

        if (!rest.endsWith(suffix)) {
          return undefined;
        }

        return decodeURIComponent(rest.slice(0, -suffix.length));
      };

      if (url.pathname === '/health') {
        writeJson(200, {
          ok: true,
          instanceId: INSTANCE_ID,
          configPath: PROFILES.path,
          viewerBaseUrl: getViewerBaseUrl(),
          viewerPort: actualViewerPort || undefined,
          sessions: sessions.size,
        });
        return;
      }

      if (url.pathname === '/api/sessions') {
        sweepSessions();
        writeJson(200, {
          instanceId: INSTANCE_ID,
          activeSessionRef: refreshActiveSession()?.metadata.sessionRef || null,
          viewerBaseUrl: getViewerBaseUrl(),
          viewerPort: actualViewerPort || undefined,
          sessions: [...sessions.values()]
            .map(session => ({
              ...session.summary(),
              viewerUrl: buildViewerSessionUrl(session),
            }))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        });
        return;
      }

      for (const kind of ['session', 'binding'] as const) {
        const attachRef = tryMatchAttachRoute(kind, '');
        if (request.method === 'GET' && attachRef) {
          try {
            const { binding, session } = resolveAttachTarget(kind, attachRef);
            const requestedOutputOffset = parseOptionalNonNegativeQueryInt(url.searchParams.get('outputOffset'));
            const requestedEventSeq = parseOptionalNonNegativeQueryInt(url.searchParams.get('eventSeq'));
            const maxChars = parsePositiveQueryInt(url.searchParams.get('maxChars'), DEFAULT_DASHBOARD_LEFT_CHARS);
            const maxEvents = parsePositiveQueryInt(url.searchParams.get('maxEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS * 4);
            const waitMs = parseNonNegativeQueryInt(url.searchParams.get('waitMs'), 0);
            const baselineOutputOffset = typeof requestedOutputOffset === 'number' ? requestedOutputOffset : session.currentBufferEnd();
            const baselineEventSeq = typeof requestedEventSeq === 'number' ? requestedEventSeq : session.currentEventEnd();

            if (waitMs > 0) {
              await session.waitForChange({
                outputOffset: baselineOutputOffset,
                eventSeq: baselineEventSeq,
                waitMs,
              });
            }

            writeJson(200, createAttachPayload(session, {
              bindingKey: binding?.bindingKey,
              outputOffset: requestedOutputOffset,
              eventSeq: requestedEventSeq,
              maxChars,
              maxEvents,
            }));
          } catch (error) {
            writeError(404, error);
          }
          return;
        }

        const inputRef = tryMatchAttachRoute(kind, '/input');
        if (request.method === 'POST' && inputRef) {
          try {
            const { session } = resolveAttachTarget(kind, inputRef);
            const body = await readJsonRequestBody(request);
            const rawData = typeof body.data === 'string' ? body.data : undefined;

            if (!rawData || rawData.length === 0) {
              throw new McpError(ErrorCode.InvalidRequest, 'data must be a non-empty string');
            }

            const records: SessionWriteRecord[] = [];

            if (Array.isArray(body.records)) {
              for (const value of body.records) {
                if (!value || typeof value !== 'object') {
                  continue;
                }

                const candidate = value as Record<string, unknown>;
                if ((candidate.type !== 'input' && candidate.type !== 'control') || typeof candidate.text !== 'string') {
                  continue;
                }

                records.push({
                  actor: sanitizeActor(typeof candidate.actor === 'string' ? candidate.actor : undefined, 'user'),
                  text: candidate.text,
                  type: candidate.type,
                });
              }
            } else if ((body.recordType === 'input' || body.recordType === 'control') && typeof body.displayText === 'string') {
              records.push({
                actor: sanitizeActor(typeof body.actor === 'string' ? body.actor : undefined, 'user'),
                text: body.displayText,
                type: body.recordType,
              });
            }

            session.writeRaw(rawData, records);
            writeJson(200, {
              ok: true,
              ...session.summary(),
              recordedEvents: records.length,
              nextOutputOffset: session.currentBufferEnd(),
              nextEventSeq: session.currentEventEnd(),
            });
          } catch (error) {
            writeError(400, error);
          }
          return;
        }

        const resizeRef = tryMatchAttachRoute(kind, '/resize');
        if (request.method === 'POST' && resizeRef) {
          try {
            const { session } = resolveAttachTarget(kind, resizeRef);
            const body = await readJsonRequestBody(request);
            const cols = typeof body.cols === 'number' ? body.cols : Number(body.cols);
            const rows = typeof body.rows === 'number' ? body.rows : Number(body.rows);
            const resolvedCols = sanitizePositiveInt(cols, 'cols', session.cols);
            const resolvedRows = sanitizePositiveInt(rows, 'rows', session.rows);

            session.resize(resolvedCols, resolvedRows);
            writeJson(200, {
              ok: true,
              ...session.summary(),
              cols: resolvedCols,
              rows: resolvedRows,
            });
          } catch (error) {
            writeError(400, error);
          }
          return;
        }
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
          writeError(404, error);
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
          writeError(404, error);
        }
        return;
      }

      if (url.pathname.startsWith('/terminal/session/')) {
        const sessionRef = decodeURIComponent(url.pathname.slice('/terminal/session/'.length));
        writeHtml(200, renderXtermSessionPage(sessionRef));
        return;
      }

      if (url.pathname.startsWith('/terminal/binding/')) {
        const bindingKey = decodeURIComponent(url.pathname.slice('/terminal/binding/'.length));
        writeHtml(200, renderXtermBindingPage(bindingKey));
        return;
      }

      // PREPARE_DEPRECATION: Keep legacy polling browser routes reachable during migration.
      // New browser entrypoints should prefer /terminal/session/* and /terminal/binding/*.
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
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: message }, null, 2));
        return;
      }

      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    viewerServer!.once('error', reject);
    viewerServer!.listen(VIEWER_PORT_SETTING.mode === 'fixed' ? VIEWER_PORT_SETTING.port : 0, DEFAULT_VIEWER_HOST, () => {
      viewerServer!.off('error', reject);
      const address = viewerServer!.address();
      if (address && typeof address === 'object') {
        actualViewerPort = address.port;
      }
      resolve();
    });
  });
  logServerEvent('viewer_server.started', {
    host: DEFAULT_VIEWER_HOST,
    port: actualViewerPort,
    mode: VIEWER_PORT_SETTING.mode,
  });
  await saveServerInfoState();

  const wss = new WebSocketServer({ noServer: true });
  viewerWss = wss;

  viewerServer!.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const sessionMatch = url.pathname.match(/^\/ws\/attach\/session\/(.+)$/);
    const bindingMatch = url.pathname.match(/^\/ws\/attach\/binding\/(.+)$/);

    if (!sessionMatch && !bindingMatch) {
      socket.destroy();
      return;
    }

    const kind: 'session' | 'binding' = sessionMatch ? 'session' : 'binding';
    const ref = decodeURIComponent((sessionMatch || bindingMatch)![1]);
    const rawOffsetParam = url.searchParams.get('rawOffset');
    const rawOffset = rawOffsetParam !== null ? parseInt(rawOffsetParam, 10) : undefined;

    wss.handleUpgrade(request, socket as any, head, (ws) => {
      handleWsAttach(ws, kind, ref, Number.isFinite(rawOffset) ? rawOffset : undefined);
    });
  });
}

function closeAllSessions(reason: string) {
  for (const session of sessions.values()) {
    try {
      logSessionEvent(session.sessionId, 'session.close_all', { reason });
      session.close(reason);
    } catch {
      // ignore
    }
  }
  sessions.clear();
  setActiveSession(undefined);
  logServerEvent('server.close_all_sessions', { reason });
}

const server = new McpServer({
  name: 'ssh-session-mcp',
  version: '2.4.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  'ssh-session-open',
  'Open a persistent interactive SSH PTY session with automatic idle cleanup and a terminal-style dashboard view.',
  {
    sessionName: z.string().optional().describe('Optional human-readable alias for the session'),
    device: z.string().optional().describe('Device profile id from ssh-session-mcp.config.json'),
    connectionName: z.string().optional().describe('Logical connection name for the selected device'),
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
    dashboardLeftChars: z.number().int().positive().optional().describe('How many recent transcript chars to retain in the rendered viewer'),
    dashboardRightEvents: z.number().int().positive().optional().describe('How many recent input/control/lifecycle events to retain for actor markers'),
    stripAnsiFromLeft: z.boolean().optional().describe('Strip ANSI escape sequences from rendered SSH output'),
    includeDashboard: z.boolean().optional().describe('Include the rendered dashboard text in the tool response'),
    autoOpenViewer: z.boolean().optional().describe('Automatically ensure a local viewer is opened for this session'),
    viewerMode: z.enum(['terminal', 'browser']).optional().describe('Viewer launch mode when autoOpenViewer is enabled'),
    viewerSingletonScope: z.enum(['connection', 'session']).optional().describe('How viewer singleton deduplication is scoped when autoOpenViewer is enabled'),
  },
  async ({
    sessionName,
    device,
    connectionName,
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
    const resolvedDeviceId = sanitizeOptionalText(device);
    const profile = resolvedDeviceId ? resolveProfileOrThrow(resolvedDeviceId) : undefined;
    const profileDefaults = profile?.defaults;

    if (!resolvedDeviceId && sanitizeOptionalText(connectionName)) {
      throw new McpError(ErrorCode.InvalidParams, 'connectionName requires device');
    }

    const resolvedHost = sanitizeOptionalText(host) || profile?.host || DEFAULT_HOST;
    const resolvedUser = sanitizeOptionalText(user) || profile?.user || DEFAULT_USER;

    if (!resolvedHost) {
      throw new McpError(ErrorCode.InvalidParams, 'host is required unless the server was started with --host');
    }

    if (!resolvedUser) {
      throw new McpError(ErrorCode.InvalidParams, 'user is required unless the server was started with --user');
    }

    const resolvedSessionName = sanitizeOptionalText(sessionName);
    ensureUniqueSessionName(resolvedSessionName);

    const resolvedPort = sanitizePort(port, profile?.port ?? DEFAULT_PORT);
    const resolvedTerm = sanitizeOptionalText(term) || profileDefaults?.term || DEFAULT_TERM;
    const resolvedCols = sanitizePositiveInt(cols, 'cols', profileDefaults?.cols ?? DEFAULT_COLS);
    const resolvedRows = sanitizePositiveInt(rows, 'rows', profileDefaults?.rows ?? DEFAULT_ROWS);
    const resolvedIdleTimeoutMs = sanitizeNonNegativeInt(idleTimeoutMs, 'idleTimeoutMs', profileDefaults?.idleTimeoutMs ?? DEFAULT_TIMEOUT);
    const resolvedClosedRetentionMs = sanitizeNonNegativeInt(closedRetentionMs, 'closedRetentionMs', profileDefaults?.closedRetentionMs ?? DEFAULT_CLOSED_RETENTION_MS);
    const resolvedWaitMs = sanitizeNonNegativeInt(startupWaitMs, 'startupWaitMs', 200);
    const resolvedDashboardWidth = sanitizePositiveInt(dashboardWidth, 'dashboardWidth', DEFAULT_DASHBOARD_WIDTH);
    const resolvedDashboardHeight = sanitizePositiveInt(dashboardHeight, 'dashboardHeight', DEFAULT_DASHBOARD_HEIGHT);
    const resolvedDashboardLeftChars = sanitizePositiveInt(dashboardLeftChars, 'dashboardLeftChars', DEFAULT_DASHBOARD_LEFT_CHARS);
    const resolvedDashboardRightEvents = sanitizePositiveInt(dashboardRightEvents, 'dashboardRightEvents', DEFAULT_DASHBOARD_RIGHT_EVENTS);
    const resolvedStripAnsi = stripAnsiFromLeft !== false;
    const resolvedIncludeDashboard = includeDashboard !== false;
    const resolvedAutoOpenViewer = typeof autoOpenViewer === 'boolean'
      ? autoOpenViewer
      : profileDefaults?.autoOpenViewer === true;
    const resolvedViewerMode = viewerModeValue(
      viewerMode
      || profileDefaults?.viewerMode
      || VIEWER_LAUNCH_MODE,
    );
    const resolvedViewerScope = viewerScopeValue(viewerSingletonScope || CONFIG_DEFAULTS?.viewerSingletonScope);

    const sessionId = randomUUID();
    const resolvedConnectionName = resolvedDeviceId
      ? allocateConnectionName(resolvedDeviceId, connectionName)
      : undefined;
    const profileSource = inferProfileSource({
      deviceId: resolvedDeviceId,
      host,
      port,
      user,
      password,
      key,
    });
    const metadata = buildSessionMetadata({
      connectionName: resolvedConnectionName,
      deviceId: resolvedDeviceId,
      profileSource,
      sessionId,
      sessionName: resolvedSessionName,
    });

    const session = await openSSHSession({
      cols: resolvedCols,
      closedRetentionMs: resolvedClosedRetentionMs,
      host: resolvedHost,
      idleTimeoutMs: resolvedIdleTimeoutMs,
      keyPath: key,
      metadata,
      password,
      profile,
      port: resolvedPort,
      rows: resolvedRows,
      sessionId,
      sessionName: resolvedSessionName,
      term: resolvedTerm,
      user: resolvedUser,
    });

    sessions.set(session.sessionId, session);
    setActiveSession(session);
    logSessionEvent(session.sessionId, 'session.opened', {
      authSource: profile ? summarizeAuth(profile) : (sanitizeOptionalText(password) ? 'password' : sanitizeOptionalText(key) ? 'keyPath' : DEFAULT_PASSWORD ? 'password' : DEFAULT_KEY ? 'keyPath' : 'none'),
      connectionName: resolvedConnectionName,
      deviceId: resolvedDeviceId,
      host: resolvedHost,
      port: resolvedPort,
      profileSource,
      sessionRef: metadata.sessionRef,
      sessionName: resolvedSessionName,
      user: resolvedUser,
    });
    logServerEvent('session.opened', {
      authSource: profile ? summarizeAuth(profile) : (sanitizeOptionalText(password) ? 'password' : sanitizeOptionalText(key) ? 'keyPath' : DEFAULT_PASSWORD ? 'password' : DEFAULT_KEY ? 'keyPath' : 'none'),
      connectionName: resolvedConnectionName,
      deviceId: resolvedDeviceId,
      host: resolvedHost,
      port: resolvedPort,
      profileSource,
      sessionId: session.sessionId,
      sessionRef: metadata.sessionRef,
      sessionName: resolvedSessionName,
      user: resolvedUser,
    });

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
    let autoOpenTerminalUrl: string | undefined;
    let autoOpenTerminalError: string | undefined;
    if (AUTO_OPEN_TERMINAL && getViewerBaseUrl()) {
      try {
        const termUrl = `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(session.sessionId)}`;
        if (VIEWER_LAUNCH_MODE === 'terminal') {
          await ensureViewerForSession(session, {
            mode: 'terminal',
            scope: 'session',
          });
        } else {
          await launchBrowserViewer(termUrl);
        }
        autoOpenTerminalUrl = termUrl;
      } catch (error) {
        autoOpenTerminalError = error instanceof Error ? error.message : String(error);
      }
    }
    const dashboard = buildDashboard(session, {
      width: resolvedDashboardWidth,
      height: resolvedDashboardHeight,
      leftChars: resolvedDashboardLeftChars,
      rightEvents: resolvedDashboardRightEvents,
      stripAnsiFromLeft: resolvedStripAnsi,
    });

    return createJsonToolResponse(applyToolContract({
      ...session.summary(),
      activeSession: true,
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
      viewerPort: actualViewerPort || undefined,
      viewerState,
      viewerAutoOpenError,
      autoOpenTerminalUrl,
      autoOpenTerminalError,
      configPath: PROFILES.path,
      configPaths: PROFILES.paths,
      configResolution: PROFILES.resolution,
    }, {
      resultStatus: 'success',
      summary: `Opened SSH session ${metadata.sessionRef}.`,
      nextAction: 'Use ssh-run or ssh-session-send to interact with the active session.',
      evidence: [
        `sessionRef=${metadata.sessionRef}`,
        `host=${resolvedUser}@${resolvedHost}:${resolvedPort}`,
        `viewerBaseUrl=${getViewerBaseUrl() || '(disabled)'}`,
      ],
    }), resolvedIncludeDashboard ? [dashboard] : []);
  },
);

server.tool(
  'ssh-session-send',
  'Send raw input to an interactive SSH PTY session. Actor is shown inline in the dashboard transcript.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    input: z.string().describe('Raw text to send into the PTY'),
    appendNewline: z.boolean().optional().describe('Append a newline after the input'),
    actor: z.string().optional().describe('Label for the sender shown inline in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, input, appendNewline, actor }) => {
    const target = resolveSession(session);
    if (input.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'input cannot be empty');
    }

    if (target.inputLock === 'user') {
      return createJsonToolResponse(applyToolContract({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send input.',
      }, {
        resultStatus: 'blocked',
        summary: 'Raw input was blocked because the terminal is locked by the user.',
        failureCategory: 'input-locked',
        nextAction: 'Ask the user to switch the browser terminal back to common or agent mode.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'inputLock=user',
        ],
      }));
    }

    const payload = appendNewline === true ? `${input}\n` : input;
    const resolvedActor = sanitizeActor(actor, 'agent');
    target.write(payload, resolvedActor);
    logSessionEvent(target.sessionId, 'session.input', {
      actor: resolvedActor,
      sentChars: payload.length,
    });

    return createJsonToolResponse(applyToolContract({
      ...target.summary(),
      actor: resolvedActor,
      sentChars: payload.length,
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, {
      resultStatus: 'success',
      summary: `Sent ${payload.length} character(s) to ${sessionReadRef(target)}.`,
      nextAction: 'Use ssh-session-read or ssh-session-watch to inspect the resulting output.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `actor=${resolvedActor}`,
      ],
    }));
  },
);

server.tool(
  'ssh-device-list',
  'List configured SSH device profiles discovered from ssh-session-mcp.config.json.',
  {},
  async () => {
    const defaultDeviceId = resolveConfiguredDefaultDeviceId();
    const devices = (PROFILES.config?.devices || []).map(device => ({
      id: device.id,
      label: device.label,
      host: device.host,
      port: device.port ?? 22,
      user: device.user,
      auth: summarizeAuth(device),
      tags: device.tags || [],
      defaults: device.defaults || {},
      isDefault: device.id === defaultDeviceId,
    }));

    return createJsonToolResponse(applyToolContract({
      instanceId: INSTANCE_ID,
      source: PROFILES.source,
      configPath: PROFILES.path,
      configPaths: PROFILES.paths,
      configResolution: PROFILES.resolution,
      defaults: PROFILES.config?.defaults || {},
      defaultDevice: defaultDeviceId,
      devices,
      legacyDefaults: PROFILES.source === 'legacy-env' ? {
        hostConfigured: Boolean(DEFAULT_HOST),
        userConfigured: Boolean(DEFAULT_USER),
        port: DEFAULT_PORT,
      } : undefined,
    }, {
      resultStatus: 'success',
      summary: PROFILES.source === 'legacy-env'
        ? 'No profile config file is active; legacy environment-variable mode is in use.'
        : `Loaded ${devices.length} device profile(s).`,
      nextAction: devices.length > 0
        ? 'Use ssh-quick-connect with device and optional connectionName to open a session.'
        : 'Add a device profile with the config CLI or create ssh-session-mcp.config.json.',
      evidence: [
        `source=${PROFILES.source}`,
        `configPath=${PROFILES.path || '(none)'}`,
        `defaultDevice=${defaultDeviceId || '(none)'}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-read',
  'Read raw buffered terminal output from an SSH PTY session. Supports optional long-polling for new terminal output.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    offset: z.number().int().nonnegative().optional().describe('Read from this output offset. If omitted, return the latest tail'),
    maxChars: z.number().int().positive().optional().describe('Maximum chars to return'),
    waitForChangeMs: z.number().int().nonnegative().optional().describe('Wait up to this many milliseconds for new terminal output before returning'),
  },
  async ({ session, offset, maxChars, waitForChangeMs }) => {
    const target = resolveSession(session);
    const resolvedMaxChars = sanitizePositiveInt(maxChars, 'maxChars', DEFAULT_READ_CHARS);
    const resolvedWaitMs = sanitizeNonNegativeInt(waitForChangeMs, 'waitForChangeMs', 0);
    const baselineOffset = typeof offset === 'number' ? offset : target.currentBufferEnd();

    if (resolvedWaitMs > 0) {
      await target.waitForChange({ outputOffset: baselineOffset, waitMs: resolvedWaitMs });
    }

    const snapshot = target.read(offset, resolvedMaxChars);
    const readProgress = buildReadProgress(snapshot);

    return createJsonToolResponse(applyToolContract({
      ...target.summary(),
      requestedOffset: snapshot.requestedOffset,
      effectiveOffset: snapshot.effectiveOffset,
      nextOffset: snapshot.nextOffset,
      truncatedBefore: snapshot.truncatedBefore,
      truncatedAfter: snapshot.truncatedAfter,
      returnedChars: snapshot.output.length,
      waitedMs: resolvedWaitMs,
      ...readProgress,
      readMore: snapshot.truncatedAfter
        ? buildSnapshotReadMore(sessionReadRef(target), snapshot, resolvedMaxChars)
        : undefined,
    }, {
      resultStatus: 'success',
      summary: `Read ${snapshot.output.length} character(s) from ${sessionReadRef(target)}.`,
      nextAction: snapshot.truncatedAfter
        ? 'Use nextOffset with ssh-session-read to continue reading buffered output.'
        : 'Use ssh-session-watch for live updates or ssh-run for the next command.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `nextOffset=${snapshot.nextOffset}`,
        `truncatedAfter=${snapshot.truncatedAfter}`,
      ],
    }), [snapshot.output.length > 0 ? `[output]\n${snapshot.output}` : '']);
  },
);

server.tool(
  'ssh-session-watch',
  'Long-poll an SSH PTY session and render a terminal-style dashboard with inline actor markers.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    outputOffset: z.number().int().nonnegative().optional().describe('Wait until terminal output grows beyond this offset'),
    eventSeq: z.number().int().nonnegative().optional().describe('Wait until transcript events grow beyond this sequence number'),
    waitForChangeMs: z.number().int().nonnegative().optional().describe('Long-poll duration in milliseconds'),
    dashboardWidth: z.number().int().positive().optional().describe('Rendered dashboard width in columns'),
    dashboardHeight: z.number().int().positive().optional().describe('Rendered dashboard height in rows'),
    dashboardLeftChars: z.number().int().positive().optional().describe('How many recent transcript chars to retain in the rendered viewer'),
    dashboardRightEvents: z.number().int().positive().optional().describe('How many recent input/control/lifecycle events to retain for actor markers'),
    stripAnsiFromLeft: z.boolean().optional().describe('Strip ANSI escape sequences from rendered SSH output'),
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
    const target = resolveSession(session);
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

    return createJsonToolResponse(applyToolContract({
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
    }, {
      resultStatus: 'success',
      summary: `Observed ${sessionReadRef(target)} for up to ${resolvedWaitMs} ms.`,
      nextAction: nextOutputOffset > baselineOutputOffset || nextEventSeq > baselineEventSeq
        ? 'Inspect the returned offsets or dashboard, then continue with ssh-run, ssh-session-read, or another watch call.'
        : 'No change detected yet. Poll again with ssh-session-watch if needed.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `outputChanged=${nextOutputOffset > baselineOutputOffset}`,
        `eventChanged=${nextEventSeq > baselineEventSeq}`,
      ],
    }), resolvedIncludeDashboard ? [dashboard] : []);
  },
);

server.tool(
  'ssh-session-history',
  'Read line-numbered session history built from terminal output and user/agent actions.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    line: z.number().int().nonnegative().optional().describe('Read from this history line number'),
    maxLines: z.number().int().positive().optional().describe('Maximum number of history lines to return'),
  },
  async ({ session, line, maxLines }) => {
    const target = resolveSession(session);
    const resolvedMaxLines = sanitizePositiveInt(maxLines, 'maxLines', 80);
    const snapshot = target.readHistory(line, resolvedMaxLines);

    return createJsonToolResponse(applyToolContract({
      ...target.summary(),
      requestedLine: snapshot.requestedLine,
      effectiveLine: snapshot.effectiveLine,
      nextLine: snapshot.nextLine,
      availableStart: snapshot.availableStart,
      availableEnd: snapshot.availableEnd,
      truncatedBefore: snapshot.truncatedBefore,
      truncatedAfter: snapshot.truncatedAfter,
      returnedLines: snapshot.lines.length,
    }, {
      resultStatus: 'success',
      summary: `Read ${snapshot.lines.length} history line(s) from ${sessionReadRef(target)}.`,
      nextAction: snapshot.truncatedAfter
        ? 'Use nextLine with ssh-session-history to continue reading later lines.'
        : 'Use ssh-session-watch or ssh-run if you need fresh activity.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `nextLine=${snapshot.nextLine}`,
        `truncatedAfter=${snapshot.truncatedAfter}`,
      ],
    }), [snapshot.view.length > 0 ? snapshot.view : '(no history yet)']);
  },
);

server.tool(
  'ssh-session-control',
  'Send a control key to an interactive SSH PTY session. Actor is shown inline in the dashboard transcript.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    control: z.enum(['ctrl_c', 'ctrl_d', 'enter', 'tab', 'esc', 'up', 'down', 'left', 'right', 'backspace']).describe('Control key to send'),
    actor: z.string().optional().describe('Label for the sender shown inline in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, control, actor }) => {
    const target = resolveSession(session);

    if (target.inputLock === 'user') {
      return createJsonToolResponse(applyToolContract({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send control keys.',
      }, {
        resultStatus: 'blocked',
        summary: 'Control input was blocked because the terminal is locked by the user.',
        failureCategory: 'input-locked',
        nextAction: 'Ask the user to switch the browser terminal back to common or agent mode.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'inputLock=user',
        ],
      }));
    }

    const resolvedActor = sanitizeActor(actor, 'agent');
    target.sendControl(control, resolvedActor);
    logSessionEvent(target.sessionId, 'session.control', {
      actor: resolvedActor,
      control,
    });

    return createJsonToolResponse(applyToolContract({
      ...target.summary(),
      actor: resolvedActor,
      control,
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, {
      resultStatus: 'success',
      summary: `Sent control key ${control} to ${sessionReadRef(target)}.`,
      nextAction: 'Use ssh-session-read or ssh-session-watch to inspect the resulting output.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `actor=${resolvedActor}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-resize',
  'Resize the PTY window of an interactive SSH session.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    cols: z.number().int().positive().describe('New column count'),
    rows: z.number().int().positive().describe('New row count'),
  },
  async ({ session, cols, rows }) => {
    const target = resolveSession(session);
    target.resize(
      sanitizePositiveInt(cols, 'cols', DEFAULT_COLS),
      sanitizePositiveInt(rows, 'rows', DEFAULT_ROWS),
    );
    logSessionEvent(target.sessionId, 'session.resize', {
      cols: target.cols,
      rows: target.rows,
    });

    return createJsonToolResponse(applyToolContract({
      ...target.summary(),
      nextOutputOffset: target.currentBufferEnd(),
      nextEventSeq: target.currentEventEnd(),
    }, {
      resultStatus: 'success',
      summary: `Resized ${sessionReadRef(target)} to ${target.cols}x${target.rows}.`,
      nextAction: 'Continue using the session or reopen the viewer if your local terminal did not refresh.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `cols=${target.cols}`,
        `rows=${target.rows}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-list',
  'List tracked SSH PTY sessions. Closed sessions are kept briefly for inspection, then automatically pruned.',
  {
    includeClosed: z.boolean().optional().describe('Include recently closed retained sessions'),
    device: z.string().optional().describe('Filter by device id'),
    connectionName: z.string().optional().describe('Filter by connection name'),
  },
  async ({ includeClosed, device, connectionName }) => {
    sweepSessions();
    const deviceFilter = sanitizeOptionalText(device);
    const connectionFilter = sanitizeOptionalText(connectionName);

    const tracked = [...sessions.values()]
      .filter(session => includeClosed === true || !session.closed)
      .filter(session => !deviceFilter || session.metadata.deviceId === deviceFilter)
      .filter(session => !connectionFilter || session.metadata.connectionName === connectionFilter)
      .map(session => session.summary())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return createJsonToolResponse(applyToolContract({
      activeSessionRef: refreshActiveSession()?.metadata.sessionRef || null,
      sessions: tracked,
    }, {
      resultStatus: 'success',
      summary: `Listed ${tracked.length} tracked session(s).`,
      nextAction: tracked.length > 0
        ? 'Use ssh-session-set-active to change the default target, or ssh-session-close to remove one.'
        : 'Use ssh-quick-connect or ssh-session-open to create a new session.',
      evidence: [
        `includeClosed=${includeClosed === true}`,
        `deviceFilter=${deviceFilter || '(none)'}`,
        `connectionFilter=${connectionFilter || '(none)'}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-diagnostics',
  'Inspect session health, buffer trim state, viewer attachment state, input lock state, and tracked command metadata.',
  {
    session: z.string().optional().describe('Session id or unique session name. Omit to inspect all tracked sessions'),
  },
  async ({ session }) => {
    sweepSessions();
    const sessionRef = sanitizeOptionalText(session);
    if (sessionRef) {
      const target = resolveSession(sessionRef);
      return createJsonToolResponse(applyToolContract(buildSessionDiagnostics(target), {
        resultStatus: 'success',
        summary: `Built diagnostics for ${sessionReadRef(target)}.`,
        nextAction: 'Review warnings and lock state before sending more commands.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
        ],
      }));
    }

    const reports = [...sessions.values()]
      .map(buildSessionDiagnostics)
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));

    return createJsonToolResponse(applyToolContract(buildDiagnosticsOverview({
      sessions: reports,
      logDir: LOG_CONFIG.dir,
      logMode: LOG_CONFIG.mode,
    }), {
      resultStatus: 'success',
      summary: `Built diagnostics overview for ${reports.length} session(s).`,
      nextAction: reports.length > 0
        ? 'Inspect a specific session with ssh-session-diagnostics { session }.'
        : 'Create a session first with ssh-quick-connect or ssh-session-open.',
      evidence: [
        `sessionCount=${reports.length}`,
        `logMode=${LOG_CONFIG.mode}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-set-active',
  'Set or clear the active session used by tools when the session argument is omitted.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Omit to clear the active session'),
  },
  async ({ session }) => {
    const requested = sanitizeOptionalText(session);
    if (!requested) {
      setActiveSession(undefined);
      logServerEvent('session.active_cleared', {});
      return createJsonToolResponse(applyToolContract({
        instanceId: INSTANCE_ID,
        activeSessionId: null,
        activeSessionRef: null,
      }, {
        resultStatus: 'success',
        summary: 'Cleared the active session pointer.',
        nextAction: 'Open or select a session before omitting the session argument in other tools.',
        evidence: [`instanceId=${INSTANCE_ID}`],
      }));
    }

    const target = resolveSession(requested);
    setActiveSession(target);
    logServerEvent('session.active_set', {
      sessionId: target.sessionId,
      sessionRef: target.metadata.sessionRef,
    });
    return createJsonToolResponse(applyToolContract({
      instanceId: INSTANCE_ID,
      activeSessionId: target.sessionId,
      activeSessionRef: target.metadata.sessionRef,
      session: target.summary(),
    }, {
      resultStatus: 'success',
      summary: `Active session set to ${target.metadata.sessionRef}.`,
      nextAction: 'Subsequent tools may omit the session argument and will target this session.',
      evidence: [
        `instanceId=${INSTANCE_ID}`,
        `sessionRef=${target.metadata.sessionRef}`,
      ],
    }));
  },
);

server.tool(
  'ssh-viewer-ensure',
  'Ensure that a viewer exists for a session. Terminal mode is singleton-scoped and will reuse a running viewer instead of opening duplicates.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
    mode: z.enum(['terminal', 'browser']).optional().describe('Viewer launch mode'),
    singletonScope: z.enum(['connection', 'session']).optional().describe('Deduplication scope for terminal viewers'),
  },
  async ({ session, mode, singletonScope }) => {
    const target = resolveSession(session);
    const result = await ensureViewerForSession(target, {
      mode: viewerModeValue(mode),
      scope: viewerScopeValue(singletonScope || CONFIG_DEFAULTS?.viewerSingletonScope),
    });

    return createJsonToolResponse(applyToolContract({
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
    }, {
      resultStatus: 'success',
      summary: result.reusedExistingProcess
        ? `Reused viewer for ${sessionReadRef(target)}.`
        : `Ensured viewer for ${sessionReadRef(target)}.`,
      nextAction: result.viewerUrl
        ? `Open ${result.viewerUrl} in a browser or terminal viewer.`
        : 'Viewer is unavailable because the HTTP viewer server is disabled.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `mode=${result.mode}`,
        `scope=${result.scope}`,
      ],
    }));
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

    return createJsonToolResponse(applyToolContract({
      viewerBaseUrl: getViewerBaseUrl(),
      viewers: records,
      bindings: [...viewerBindings.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }, {
      resultStatus: 'success',
      summary: `Listed ${records.length} viewer process record(s).`,
      nextAction: records.length > 0
        ? 'Use ssh-viewer-ensure to reopen a viewer if a terminal process has exited.'
        : 'Open a session first, then call ssh-viewer-ensure.',
      evidence: [
        `viewerBaseUrl=${getViewerBaseUrl() || '(disabled)'}`,
      ],
    }));
  },
);

server.tool(
  'ssh-session-close',
  'Close an interactive SSH PTY session immediately and remove it from the MCP server.',
  {
    session: z.string().optional().describe('Session id, session ref, or session name. Defaults to the active session'),
  },
  async ({ session }) => {
    const target = resolveSession(session);
    const summary = target.summary();
    logSessionEvent(target.sessionId, 'session.closed', { reason: 'closed by client' });
    logServerEvent('session.closed', { reason: 'closed by client', sessionId: target.sessionId });
    target.close();
    sessions.delete(target.sessionId);
    if (activeSessionId === target.sessionId) {
      setActiveSession(undefined);
      refreshActiveSession();
    }

    return createJsonToolResponse(applyToolContract({
      ...summary,
      removed: true,
    }, {
      resultStatus: 'success',
      summary: `Closed SSH session ${summary.sessionRef}.`,
      nextAction: 'Use ssh-session-list to confirm remaining sessions or ssh-quick-connect to open a new one.',
      evidence: [
        `sessionRef=${summary.sessionRef}`,
        `sessionId=${summary.sessionId}`,
      ],
    }));
  },
);

// ── Simplified tools for AI agents ──────────────────────────────────────────

server.tool(
  'ssh-quick-connect',
  'One-step: open SSH session using .env defaults, auto-open browser terminal, return terminal URL. If a session already exists, reuse it. AI agents should call this once at the start of a conversation.',
  {
    sessionName: z.string().optional().describe('Optional session name. Defaults to "default"'),
    device: z.string().optional().describe('Device profile id. Defaults to config defaultDevice when available'),
    connectionName: z.string().optional().describe('Logical connection name. Defaults to "main" for profile-based sessions'),
  },
  async ({ sessionName, device, connectionName }) => {
    sweepSessions();
    const requestedDeviceId = sanitizeOptionalText(device);
    const configuredDefaultDeviceId = resolveConfiguredDefaultDeviceId();
    const resolvedDeviceId = requestedDeviceId || configuredDefaultDeviceId;
    const requestedSessionName = sanitizeOptionalText(sessionName);

    if (!resolvedDeviceId && sanitizeOptionalText(connectionName)) {
      throw new McpError(ErrorCode.InvalidParams, 'connectionName requires device or defaultDevice configuration');
    }

    if (resolvedDeviceId) {
      const profile = resolveProfileOrThrow(resolvedDeviceId);
      const profileDefaults = profile.defaults;
      const resolvedConnectionName = sanitizeOptionalText(connectionName) || 'main';
      const existing = findOpenProfileSession(resolvedDeviceId, resolvedConnectionName);
      if (existing) {
        setActiveSession(existing);
        const terminalUrl = getViewerBaseUrl()
          ? `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(existing.sessionId)}`
          : undefined;
        return createJsonToolResponse(applyToolContract({
          reused: true,
          instanceId: INSTANCE_ID,
          activeSessionRef: existing.metadata.sessionRef,
          session: existing.summary(),
          terminalUrl,
          viewerBaseUrl: getViewerBaseUrl(),
          hint: 'Session already exists. Use ssh-run without a session argument or call ssh-session-set-active first.',
          configPath: PROFILES.path,
          configPaths: PROFILES.paths,
        }, {
          resultStatus: 'success',
          summary: `Reused existing session ${existing.metadata.sessionRef}.`,
          nextAction: 'Use ssh-run without a session argument to target the active session.',
          evidence: [
            `sessionRef=${existing.metadata.sessionRef}`,
            `instanceId=${INSTANCE_ID}`,
          ],
        }));
      }

      if (requestedSessionName) {
        ensureUniqueSessionName(requestedSessionName);
      }

      const sessionId = randomUUID();
      const metadata = buildSessionMetadata({
        connectionName: resolvedConnectionName,
        deviceId: resolvedDeviceId,
        profileSource: 'profile',
        sessionId,
        sessionName: requestedSessionName,
      });
      const session = await openSSHSession({
        cols: profileDefaults?.cols ?? DEFAULT_COLS,
        closedRetentionMs: profileDefaults?.closedRetentionMs ?? DEFAULT_CLOSED_RETENTION_MS,
        host: profile.host,
        idleTimeoutMs: profileDefaults?.idleTimeoutMs ?? DEFAULT_TIMEOUT,
        metadata,
        profile,
        port: profile.port ?? DEFAULT_PORT,
        rows: profileDefaults?.rows ?? DEFAULT_ROWS,
        sessionId,
        sessionName: requestedSessionName,
        term: profileDefaults?.term ?? DEFAULT_TERM,
        user: profile.user,
      });

      sessions.set(sessionId, session);
      setActiveSession(session);
      logSessionEvent(session.sessionId, 'session.opened', {
        authSource: summarizeAuth(profile),
        connectionName: resolvedConnectionName,
        deviceId: resolvedDeviceId,
        host: profile.host,
        port: profile.port ?? DEFAULT_PORT,
        profileSource: 'profile',
        sessionRef: metadata.sessionRef,
        sessionName: requestedSessionName,
        user: profile.user,
      });
      logServerEvent('session.opened', {
        authSource: summarizeAuth(profile),
        connectionName: resolvedConnectionName,
        deviceId: resolvedDeviceId,
        host: profile.host,
        port: profile.port ?? DEFAULT_PORT,
        profileSource: 'profile',
        sessionId,
        sessionRef: metadata.sessionRef,
        sessionName: requestedSessionName,
        user: profile.user,
      });

      let terminalUrl: string | undefined;
      if (getViewerBaseUrl()) {
        terminalUrl = `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(sessionId)}`;
        if (profileDefaults?.autoOpenViewer === true || AUTO_OPEN_TERMINAL) {
          try {
            const mode = viewerModeValue(profileDefaults?.viewerMode || VIEWER_LAUNCH_MODE);
            if (mode === 'terminal') {
              await ensureViewerForSession(session, {
                mode: 'terminal',
                scope: 'session',
              });
            } else {
              await launchBrowserViewer(terminalUrl);
            }
          } catch {
            // ignore auto-open failures for quick-connect
          }
        }
      }

      await delay(300);

      return createJsonToolResponse(applyToolContract({
        reused: false,
        instanceId: INSTANCE_ID,
        activeSessionRef: metadata.sessionRef,
        configPath: PROFILES.path,
        configPaths: PROFILES.paths,
        terminalUrl,
        viewerBaseUrl: getViewerBaseUrl(),
        session: session.summary(),
        hint: 'Session opened. Use ssh-run without a session argument to target the active session.',
      }, {
        resultStatus: 'success',
        summary: `Opened new profile session ${metadata.sessionRef}.`,
        nextAction: 'Use ssh-run without a session argument to target the active session.',
        evidence: [
          `sessionRef=${metadata.sessionRef}`,
          `deviceId=${resolvedDeviceId}`,
          `connectionName=${resolvedConnectionName}`,
        ],
      }));
    }

    const name = requestedSessionName || 'default';
    const existing = findOpenSessionByName(name);
    if (existing) {
      setActiveSession(existing);
      const terminalUrl = getViewerBaseUrl()
        ? `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(existing.sessionId)}`
        : undefined;
      return createJsonToolResponse(applyToolContract({
        reused: true,
        instanceId: INSTANCE_ID,
        activeSessionRef: existing.metadata.sessionRef,
        session: existing.summary(),
        terminalUrl,
        viewerBaseUrl: getViewerBaseUrl(),
        hint: 'Session already exists. Use ssh-run without a session argument to target the active session.',
        configPath: PROFILES.path,
        configPaths: PROFILES.paths,
      }, {
        resultStatus: 'success',
        summary: `Reused existing session ${existing.metadata.sessionRef}.`,
        nextAction: 'Use ssh-run without a session argument to target the active session.',
        evidence: [
          `sessionRef=${existing.metadata.sessionRef}`,
          `instanceId=${INSTANCE_ID}`,
        ],
      }));
    }

    const resolvedHost = DEFAULT_HOST;
    const resolvedUser = DEFAULT_USER;
    if (!resolvedHost) throw new McpError(ErrorCode.InvalidParams, 'SSH_HOST not configured. Set it in .env or pass --host');
    if (!resolvedUser) throw new McpError(ErrorCode.InvalidParams, 'SSH_USER not configured. Set it in .env or pass --user');

    const sessionId = randomUUID();
    const metadata = buildSessionMetadata({
      profileSource: 'legacy-env',
      sessionId,
      sessionName: name,
    });
    const session = await openSSHSession({
      cols: DEFAULT_COLS,
      closedRetentionMs: DEFAULT_CLOSED_RETENTION_MS,
      host: resolvedHost,
      idleTimeoutMs: DEFAULT_TIMEOUT,
      metadata,
      port: DEFAULT_PORT,
      rows: DEFAULT_ROWS,
      sessionId,
      sessionName: name,
      term: DEFAULT_TERM,
      user: resolvedUser,
    });

    sessions.set(sessionId, session);
    setActiveSession(session);
    logSessionEvent(session.sessionId, 'session.opened', {
      host: resolvedHost,
      port: DEFAULT_PORT,
      profileSource: 'legacy-env',
      sessionRef: metadata.sessionRef,
      sessionName: name,
      user: resolvedUser,
    });
    logServerEvent('session.opened', {
      sessionId,
      host: resolvedHost,
      port: DEFAULT_PORT,
      profileSource: 'legacy-env',
      sessionRef: metadata.sessionRef,
      sessionName: name,
      user: resolvedUser,
    });

    // Auto open terminal
    let terminalUrl: string | undefined;
    if (getViewerBaseUrl()) {
      terminalUrl = `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(sessionId)}`;
      if (AUTO_OPEN_TERMINAL) {
        try {
          if (VIEWER_LAUNCH_MODE === 'terminal') {
            await ensureViewerForSession(session, {
              mode: 'terminal',
              scope: 'session',
            });
          } else {
            await launchBrowserViewer(terminalUrl);
          }
        } catch { /* ignore */ }
      }
    }

    await delay(300);

    return createJsonToolResponse(applyToolContract({
      reused: false,
      instanceId: INSTANCE_ID,
      activeSessionRef: metadata.sessionRef,
      configPath: PROFILES.path,
      configPaths: PROFILES.paths,
      terminalUrl,
      viewerBaseUrl: getViewerBaseUrl(),
      session: session.summary(),
      hint: 'Session opened. Use ssh-run without a session argument to target the active session. The user can also type in the browser terminal.',
    }, {
      resultStatus: 'success',
      summary: `Opened new session ${metadata.sessionRef}.`,
      nextAction: 'Use ssh-run without a session argument to target the active session.',
      evidence: [
        `sessionRef=${metadata.sessionRef}`,
        `instanceId=${INSTANCE_ID}`,
      ],
    }));
  },
);

server.tool(
  'ssh-run',
  'Execute a command in the SSH session and return the output. Uses intelligent completion detection (prompt matching + idle timeout). In safe mode, dangerous/interactive commands are blocked. Long-running commands automatically transition to async mode.',
  {
    command: z.string().describe('Shell command to execute'),
    session: z.string().optional().describe('Session name or id. Defaults to "default"'),
    waitMs: z.number().int().nonnegative().optional().describe('Maximum wait time in ms (default 30000). Command may return earlier if prompt detected or idle timeout reached.'),
    idleMs: z.number().int().positive().optional().describe('Idle timeout in ms - if no new output for this duration, consider command done (default 2000)'),
    maxChars: z.number().int().positive().optional().describe('Max chars to read from output (default 16000). When output exceeds this limit, head (30%) and tail (70%) are returned with the middle omitted.'),
  },
  async ({ command, session, waitMs, idleMs, maxChars }) => {
    sweepSessions();
    const target = resolveSession(session);
    const commandMeta = summarizeCommandMeta(command);

    if (target.inputLock === 'user') {
      return createJsonToolResponse(applyToolContract({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send commands.',
      }, {
        resultStatus: 'blocked',
        summary: 'Command execution was blocked because the user currently owns terminal input.',
        failureCategory: 'input-locked',
        nextAction: 'Ask the user to switch the browser terminal back to common or agent mode.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'inputLock=user',
        ],
      }));
    }

    // Mutual exclusion: reject if another agent command is already running
    if (target.inputLock === 'agent') {
      return createJsonToolResponse(applyToolContract({
        error: 'AGENT_BUSY',
        lock: 'agent',
        message: 'Another agent command is already running on this session. Wait for it to complete or use ssh-command-status to check progress.',
      }, {
        resultStatus: 'blocked',
        summary: 'Command execution was blocked because another agent command is still active.',
        failureCategory: 'runtime-state-abnormal',
        nextAction: 'Wait for the running command to finish or check it with ssh-command-status.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'inputLock=agent',
        ],
      }));
    }

    // Command validation
    const validation = validateCommand(command, OPERATION_MODE);
    if (!validation.allowed) {
      logSessionEvent(target.sessionId, 'command.blocked', {
        category: validation.category,
        operationMode: OPERATION_MODE,
        ...commandMeta,
      });
      return createJsonToolResponse(applyToolContract({
        error: 'COMMAND_BLOCKED',
        category: validation.category,
        message: validation.message,
        suggestion: validation.suggestion,
        operationMode: OPERATION_MODE,
      }, {
        resultStatus: 'blocked',
        summary: 'Command policy blocked execution in the current operation mode.',
        failureCategory: 'policy-blocked',
        nextAction: validation.suggestion || 'Adjust the command or switch the terminal to a more suitable mode.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          `operationMode=${OPERATION_MODE}`,
          `category=${validation.category}`,
        ],
      }));
    }

    // Terminal mode check
    const bufferTail = target.buffer.slice(-2000);
    const terminalMode = detectTerminalMode(bufferTail);

    // Password prompt blocks in ALL modes — sending a command here would type it as password
    if (terminalMode === 'password_prompt') {
      logSessionEvent(target.sessionId, 'command.blocked_password_prompt', {
        operationMode: OPERATION_MODE,
        ...commandMeta,
      });
      return createJsonToolResponse(applyToolContract({
        error: 'PASSWORD_REQUIRED',
        terminalMode: 'password_prompt',
        message: 'Terminal is at a password prompt. DO NOT send commands — they will be typed as the password.',
        suggestion: 'Options: (1) Ask the user to enter the password in the browser terminal. (2) Use ssh-session-control to send ctrl_c to cancel. (3) If you know the password, use ssh-session-send to type it directly.',
        operationMode: OPERATION_MODE,
      }, {
        resultStatus: 'blocked',
        summary: 'Command execution was blocked because the terminal is currently waiting for a password.',
        failureCategory: 'terminal-state-abnormal',
        nextAction: 'Ask the user to resolve the password prompt or cancel it before running another command.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'terminalMode=password_prompt',
        ],
      }));
    }

    // Editor/pager check — only blocks in safe mode
    if (OPERATION_MODE === 'safe' && (terminalMode === 'editor' || terminalMode === 'pager')) {
      logSessionEvent(target.sessionId, 'command.blocked_terminal_mode', {
        operationMode: OPERATION_MODE,
        terminalMode,
        ...commandMeta,
      });
      return createJsonToolResponse(applyToolContract({
        error: 'WRONG_TERMINAL_MODE',
        terminalMode,
        message: `Terminal is in ${terminalMode} mode. Cannot execute commands in this state.`,
        suggestion: terminalMode === 'editor' ? 'Send ctrl_c or ctrl_d via ssh-session-control to exit the editor first.'
          : 'Send "q" via ssh-session-control to exit the pager first.',
        operationMode: OPERATION_MODE,
      }, {
        resultStatus: 'blocked',
        summary: `Command execution was blocked because the terminal is in ${terminalMode} mode.`,
        failureCategory: 'terminal-state-abnormal',
        nextAction: terminalMode === 'editor'
          ? 'Exit the editor before issuing shell commands.'
          : 'Exit the pager before issuing shell commands.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          `terminalMode=${terminalMode}`,
        ],
      }));
    }

    // Acquire agent lock
    target.inputLock = 'agent';
    broadcastLock(target);

    try {

    const resolvedWaitMs = sanitizeNonNegativeInt(waitMs, 'waitMs', 30000);
    const resolvedIdleMs = sanitizePositiveInt(idleMs, 'idleMs', 2000);
    const resolvedMaxChars = sanitizePositiveInt(maxChars, 'maxChars', 16000);
    const immediateAsync = isKnownSlowCommand(command);

    // Construct sentinel marker for deterministic completion detection
    const sentinelId = randomUUID().slice(0, 8);
    const sentinelMarker = `___MCP_DONE_${sentinelId}_`;
    const useMarker = USE_SENTINEL_MARKER && !immediateAsync && validation.category !== 'interactive';

    const beforeOffset = target.currentBufferEnd();
    const startedAt = new Date().toISOString();
    const sentinelSuffix = useMarker ? buildSentinelCommandSuffix(sentinelMarker) : undefined;
    logSessionEvent(target.sessionId, 'command.started', {
      operationMode: OPERATION_MODE,
      startedAt,
      terminalMode,
      ...commandMeta,
    });
    if (useMarker) {
      // Use __MCP_EC to capture exit code reliably even with pipes
      target.write(`${command}${sentinelSuffix}\n`, 'agent');
    } else {
      target.write(`${command}\n`, 'agent');
    }

    // Wait for command completion using intelligent detection
    let completion: CompletionResult;
    if (immediateAsync) {
      // Known slow command: short wait just to capture initial output
      completion = await target.waitForCompletion({
        startOffset: beforeOffset,
        maxWaitMs: 3000,
        idleMs: resolvedIdleMs,
        promptPatterns: DEFAULT_PROMPT_PATTERNS,
      });
    } else if (resolvedWaitMs > 0) {
      completion = await target.waitForCompletion({
        startOffset: beforeOffset,
        maxWaitMs: resolvedWaitMs,
        idleMs: resolvedIdleMs,
        promptPatterns: DEFAULT_PROMPT_PATTERNS,
        sentinel: useMarker ? sentinelMarker : undefined,
      });
    } else {
      completion = { completed: false, reason: 'timeout', elapsedMs: 0 };
    }

    // Async transition for long-running commands
    if (completion.reason === 'timeout' || (immediateAsync && !completion.completed)) {
      const commandId = randomUUID();
      const entry: RunningCommand = {
        commandId,
        sessionId: target.sessionId,
        command,
        commandProgram: commandMeta.commandProgram,
        startOffset: beforeOffset,
        startedAt,
        startTime: Date.now(),
        status: 'running',
        sentinelMarker: useMarker ? sentinelMarker : undefined,
        sentinelSuffix,
      };
      runningCommands.set(commandId, entry);
      logSessionEvent(target.sessionId, 'command.promoted_async', {
        commandId,
        startedAt,
        ...commandMeta,
      });

      // Release lock
      target.inputLock = 'none';
      broadcastLock(target);

      // Start background monitor
      startBackgroundMonitor(entry, target);

      const partialSnapshot = target.read(beforeOffset, resolvedMaxChars);
      const partialOutput = cleanCommandOutput(partialSnapshot.output, command, {
        sentinelMarker: useMarker ? sentinelMarker : undefined,
        sentinelSuffix,
      });
      const readMore = buildReadMoreHint({
        session: sessionReadRef(target),
        offset: beforeOffset,
        maxCharsSuggested: resolvedMaxChars,
        availableStart: partialSnapshot.availableStart,
        availableEnd: partialSnapshot.availableEnd,
      });
      return createJsonToolResponse(applyToolContract({
        command,
        async: true,
        commandId,
        status: 'running',
        elapsedMs: completion.elapsedMs,
        sessionName: target.sessionName,
        sessionRef: sessionReadRef(target),
        host: target.host,
        terminalMode,
        operationMode: OPERATION_MODE,
        warning: validation.category !== 'safe' ? validation.message : undefined,
        hint: `Command is still running. Use ssh-command-status with commandId="${commandId}" to check progress.`,
        readMore,
      }, {
        resultStatus: 'partial_success',
        summary: 'Command started successfully and is still running in the background.',
        nextAction: `Use ssh-command-status with commandId="${commandId}" to poll for completion.`,
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          `commandId=${commandId}`,
          `completionReason=${completion.reason}`,
        ],
      }), [partialOutput.length > 0 ? partialOutput : '(no output yet)']);
    }

    // Command completed - read output
    let outputText = target.read(beforeOffset, resolvedMaxChars).output;

    // Clean output: ANSI → echo → sentinel
    outputText = cleanCommandOutput(outputText, command, {
      sentinelMarker: useMarker ? sentinelMarker : undefined,
      sentinelSuffix,
    });

    // Post-execution terminal mode check: detect password prompt
    const postTerminalMode = detectTerminalMode(target.buffer.slice(-2000));
    if (postTerminalMode === 'password_prompt') {
      // Release lock
      target.inputLock = 'none';
      broadcastLock(target);
      logSessionEvent(target.sessionId, 'command.password_prompt', {
        startedAt,
        ...commandMeta,
      });

      return createJsonToolResponse(applyToolContract({
        command,
        sessionName: target.sessionName,
        sessionRef: sessionReadRef(target),
        host: target.host,
        error: 'PASSWORD_REQUIRED',
        terminalMode: 'password_prompt',
        operationMode: OPERATION_MODE,
        message: 'The command is waiting for a password input. The terminal is now at a password prompt.',
        suggestion: 'DO NOT send another ssh-run command — it will be typed into the password field. Options: (1) Ask the user to enter the password in the browser terminal. (2) Use ssh-session-control to send ctrl_c to cancel the command. (3) If you know the password, use ssh-session-send to send it (not recommended for security).',
      }, {
        resultStatus: 'blocked',
        summary: 'Command execution reached a password prompt and needs user intervention.',
        failureCategory: 'terminal-state-abnormal',
        nextAction: 'Ask the user to resolve the password prompt or cancel it before continuing.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          'terminalMode=password_prompt',
        ],
      }), [outputText.length > 0 ? outputText : '(password prompt detected)']);
    }

    // Release lock
    target.inputLock = 'none';
    broadcastLock(target);

    const snapshot = target.read(beforeOffset, resolvedMaxChars);
    const exitCode = completion.exitCode;

    // Try structured parsing
    const parsed = tryParseCommandOutput(command, outputText);
    logSessionEvent(target.sessionId, 'command.completed', {
      completionReason: completion.reason,
      elapsedMs: completion.elapsedMs,
      exitCode,
      startedAt,
      status: 'completed',
      ...commandMeta,
    });

    if (outputText.length <= resolvedMaxChars) {
      return createJsonToolResponse(applyToolContract({
        command,
        sessionName: target.sessionName,
        sessionRef: sessionReadRef(target),
        host: target.host,
        completionReason: completion.reason,
        elapsedMs: completion.elapsedMs,
        exitCode,
        terminalMode,
        operationMode: OPERATION_MODE,
        warning: validation.category !== 'safe' ? validation.message : undefined,
        parsed: parsed ? { type: parsed.type, data: parsed.data } : undefined,
        readMore: buildReadMoreHint({
          session: sessionReadRef(target),
          offset: beforeOffset,
          maxCharsSuggested: resolvedMaxChars,
          availableStart: snapshot.availableStart,
          availableEnd: snapshot.availableEnd,
        }),
        exitHint: 'Check output for command result. Use ssh-run again for next command.',
      }, {
        resultStatus: 'success',
        summary: `Command completed for ${sessionReadRef(target)}.`,
        nextAction: 'Inspect the output, then call ssh-run again for the next step.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          `completionReason=${completion.reason}`,
          `exitCode=${typeof exitCode === 'number' ? exitCode : '(none)'}`,
        ],
      }), [outputText.length > 0 ? outputText : '(no output yet)']);
    }

    // Output exceeds maxChars -- apply head+tail truncation (30% head, 70% tail)
    const SEPARATOR_RESERVE = 200;
    const HEAD_RATIO = 0.30;
    const usableChars = resolvedMaxChars - SEPARATOR_RESERVE;
    const headChars = Math.floor(usableChars * HEAD_RATIO);
    const tailChars = usableChars - headChars;

    const headSnapshot = target.read(beforeOffset, headChars);
    const tailSnapshot = target.read(undefined, tailChars);

    if (tailSnapshot.effectiveOffset <= headSnapshot.nextOffset) {
      return createJsonToolResponse(applyToolContract({
        command,
        sessionName: target.sessionName,
        sessionRef: sessionReadRef(target),
        host: target.host,
        completionReason: completion.reason,
        elapsedMs: completion.elapsedMs,
        terminalMode,
        operationMode: OPERATION_MODE,
        readMore: buildReadMoreHint({
          session: sessionReadRef(target),
          offset: beforeOffset,
          maxCharsSuggested: resolvedMaxChars,
          availableStart: snapshot.availableStart,
          availableEnd: snapshot.availableEnd,
        }),
        exitHint: 'Check output for command result. Use ssh-run again for next command.',
      }, {
        resultStatus: 'success',
        summary: `Command completed for ${sessionReadRef(target)}.`,
        nextAction: 'Inspect the output, then call ssh-run again for the next step.',
        evidence: [
          `sessionRef=${sessionReadRef(target)}`,
          `completionReason=${completion.reason}`,
        ],
      }), [snapshot.output.length > 0 ? snapshot.output : '(no output yet)']);
    }

    const omittedStart = headSnapshot.nextOffset;
    const omittedEnd = tailSnapshot.effectiveOffset;
    const omittedChars = omittedEnd - omittedStart;
    const totalOutputChars = snapshot.availableEnd - beforeOffset;

    const separator = `\n\n--- OUTPUT TRUNCATED: ${omittedChars} chars omitted (offset ${omittedStart} to ${omittedEnd}) ---\n--- To read omitted section: use ssh-session-read with session="${sessionReadRef(target)}", offset=${omittedStart}, maxChars=${omittedChars} ---\n\n`;
    const combinedOutput = headSnapshot.output + separator + tailSnapshot.output;

    return createJsonToolResponse(applyToolContract({
      command,
      sessionName: target.sessionName,
      sessionRef: sessionReadRef(target),
      host: target.host,
      outputTruncated: true,
      totalOutputChars,
      omittedRange: { start: omittedStart, end: omittedEnd, chars: omittedChars },
      completionReason: completion.reason,
      elapsedMs: completion.elapsedMs,
      terminalMode,
      operationMode: OPERATION_MODE,
      readMore: buildReadMoreHint({
        session: sessionReadRef(target),
        offset: omittedStart,
        maxCharsSuggested: omittedChars,
        availableStart: snapshot.availableStart,
        availableEnd: snapshot.availableEnd,
      }),
      exitHint: `Output was truncated (${totalOutputChars} total chars). Head and tail are shown. Use ssh-session-read with offset=${omittedStart} to read the omitted middle section.`,
    }, {
      resultStatus: 'success',
      summary: `Command completed for ${sessionReadRef(target)} with truncated output.`,
      nextAction: 'Use ssh-session-read with the suggested offset to fetch omitted output.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `totalOutputChars=${totalOutputChars}`,
        `omittedChars=${omittedChars}`,
      ],
    }), [combinedOutput]);

    } finally {
      // Ensure lock is always released even if an error occurs
      if (target.inputLock === 'agent') {
        target.inputLock = 'none';
        broadcastLock(target);
      }
    }
  },
);

server.tool(
  'ssh-status',
  'Quick status check: list active sessions, viewer URL, connection state. Use this to check if a session is already running.',
  {},
  async () => {
    sweepSessions();
    const activeSession = refreshActiveSession();
    const active = [...sessions.values()].filter(s => !s.closed).map(s => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      sessionRef: s.metadata.sessionRef,
      deviceId: s.metadata.deviceId,
      connectionName: s.metadata.connectionName,
      instanceId: s.metadata.instanceId,
      host: s.host,
      user: s.user,
      terminalUrl: getViewerBaseUrl()
        ? `${getViewerBaseUrl()}/terminal/session/${encodeURIComponent(s.sessionId)}`
        : undefined,
      idleMinutes: Math.round((Date.now() - Date.parse(s.lastActivityAt)) / 60000),
      terminalMode: detectTerminalMode(s.buffer.slice(-2000)),
    }));

    return createJsonToolResponse(applyToolContract({
      instanceId: INSTANCE_ID,
      activeSessions: active.length,
      activeSessionId: activeSession?.sessionId || null,
      activeSessionRef: activeSession?.metadata.sessionRef || null,
      sessions: active,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerPort: actualViewerPort || undefined,
      configPath: PROFILES.path,
      configPaths: PROFILES.paths,
      configResolution: PROFILES.resolution,
      configuredDevices: PROFILES.config?.devices.map(device => device.id) || [],
      operationMode: OPERATION_MODE,
      logging: logger.getConfig(),
      hint: active.length === 0
        ? 'No active sessions. Use ssh-quick-connect to start one.'
        : 'Sessions are running. Use ssh-run to execute commands.',
    }, {
      resultStatus: 'success',
      summary: active.length === 0
        ? 'No active SSH sessions are currently open.'
        : `Found ${active.length} active SSH session(s).`,
      nextAction: active.length === 0
        ? 'Use ssh-quick-connect or ssh-session-open to create a session.'
        : 'Use ssh-run to execute commands or ssh-session-set-active to switch the default target.',
      evidence: [
        `instanceId=${INSTANCE_ID}`,
        `activeSessionRef=${activeSession?.metadata.sessionRef || '(none)'}`,
        `viewerBaseUrl=${getViewerBaseUrl() || '(disabled)'}`,
      ],
    }));
  },
);

// --- ssh-command-status tool ---

server.tool(
  'ssh-command-status',
  'Check the status of a long-running async command. Returns current output if completed, or partial output if still running.',
  {
    commandId: z.string().describe('The async command ID returned by ssh-run'),
    maxChars: z.number().int().positive().optional().describe('Max chars to read from output (default 16000)'),
  },
  async ({ commandId, maxChars }) => {
    const entry = runningCommands.get(commandId);
    if (!entry) {
      return createJsonToolResponse(applyToolContract({
        error: 'UNKNOWN_COMMAND',
        message: `No tracked command with id "${commandId}". It may have been cleaned up or already retrieved.`,
      }, {
        resultStatus: 'failure',
        summary: `No tracked async command exists for ${commandId}.`,
        failureCategory: 'runtime-state-abnormal',
        nextAction: 'Run ssh-run again or check whether the MCP process has been restarted.',
        evidence: [`commandId=${commandId}`],
      }));
    }

    const resolvedMaxChars = sanitizePositiveInt(maxChars, 'maxChars', 16000);

    if (entry.status === 'completed' || entry.status === 'interrupted') {
      const output = entry.output || '';
      runningCommands.delete(commandId);
      return createJsonToolResponse(applyToolContract({
        commandId,
        command: entry.command,
        status: entry.status,
        completionReason: entry.completionReason,
        exitCode: entry.exitCode,
        elapsedMs: (entry.completedAt || Date.now()) - entry.startTime,
        readMore: buildReadMoreHint({
          session: entry.sessionId,
          offset: entry.startOffset,
          maxCharsSuggested: resolvedMaxChars,
          availableStart: entry.startOffset,
          availableEnd: entry.startOffset + output.length,
        }),
        hint: 'Command has finished. Output is included below.',
      }, {
        resultStatus: entry.status === 'completed' ? 'success' : 'failure',
        summary: entry.status === 'completed'
          ? `Async command ${commandId} has completed.`
          : `Async command ${commandId} was interrupted.`,
        failureCategory: entry.status === 'completed' ? undefined : 'runtime-state-abnormal',
        nextAction: entry.status === 'completed'
          ? 'Inspect the output and continue with the next command.'
          : 'Re-run the command if the session is still valid.',
        evidence: [
          `commandId=${commandId}`,
          `status=${entry.status}`,
        ],
      }), [output.length > 0 ? output : '(no output captured)']);
    }

    // Still running - read current partial output from session
    const session = sessions.get(entry.sessionId);
    if (!session) {
      entry.status = 'interrupted';
      entry.completedAt = Date.now();
      logSessionEvent(entry.sessionId, 'command.interrupted', {
        commandId: entry.commandId,
        elapsedMs: entry.completedAt - entry.startTime,
        status: entry.status,
        ...summarizeCommandMeta(entry.command),
      });
      runningCommands.delete(commandId);
      return createJsonToolResponse(applyToolContract({
        commandId,
        command: entry.command,
        status: 'interrupted',
        message: 'Session no longer exists.',
        elapsedMs: Date.now() - entry.startTime,
      }, {
        resultStatus: 'failure',
        summary: `Async command ${commandId} was interrupted because its session disappeared.`,
        failureCategory: 'runtime-state-abnormal',
        nextAction: 'Re-open the SSH session, then re-run the command if needed.',
        evidence: [
          `commandId=${commandId}`,
          `sessionId=${entry.sessionId}`,
        ],
      }));
    }

    const snapshot = session.read(entry.startOffset, resolvedMaxChars);
    const output = cleanCommandOutput(snapshot.output, entry.command, {
      sentinelMarker: entry.sentinelMarker,
      sentinelSuffix: entry.sentinelSuffix,
    });
    return createJsonToolResponse(applyToolContract({
      commandId,
      command: entry.command,
      status: 'running',
      elapsedMs: Date.now() - entry.startTime,
      readMore: buildReadMoreHint({
        session: sessionReadRef(session),
        offset: entry.startOffset,
        maxCharsSuggested: resolvedMaxChars,
        availableStart: snapshot.availableStart,
        availableEnd: snapshot.availableEnd,
      }),
      hint: 'Command is still running. Call ssh-command-status again later to check. Partial output is included below.',
    }, {
      resultStatus: 'partial_success',
      summary: `Async command ${commandId} is still running.`,
      nextAction: 'Call ssh-command-status again later to poll for completion.',
      evidence: [
        `commandId=${commandId}`,
        `sessionRef=${sessionReadRef(session)}`,
      ],
    }), [output.length > 0 ? output : '(no output yet)']);
  },
);

// --- ssh-retry tool ---

server.tool(
  'ssh-retry',
  'Execute a command with automatic retry and backoff on failure. Useful for flaky network commands or services that need time to start.',
  {
    command: z.string().describe('Shell command to execute'),
    session: z.string().optional().describe('Session name or id. Defaults to "default"'),
    maxRetries: z.number().int().positive().optional().describe('Maximum number of retries (default 3)'),
    backoff: z.enum(['fixed', 'exponential']).optional().describe('Backoff strategy (default "exponential")'),
    delayMs: z.number().int().positive().optional().describe('Base delay between retries in ms (default 1000)'),
    successPattern: z.string().optional().describe('Regex pattern - if output matches this, consider command successful regardless of exit code'),
    failPattern: z.string().optional().describe('Regex pattern - if output matches this, consider command failed regardless of exit code'),
  },
  async ({ command, session, maxRetries, backoff, delayMs, successPattern, failPattern }) => {
    sweepSessions();
    const target = resolveSession(session);

    const resolvedMaxRetries = maxRetries ?? 3;
    const resolvedBackoff = backoff ?? 'exponential';
    const resolvedDelayMs = delayMs ?? 1000;

    let successRe: RegExp | null = null;
    let failRe: RegExp | null = null;
    try {
      if (successPattern) successRe = new RegExp(successPattern);
      if (failPattern) failRe = new RegExp(failPattern);
    } catch (e) {
      return createJsonToolResponse(applyToolContract({
        error: 'INVALID_PATTERN',
        message: `Invalid regex pattern: ${(e as Error).message}`,
      }, {
        resultStatus: 'failure',
        summary: 'Retry execution could not start because one of the regex patterns is invalid.',
        failureCategory: 'config-error',
        nextAction: 'Fix the supplied successPattern or failPattern and try again.',
        evidence: [`error=${(e as Error).message}`],
      }));
    }

    let lastOutput = '';
    let lastExitCode: number | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= resolvedMaxRetries; attempt++) {
      attempts = attempt + 1;

      // Wait before retry (not on first attempt)
      if (attempt > 0) {
        const waitTime = resolvedBackoff === 'exponential'
          ? resolvedDelayMs * Math.pow(2, attempt - 1)
          : resolvedDelayMs;
        await delay(Math.min(waitTime, 30000));
      }

      // Execute command
      if (target.inputLock === 'user') {
        return createJsonToolResponse(applyToolContract({
          error: 'INPUT_LOCKED',
          lock: 'user',
          message: 'Terminal is locked by user.',
        }, {
          resultStatus: 'blocked',
          summary: 'Retry execution was blocked because the user currently owns terminal input.',
          failureCategory: 'input-locked',
          nextAction: 'Ask the user to switch the browser terminal back to common or agent mode.',
          evidence: [
            `sessionRef=${sessionReadRef(target)}`,
            'inputLock=user',
          ],
        }));
      }

      target.inputLock = 'agent';
      broadcastLock(target);

      try {
        const sentinelId = randomUUID().slice(0, 8);
        const sentinelMarker = `___MCP_DONE_${sentinelId}_`;
        const beforeOffset = target.currentBufferEnd();

        const sentinelSuffix = USE_SENTINEL_MARKER ? buildSentinelCommandSuffix(sentinelMarker) : undefined;

        if (USE_SENTINEL_MARKER) {
          target.write(`${command}${sentinelSuffix}\n`, 'agent');
        } else {
          target.write(`${command}\n`, 'agent');
        }

        const completion = await target.waitForCompletion({
          startOffset: beforeOffset,
          maxWaitMs: 30000,
          idleMs: 2000,
          promptPatterns: DEFAULT_PROMPT_PATTERNS,
          sentinel: USE_SENTINEL_MARKER ? sentinelMarker : undefined,
        });

        let output = target.read(beforeOffset, 16000).output;
        output = cleanCommandOutput(output, command, {
          sentinelMarker: USE_SENTINEL_MARKER ? sentinelMarker : undefined,
          sentinelSuffix,
        });

        lastOutput = output;
        lastExitCode = completion.exitCode;

        if (successRe && successRe.test(output)) {
          return createJsonToolResponse(applyToolContract({
            command,
            status: 'success',
            attempts,
            exitCode: lastExitCode,
            sessionName: target.sessionName,
            sessionRef: sessionReadRef(target),
            hint: `Command succeeded on attempt ${attempts}.`,
          }, {
            resultStatus: 'success',
            summary: `Retry command succeeded after ${attempts} attempt(s).`,
            nextAction: 'Inspect the output and continue with the next command.',
            evidence: [
              `sessionRef=${sessionReadRef(target)}`,
              `attempts=${attempts}`,
              `exitCode=${typeof lastExitCode === 'number' ? lastExitCode : '(none)'}`,
            ],
          }), [output]);
        }

        if (failRe && failRe.test(output)) {
          continue;
        }

        if (lastExitCode === 0) {
          return createJsonToolResponse(applyToolContract({
            command,
            status: 'success',
            attempts,
            exitCode: 0,
            sessionName: target.sessionName,
            sessionRef: sessionReadRef(target),
            hint: `Command succeeded on attempt ${attempts}.`,
          }, {
            resultStatus: 'success',
            summary: `Retry command succeeded after ${attempts} attempt(s).`,
            nextAction: 'Inspect the output and continue with the next command.',
            evidence: [
              `sessionRef=${sessionReadRef(target)}`,
              `attempts=${attempts}`,
              'exitCode=0',
            ],
          }), [output]);
        }

        if (lastExitCode === undefined && completion.completed) {
          return createJsonToolResponse(applyToolContract({
            command,
            status: 'success',
            attempts,
            sessionName: target.sessionName,
            sessionRef: sessionReadRef(target),
            hint: `Command completed on attempt ${attempts} (no exit code available).`,
          }, {
            resultStatus: 'success',
            summary: `Retry command completed after ${attempts} attempt(s).`,
            nextAction: 'Inspect the output and continue with the next command.',
            evidence: [
              `sessionRef=${sessionReadRef(target)}`,
              `attempts=${attempts}`,
            ],
          }), [output]);
        }
      } finally {
        if (target.inputLock === 'agent') {
          target.inputLock = 'none';
          broadcastLock(target);
        }
      }

      // Otherwise retry
    }

    // All retries exhausted
    return createJsonToolResponse(applyToolContract({
      command,
      status: 'failed',
      attempts,
      exitCode: lastExitCode,
      sessionName: target.sessionName,
      sessionRef: sessionReadRef(target),
      hint: `Command failed after ${attempts} attempts.`,
    }, {
      resultStatus: 'failure',
      summary: `Retry command failed after ${attempts} attempt(s).`,
      failureCategory: 'connection-failure',
      nextAction: 'Inspect the last output, then decide whether to retry manually or fix the remote state.',
      evidence: [
        `sessionRef=${sessionReadRef(target)}`,
        `attempts=${attempts}`,
        `exitCode=${typeof lastExitCode === 'number' ? lastExitCode : '(none)'}`,
      ],
    }), [lastOutput.length > 0 ? lastOutput : '(no output)']);
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

  let shuttingDown = false;
  const cleanup = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    void (async () => {
      clearInterval(sweepTimer);
      if (viewerWss) {
        for (const client of viewerWss.clients) {
          try { client.close(1001, 'server shutdown'); } catch { /* ignore */ }
        }
        viewerWss.close();
      }
      viewerServer?.close();
      closeAllSessions(`mcp server shutdown (${reason})`);
      logServerEvent('server.shutdown', { reason });
      await removeServerInfoState();
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('exit', () => {
    clearInterval(sweepTimer);
    if (viewerWss) {
      for (const client of viewerWss.clients) {
        try { client.close(1001, 'process exit'); } catch { /* ignore */ }
      }
      viewerWss.close();
    }
    viewerServer?.close();
    closeAllSessions('process exit');
    void removeServerInfoState();
  });
}

if (isCliEnabled) {
  main().catch(error => {
    console.error('Fatal error in main():', error);
    closeAllSessions('fatal mcp server error');
    process.exit(1);
  });
}

export { buildSentinelCommandSuffix, parseArgv, stripSentinelFromOutput, validateConfig };
export {
  createBufferSnapshot,
  createEventSnapshot,
  getControlSequence,
  normalizeTerminalInput,
  renderTerminalDashboard,
  renderSplitDashboard,
  renderViewerTranscript,
  renderViewerTranscriptEvent,
  stripAnsi,
} from './shared.js';
export {
  extractExitCodeFromText,
  findSentinelOutputInText,
  normalizeCompletionText,
} from './session.js';
