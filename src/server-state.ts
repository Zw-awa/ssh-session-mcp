import { promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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

// ── Re-exports for other modules ─────────────────────────────────────────────

export {
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
export {
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
export { buildDiagnosticsOverview, buildSessionDiagnosticReport } from './diagnostics.js';
export { resolveLoggerConfig, SessionLogger, summarizeCommandMeta } from './logger.js';
export { buildReadMoreHint, buildReadProgress, buildSnapshotReadMore } from './paging.js';
export {
  loadProfiles,
  resolveDefaultDeviceId,
  resolveDeviceProfile,
  summarizeAuth,
  type DeviceProfile,
  type LoadedProfiles,
  type RuntimeDefaults,
} from './profiles.js';
export {
  resolveInstanceId,
  resolveRuntimePaths,
  resolveViewerPortSetting,
  type ViewerPortSetting,
} from './runtime.js';
export {
  type OperationMode,
  validateCommand,
  detectTerminalMode,
  isKnownSlowCommand,
} from './validation.js';
export { tryParseCommandOutput } from './parsers.js';
export {
  withToolContract,
  type FailureCategory,
  type ResultStatus,
} from './contracts.js';
export { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
export { z } from 'zod';
export { WebSocket } from 'ws';

// ── Types ────────────────────────────────────────────────────────────────────

export type ViewerLaunchMode = 'terminal' | 'browser';
export type ViewerSingletonScope = 'connection' | 'session';

export interface ViewerProcessState {
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

export interface ViewerBindingState {
  bindingKey: string;
  connectionKey: string;
  host: string;
  port: number;
  user: string;
  sessionId: string;
  scope: ViewerSingletonScope;
  updatedAt: string;
}

export interface RunningCommand {
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

// ── .env loader & argv parser ────────────────────────────────────────────────

export function loadDotEnv() {
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

export function parseArgv() {
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

// ── Configuration constants ──────────────────────────────────────────────────

export const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = isCliEnabled ? parseArgv() : {} as Record<string, string>;

export const DEFAULT_HOST = argvConfig.host || process.env.SSH_HOST;
export const DEFAULT_PORT = argvConfig.port ? parseInt(argvConfig.port, 10) : (process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22);
export const DEFAULT_USER = argvConfig.user || process.env.SSH_USER;
export const DEFAULT_PASSWORD = argvConfig.password || process.env.SSH_PASSWORD;
export const DEFAULT_KEY = argvConfig.key || process.env.SSH_KEY;
export const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout, 10) : 30 * 60 * 1000;
export const DEFAULT_COLS = argvConfig.cols ? parseInt(argvConfig.cols, 10) : 120;
export const DEFAULT_ROWS = argvConfig.rows ? parseInt(argvConfig.rows, 10) : 40;
export const DEFAULT_TERM = argvConfig.term || 'xterm-256color';
export const MAX_BUFFER_CHARS = argvConfig.maxBufferChars ? parseInt(argvConfig.maxBufferChars, 10) : 200000;
export const DEFAULT_READ_CHARS = argvConfig.defaultReadChars ? parseInt(argvConfig.defaultReadChars, 10) : 4000;
export const DEFAULT_IDLE_SWEEP_MS = argvConfig.idleSweepMs ? parseInt(argvConfig.idleSweepMs, 10) : 5000;
export const DEFAULT_CLOSED_RETENTION_MS = argvConfig.closedRetentionMs ? parseInt(argvConfig.closedRetentionMs, 10) : 5 * 60 * 1000;
export const MAX_TRANSCRIPT_EVENTS = argvConfig.maxTranscriptEvents ? parseInt(argvConfig.maxTranscriptEvents, 10) : 2000;
export const MAX_TRANSCRIPT_CHARS = argvConfig.maxTranscriptChars ? parseInt(argvConfig.maxTranscriptChars, 10) : 200000;
export const MAX_TRANSCRIPT_EVENT_CHARS = Math.min(MAX_TRANSCRIPT_CHARS, 40000);
export const DEFAULT_WATCH_WAIT_MS = argvConfig.defaultWatchWaitMs ? parseInt(argvConfig.defaultWatchWaitMs, 10) : 5000;
export const DEFAULT_DASHBOARD_WIDTH = argvConfig.defaultDashboardWidth ? parseInt(argvConfig.defaultDashboardWidth, 10) : 140;
export const DEFAULT_DASHBOARD_HEIGHT = argvConfig.defaultDashboardHeight ? parseInt(argvConfig.defaultDashboardHeight, 10) : 24;
export const DEFAULT_DASHBOARD_LEFT_CHARS = argvConfig.defaultDashboardLeftChars ? parseInt(argvConfig.defaultDashboardLeftChars, 10) : 12000;
export const DEFAULT_DASHBOARD_RIGHT_EVENTS = argvConfig.defaultDashboardRightEvents ? parseInt(argvConfig.defaultDashboardRightEvents, 10) : 40;
export const MAX_HISTORY_LINES = argvConfig.maxHistoryLines ? parseInt(argvConfig.maxHistoryLines, 10) : 4000;
export const INSTANCE_ID = resolveInstanceId(argvConfig.instance || process.env.SSH_MCP_INSTANCE);
export const RUNTIME_PATHS = resolveRuntimePaths(INSTANCE_ID);
export const PROFILES: LoadedProfiles = loadProfiles({
  argvPath: argvConfig.config,
  cwd: process.cwd(),
  envPath: process.env.SSH_MCP_CONFIG,
});
export const CONFIG_DEFAULTS: RuntimeDefaults | undefined = PROFILES.config?.defaults;
export const DEFAULT_VIEWER_HOST = argvConfig.viewerHost || process.env.VIEWER_HOST || CONFIG_DEFAULTS?.viewerHost || '127.0.0.1';
export const VIEWER_PORT_SETTING: ViewerPortSetting = resolveViewerPortSetting(
  argvConfig.viewerPort
  || process.env.VIEWER_PORT
  || (typeof CONFIG_DEFAULTS?.viewerPort === 'number' ? String(CONFIG_DEFAULTS.viewerPort) : CONFIG_DEFAULTS?.viewerPort),
);
export const DEFAULT_VIEWER_REFRESH_MS = argvConfig.viewerRefreshMs ? parseInt(argvConfig.viewerRefreshMs, 10) : 1000;
export const LOG_CONFIG = resolveLoggerConfig(
  argvConfig.logMode || process.env.SSH_MCP_LOG_MODE || CONFIG_DEFAULTS?.logMode,
  argvConfig.logDir || process.env.SSH_MCP_LOG_DIR || CONFIG_DEFAULTS?.logDir,
  RUNTIME_PATHS.logDir,
);
export const SSH_CONNECT_TIMEOUT_MS = 30000;
export const AUTO_OPEN_TERMINAL = argvConfig.autoOpenTerminal === 'true'
  || argvConfig.autoOpenTerminal === '1'
  || process.env.AUTO_OPEN_TERMINAL === 'true'
  || process.env.AUTO_OPEN_TERMINAL === '1'
  || CONFIG_DEFAULTS?.autoOpenTerminal === true;
export const VIEWER_LAUNCH_MODE: ViewerLaunchMode = (
  argvConfig.viewerLaunchMode
  || process.env.VIEWER_LAUNCH_MODE
  || CONFIG_DEFAULTS?.viewerMode
  || 'browser'
) as ViewerLaunchMode;
export let OPERATION_MODE: OperationMode = (
  argvConfig.mode
  || process.env.SSH_MCP_MODE
  || CONFIG_DEFAULTS?.mode
  || 'safe'
) as OperationMode;
export function setOperationMode(mode: OperationMode) { OPERATION_MODE = mode; }
export const USE_SENTINEL_MARKER = (argvConfig.useMarker || process.env.SSH_MCP_USE_MARKER || 'true') !== 'false';
export const VIEWER_STATE_FILE = RUNTIME_PATHS.viewerStateFile;
export const VIEWER_CLI_ENTRY_PATH = fileURLToPath(new URL('./viewer-cli.js', import.meta.url));

// ── Mutable state ────────────────────────────────────────────────────────────

export const viewerProcesses = new Map<string, ViewerProcessState>();
export const viewerBindings = new Map<string, ViewerBindingState>();
export let viewerServer: HttpServer | undefined;
export let viewerWss: WebSocketServer | undefined;
export let viewerStateLoaded = false;
export let activeSessionId: string | undefined;
export let actualViewerPort = 0;
export const logger = new SessionLogger(LOG_CONFIG);

export function setViewerServer(s: HttpServer | undefined) { viewerServer = s; }
export function setViewerWss(w: WebSocketServer | undefined) { viewerWss = w; }
export function setViewerStateLoaded(v: boolean) { viewerStateLoaded = v; }
export function setActualViewerPort(p: number) { actualViewerPort = p; }

// ── Config validation ────────────────────────────────────────────────────────

export function validateConfig(config: Record<string, string | null>) {
  const knownFlags = new Set([
    'host', 'port', 'user', 'password', 'key', 'timeout',
    'cols', 'rows', 'term',
    'maxBufferChars', 'defaultReadChars', 'idleSweepMs', 'closedRetentionMs',
    'maxTranscriptEvents', 'maxTranscriptChars',
    'defaultWatchWaitMs',
    'defaultDashboardWidth', 'defaultDashboardHeight',
    'defaultDashboardLeftChars', 'defaultDashboardRightEvents',
    'maxHistoryLines',
    'viewerPort', 'viewerHost', 'viewerRefreshMs', 'viewerLaunchMode',
    'autoOpenTerminal',
    'mode', 'useMarker',
    'instance', 'config',
    'logMode', 'logDir',
  ]);

  for (const key of Object.keys(config)) {
    if (!knownFlags.has(key)) {
      console.error(`Unknown flag: --${key}`);
      process.exit(1);
    }
  }
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

// ── Tuning & sessions ────────────────────────────────────────────────────────

export const tuning: SessionTuning = {
  maxBufferChars: MAX_BUFFER_CHARS,
  defaultReadChars: DEFAULT_READ_CHARS,
  maxTranscriptEvents: MAX_TRANSCRIPT_EVENTS,
  maxTranscriptChars: MAX_TRANSCRIPT_CHARS,
  maxTranscriptEventChars: MAX_TRANSCRIPT_EVENT_CHARS,
  defaultDashboardRightEvents: DEFAULT_DASHBOARD_RIGHT_EVENTS,
  defaultDashboardLeftChars: DEFAULT_DASHBOARD_LEFT_CHARS,
  maxHistoryLines: MAX_HISTORY_LINES,
};

export const sessions = new Map<string, SSHSession>();
export const runningCommands = new Map<string, RunningCommand>();

// ── MCP Server ───────────────────────────────────────────────────────────────

export const server = new McpServer({
  name: 'ssh-session-mcp',
  version: '2.4.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

// ── Logging helpers ──────────────────────────────────────────────────────────

export function logServerEvent(event: string, data?: Record<string, unknown>) {
  void logger.logServer(event, {
    instanceId: INSTANCE_ID,
    ...data,
  });
}

export function logSessionEvent(sessionId: string, event: string, data?: Record<string, unknown>) {
  void logger.logSession(sessionId, event, {
    instanceId: INSTANCE_ID,
    ...data,
  });
}

// ── Session helpers ──────────────────────────────────────────────────────────

export function sessionDisplayName(session: SSHSession | ReturnType<SSHSession['summary']>) {
  return session instanceof SSHSession
    ? session.metadata.sessionRef || session.sessionName || session.sessionId
    : session.sessionRef || session.sessionName || session.sessionId;
}

export function sessionReadRef(session: SSHSession) {
  return session.metadata.sessionRef || session.sessionName || session.sessionId;
}

export function pickMostRecentOpenSession() {
  return [...sessions.values()]
    .filter(session => !session.closed)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function setActiveSession(session: SSHSession | undefined) {
  activeSessionId = session?.sessionId;
}

export function refreshActiveSession() {
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

export function allocateConnectionName(deviceId: string, requested: string | undefined) {
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

export function buildSessionMetadata(options: {
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

export function resolveConfiguredDefaultDeviceId() {
  return resolveDefaultDeviceId(PROFILES);
}

export function resolveProfileOrThrow(deviceId: string) {
  const profile = resolveDeviceProfile(PROFILES, deviceId);
  if (!profile) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown device profile: ${deviceId}`);
  }
  return profile;
}

export function findOpenSessionByName(sessionName: string) {
  return [...sessions.values()].find(session => !session.closed && session.sessionName === sessionName);
}

export function findOpenProfileSession(deviceId: string, connectionName: string) {
  return [...sessions.values()].find(session =>
    !session.closed
    && session.metadata.deviceId === deviceId
    && session.metadata.connectionName === connectionName,
  );
}

export function inferProfileSource(options: {
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

// ── Viewer helpers ───────────────────────────────────────────────────────────

export function viewerScopeValue(value: string | undefined): ViewerSingletonScope {
  return value === 'session' ? 'session' : 'connection';
}

export function viewerModeValue(value: string | undefined): ViewerLaunchMode {
  return value === 'browser' ? 'browser' : 'terminal';
}

export function buildConnectionKey(host: string, port: number, user: string, connectionName?: string) {
  const base = `${user}@${host}:${port}`;
  return connectionName ? `${base}/${connectionName}` : base;
}

function sessionConnectionName(session: SSHSession | ReturnType<SSHSession['summary']>) {
  return session instanceof SSHSession
    ? session.metadata.connectionName
    : session.connectionName;
}

export function buildViewerBindingKeyForSession(session: SSHSession | ReturnType<SSHSession['summary']>, scope: ViewerSingletonScope) {
  if (scope === 'session') {
    return `session:${session.sessionId}`;
  }

  return `connection:${buildConnectionKey(session.host, session.port, session.user, sessionConnectionName(session))}`;
}

export function buildViewerBindingTitle(host: string, port: number, user: string) {
  return `SSH Session MCP Viewer - ${INSTANCE_ID} - ${user}@${host}:${port}`;
}

export function viewerHostForUrl(host: string) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host;
}

export function getViewerBaseUrl() {
  if (actualViewerPort <= 0) {
    return undefined;
  }

  return `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${actualViewerPort}`;
}

export function buildViewerBindingUrl(bindingKey: string) {
  const baseUrl = getViewerBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  // PREPARE_DEPRECATION: This still returns the legacy /binding/* browser entry for compatibility.
  // New code that wants the primary browser terminal should move toward /terminal/binding/*.
  return `${baseUrl}/binding/${encodeURIComponent(bindingKey)}`;
}

export function buildViewerSessionUrl(session: SSHSession) {
  const baseUrl = getViewerBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  return `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
}

export function viewerProcessAlive(pid: number | undefined) {
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

export async function saveViewerProcessState() {
  const records = [...viewerProcesses.values()];
  await fs.mkdir(RUNTIME_PATHS.instanceDir, { recursive: true });
  await fs.writeFile(VIEWER_STATE_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function saveServerInfoState() {
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

export async function removeServerInfoState() {
  try {
    await fs.unlink(RUNTIME_PATHS.serverInfoFile);
  } catch {
    // ignore
  }
}

export async function loadViewerProcessState() {
  if (viewerStateLoaded) {
    return;
  }

  try {
    const raw = await fs.readFile(VIEWER_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const normalized = normalizeViewerProcessState(item);
        if (normalized) {
          viewerProcesses.set(normalized.bindingKey, normalized);
        }
      }
    }
  } catch {
    // file doesn't exist or is invalid, that's fine
  }

  viewerStateLoaded = true;
  setViewerStateLoaded(true);
}

export async function refreshViewerProcessState(bindingKey: string) {
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

export function upsertViewerBinding(session: SSHSession, scope: ViewerSingletonScope) {
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

// ── Command tracking & diagnostics ──────────────────────────────────────────

export function findRunningCommandForSession(sessionId: string) {
  for (const entry of runningCommands.values()) {
    if (entry.sessionId === sessionId && entry.status === 'running') {
      return entry;
    }
  }
  return undefined;
}

export function buildSessionDiagnostics(session: SSHSession) {
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSentinelCommandSuffix(sentinelMarker: string): string {
  // Use braces so the shell expands __MCP_EC rather than looking up __MCP_EC___.
  return `; __MCP_EC=$?; printf "%s%s___\n" "${sentinelMarker}" "\${__MCP_EC}"`;
}

export function stripSentinelFromOutput(output: string, sentinelMarker: string, sentinelSuffix?: string): string {
  let cleaned = output;

  // Remove only the injected command suffix from the echoed command, not the whole line.
  if (sentinelSuffix) {
    cleaned = cleaned.replaceAll(sentinelSuffix, '');
  }

  // Remove the actual sentinel output token. Keep everything else untouched even if PTY output
  // is packed into a single \r-delimited line, otherwise we can accidentally drop real logs.
  const sentinelPattern = new RegExp(`${escapeRegExp(sentinelMarker)}(?:\d+___)?`, 'g');
  cleaned = cleaned.replace(sentinelPattern, '');

  return cleaned;
}

function stripCommandEcho(output: string, _command: string): string {
  // Disabled: automatic echo stripping is too risky for multi-line commands.
  return output;
}

export function cleanCommandOutput(output: string, command: string, options: {
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

export function startBackgroundMonitor(entry: RunningCommand, session: SSHSession): void {
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

// ── Session sweep & resolution ──────────────────────────────────────────────

export function sweepSessions(nowMs = Date.now()) {
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

export function resolveSession(sessionRef?: string): SSHSession {
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

export function resolveSessionForBinding(bindingKey: string) {
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

export function resolveAttachTarget(kind: 'session' | 'binding', ref: string) {
  if (kind === 'binding') {
    return resolveSessionForBinding(ref);
  }

  return {
    binding: undefined,
    session: resolveSession(ref),
  };
}

export function ensureUniqueSessionName(sessionName: string | undefined) {
  if (!sessionName) return;
  sweepSessions();
  if ([...sessions.values()].some(session => !session.closed && session.sessionName === sessionName)) {
    throw new McpError(ErrorCode.InvalidParams, `Session name already exists: ${sessionName}`);
  }
}

// ── SSH connection ───────────────────────────────────────────────────────────

async function readPrivateKey(keyPath: string | undefined): Promise<string | undefined> {
  const safePath = sanitizeOptionalText(keyPath);
  if (!safePath) return undefined;
  return fs.readFile(safePath, 'utf8');
}

export function resolvePassword(options: {
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

export async function openSSHSession(options: {
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

// ── Tool response helpers ────────────────────────────────────────────────────

export function createToolResponse(primaryText: string, extraTexts: string[] = []) {
  return {
    content: [
      { type: 'text' as const, text: primaryText },
      ...extraTexts
        .filter(text => text.trim().length > 0)
        .map(text => ({ type: 'text' as const, text })),
    ],
  };
}

export function createJsonToolResponse(payload: object, extraTexts: string[] = []) {
  return createToolResponse(JSON.stringify(payload, null, 2), extraTexts);
}

export function applyToolContract(
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

// ── Dashboard & payload builders ─────────────────────────────────────────────

export function buildDashboard(session: SSHSession, options: {
  width: number;
  height: number;
  leftChars: number;
  rightEvents: number;
  stripAnsiFromLeft: boolean;
}) {
  return buildDashboardState(session, options).dashboard;
}

export function buildDashboardState(session: SSHSession, options: {
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

export function parsePositiveQueryInt(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOptionalNonNegativeQueryInt(raw: string | null) {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseNonNegativeQueryInt(raw: string | null, fallback: number) {
  const parsed = parseOptionalNonNegativeQueryInt(raw);
  return typeof parsed === 'number' ? parsed : fallback;
}

export function parseBooleanQuery(raw: string | null, fallback: boolean) {
  if (!raw) return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  return fallback;
}

export async function readJsonRequestBody(request: AsyncIterable<Buffer | string>) {
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

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createViewerPayload(
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

export function createAttachPayload(
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

export function createViewerBindingPayload(
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
      bindingKey,
      summary: null,
      binding,
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
        emptyPlaceholder: `(binding ${binding.bindingKey} is waiting for session ${binding.sessionId})`,
      }),
      terminalText,
      conversationText,
      transcriptText,
      leftTitle,
      rightTitle,
    };
  }

  const state = buildDashboardState(session, options);

  return {
    bindingKey,
    summary: session.summary(),
    binding,
    viewerBaseUrl: getViewerBaseUrl(),
    viewerUrl: buildViewerBindingUrl(bindingKey),
    sessionViewerUrl: buildViewerSessionUrl(session),
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

// ── PowerShell / viewer launch ───────────────────────────────────────────────

export function escapePowerShellText(text: string) {
  return text.replace(/'/g, "''");
}

export async function runPowerShellScript(script: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
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

export async function terminateViewerProcess(pid: number | undefined) {
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

export async function launchTerminalViewer(binding: ViewerBindingState) {
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

export async function launchBrowserViewer(url: string) {
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

// ── broadcastLock & closeAllSessions ─────────────────────────────────────────

export function broadcastLock(session: SSHSession) {
  logSessionEvent(session.sessionId, 'session.lock', { lock: session.inputLock });
  if (!viewerWss) return;
  const msg = JSON.stringify({ type: 'lock', lock: session.inputLock });
  for (const client of viewerWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch { /* ignore */ }
    }
  }
}

export function closeAllSessions(reason: string) {
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
export async function ensureViewerForSession(
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
