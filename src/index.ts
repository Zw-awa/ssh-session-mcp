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
  type SessionTuning,
  type SessionWriteRecord,
  type CompletionResult,
} from './session.js';

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
const DEFAULT_VIEWER_HOST = argvConfig.viewerHost || process.env.VIEWER_HOST || '127.0.0.1';
const DEFAULT_VIEWER_PORT = argvConfig.viewerPort ? parseInt(argvConfig.viewerPort, 10) : (process.env.VIEWER_PORT ? parseInt(process.env.VIEWER_PORT, 10) : 0);
const DEFAULT_VIEWER_REFRESH_MS = argvConfig.viewerRefreshMs ? parseInt(argvConfig.viewerRefreshMs, 10) : 1000;
const SSH_CONNECT_TIMEOUT_MS = 30000;
const AUTO_OPEN_TERMINAL = argvConfig.autoOpenTerminal === 'true' || argvConfig.autoOpenTerminal === '1' || process.env.AUTO_OPEN_TERMINAL === 'true' || process.env.AUTO_OPEN_TERMINAL === '1';
const VIEWER_LAUNCH_MODE: ViewerLaunchMode = (argvConfig.viewerLaunchMode || process.env.VIEWER_LAUNCH_MODE || 'browser') as ViewerLaunchMode;
let OPERATION_MODE: OperationMode = (argvConfig.mode || process.env.SSH_MCP_MODE || 'safe') as OperationMode;
const USE_SENTINEL_MARKER = (argvConfig.useMarker || process.env.SSH_MCP_USE_MARKER || 'true') !== 'false';
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
let viewerWss: WebSocketServer | undefined;
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

// --- Async command tracking (Phase D) ---

interface RunningCommand {
  commandId: string;
  sessionId: string;
  command: string;
  startOffset: number;
  startTime: number;
  status: 'running' | 'completed' | 'interrupted';
  output?: string;
  completedAt?: number;
  completionReason?: 'prompt' | 'idle' | 'timeout' | 'sentinel';
}

const runningCommands = new Map<string, RunningCommand>();

function startBackgroundMonitor(entry: RunningCommand, session: SSHSession): void {
  session.waitForCompletion({
    startOffset: entry.startOffset,
    maxWaitMs: 5 * 60 * 1000,
    idleMs: 3000,
    promptPatterns: DEFAULT_PROMPT_PATTERNS,
  }).then((result) => {
    const stored = runningCommands.get(entry.commandId);
    if (!stored || stored.status !== 'running') return;
    const snapshot = session.read(entry.startOffset, 32000);
    stored.status = 'completed';
    stored.output = snapshot.output;
    stored.completedAt = Date.now();
    stored.completionReason = result.reason;
  }).catch(() => {
    const stored = runningCommands.get(entry.commandId);
    if (stored && stored.status === 'running') {
      stored.status = 'interrupted';
      stored.completedAt = Date.now();
    }
  });
}

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

  // Clean up stale running commands
  for (const [cmdId, entry] of runningCommands.entries()) {
    if (!sessions.has(entry.sessionId)) {
      runningCommands.delete(cmdId);
      continue;
    }
    // Clean completed entries after 5 minutes (reduced from 10)
    if (entry.status !== 'running' && entry.completedAt && nowMs - entry.completedAt > 5 * 60 * 1000) {
      runningCommands.delete(cmdId);
      continue;
    }
    // Clean stuck running entries after 10 minutes (safety net)
    if (entry.status === 'running' && nowMs - entry.startTime > 10 * 60 * 1000) {
      entry.status = 'interrupted';
      entry.completedAt = nowMs;
      runningCommands.delete(cmdId);
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

function stripSentinelFromOutput(output: string, sentinelMarker: string): string {
  const idx = output.indexOf(sentinelMarker);
  if (idx === -1) return output;
  const lineStart = output.lastIndexOf('\n', idx);
  const lineEnd = output.indexOf('\n', idx);
  return output.slice(0, lineStart === -1 ? 0 : lineStart) +
         (lineEnd === -1 ? '' : output.slice(lineEnd));
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
  const titleBase = session.sessionName
    ? `SSH ${session.sessionName} ${session.user}@${session.host}:${session.port}`
    : `SSH ${session.user}@${session.host}:${session.port}`;
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
          const terminalUrl = `${baseUrl}/terminal/session/${encodeURIComponent(session.sessionId)}`;
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

function renderViewerSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const session = sessions.get(sessionRef) || [...sessions.values()].find(s => s.sessionName === sessionRef);
  const sessionData = session ? session.summary() : null;

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
    title: sessionData.sessionName || sessionData.sessionId,
  });
}

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
    title: sessionData.sessionName || sessionData.sessionId,
  });
}

function broadcastLock(session: SSHSession) {
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
          // Broadcast lock change to all WS clients
          if (viewerWss) {
            const lockMsg = JSON.stringify({ type: 'lock', lock: session.inputLock });
            for (const client of viewerWss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                try { client.send(lockMsg); } catch { /* ignore */ }
              }
            }
          }
        }
        return;
      }

      if (msg.type === 'mode' && typeof msg.mode === 'string') {
        const validModes = ['safe', 'full'];
        if (validModes.includes(msg.mode)) {
          OPERATION_MODE = msg.mode as OperationMode;
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
      }

      if (msg.type === 'control' && typeof msg.key === 'string') {
        if (session.inputLock === 'agent') {
          ws.send(JSON.stringify({ type: 'lock_rejected', lock: session.inputLock, message: 'Input locked by AI agent.' }));
          return;
        }
        session.sendControl(msg.key as any, sanitizeActor(msg.actor, 'user'));
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
      fontSize: 14,
      fontFamily: 'Consolas, "SFMono-Regular", "Courier New", monospace',
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
    var knownRawEnd = 0;
    var isFirstConnect = true;
    var currentLock = 'none';

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
      var loc = window.location;
      var wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + wsPath;
      if (!isFirstConnect && knownRawEnd > 0) {
        wsUrl += (wsUrl.indexOf('?') === -1 ? '?' : '&') + 'rawOffset=' + knownRawEnd;
      }
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        connDot.className = 'conn-dot';
        if (isFirstConnect) { isFirstConnect = false; }
        currentLine = '';
        setStatus('Connected as ' + getActor(), '');
      };

      ws.onmessage = function(evt) {
        if (evt.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(evt.data));
          knownRawEnd += evt.data.byteLength;
          return;
        }
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'init' && msg.summary) {
            var s = msg.summary;
            headerTitle.textContent = (s.sessionName || s.sessionId || 'SSH') + ' ' + s.user + '@' + s.host + ':' + s.port;
            document.title = headerTitle.textContent + ' \\u2022 SSH Terminal';
            if (typeof msg.rawBufferEnd === 'number' && knownRawEnd === 0) {
              knownRawEnd = msg.rawBufferEnd;
            }
            if (s.inputLock) { updateLockUI(s.inputLock); }
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
    });

    terminal.onResize(function(size) {
      sendJson({ type: 'resize', cols: size.cols, rows: size.rows });
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
  })();
  </script>
</body>
</html>`;
}

function renderXtermSessionPage(sessionRef: string) {
  const baseUrl = getViewerBaseUrl() || '';
  const session = sessions.get(sessionRef) || [...sessions.values()].find(s => s.sessionName === sessionRef);
  const sessionData = session ? session.summary() : null;

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
    title: sessionData.sessionName || sessionData.sessionId,
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
    title: sessionData.sessionName || sessionData.sessionId,
  });
}

async function startViewerServer() {
  if (DEFAULT_VIEWER_PORT <= 0 || viewerServer) {
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
    viewerServer!.listen(DEFAULT_VIEWER_PORT, DEFAULT_VIEWER_HOST, () => {
      viewerServer!.off('error', reject);
      resolve();
    });
  });

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
      session.close(reason);
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

const server = new McpServer({
  name: 'ssh-session-mcp',
  version: '2.0.0',
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
    let autoOpenTerminalUrl: string | undefined;
    let autoOpenTerminalError: string | undefined;
    if (AUTO_OPEN_TERMINAL && DEFAULT_VIEWER_PORT > 0) {
      try {
        const termUrl = `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${DEFAULT_VIEWER_PORT}/terminal/session/${encodeURIComponent(session.sessionId)}`;
        if (VIEWER_LAUNCH_MODE === 'terminal') {
          const binding = upsertViewerBinding(session, 'session');
          await launchTerminalViewer(binding);
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
      autoOpenTerminalUrl,
      autoOpenTerminalError,
    }, null, 2), resolvedIncludeDashboard ? [dashboard] : []);
  },
);

server.tool(
  'ssh-session-send',
  'Send raw input to an interactive SSH PTY session. Actor is shown inline in the dashboard transcript.',
  {
    session: z.string().describe('Session id or unique session name'),
    input: z.string().describe('Raw text to send into the PTY'),
    appendNewline: z.boolean().optional().describe('Append a newline after the input'),
    actor: z.string().optional().describe('Label for the sender shown inline in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, input, appendNewline, actor }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));
    if (input.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'input cannot be empty');
    }

    if (target.inputLock === 'user') {
      return createToolResponse(JSON.stringify({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send input.',
      }, null, 2));
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
  'Long-poll an SSH PTY session and render a terminal-style dashboard with inline actor markers.',
  {
    session: z.string().describe('Session id or unique session name'),
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
  'Send a control key to an interactive SSH PTY session. Actor is shown inline in the dashboard transcript.',
  {
    session: z.string().describe('Session id or unique session name'),
    control: z.enum(['ctrl_c', 'ctrl_d', 'enter', 'tab', 'esc', 'up', 'down', 'left', 'right', 'backspace']).describe('Control key to send'),
    actor: z.string().optional().describe('Label for the sender shown inline in the dashboard, e.g. codex, claude, user'),
  },
  async ({ session, control, actor }) => {
    const target = resolveSession(sanitizeRequiredText(session, 'session'));

    if (target.inputLock === 'user') {
      return createToolResponse(JSON.stringify({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send control keys.',
      }, null, 2));
    }

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

// ── Simplified tools for AI agents ──────────────────────────────────────────

server.tool(
  'ssh-quick-connect',
  'One-step: open SSH session using .env defaults, auto-open browser terminal, return terminal URL. If a session already exists, reuse it. AI agents should call this once at the start of a conversation.',
  {
    sessionName: z.string().optional().describe('Optional session name. Defaults to "default"'),
  },
  async ({ sessionName }) => {
    sweepSessions();
    const name = sanitizeOptionalText(sessionName) || 'default';

    // Reuse existing active session with same name
    const existing = [...sessions.values()].find(s => !s.closed && s.sessionName === name);
    if (existing) {
      const terminalUrl = DEFAULT_VIEWER_PORT > 0
        ? `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${DEFAULT_VIEWER_PORT}/terminal/session/${encodeURIComponent(existing.sessionId)}`
        : undefined;
      return createToolResponse(JSON.stringify({
        reused: true,
        sessionId: existing.sessionId,
        sessionName: existing.sessionName,
        host: existing.host,
        user: existing.user,
        terminalUrl,
        hint: 'Session already exists. Use ssh-run to execute commands.',
      }, null, 2));
    }

    // Open new session
    const resolvedHost = DEFAULT_HOST;
    const resolvedUser = DEFAULT_USER;
    if (!resolvedHost) throw new McpError(ErrorCode.InvalidParams, 'SSH_HOST not configured. Set it in .env or pass --host');
    if (!resolvedUser) throw new McpError(ErrorCode.InvalidParams, 'SSH_USER not configured. Set it in .env or pass --user');

    const sshConfig: SSHConfig = { host: resolvedHost, port: DEFAULT_PORT, username: resolvedUser };
    if (DEFAULT_PASSWORD) sshConfig.password = DEFAULT_PASSWORD;
    else if (DEFAULT_KEY) sshConfig.privateKey = await readPrivateKey(DEFAULT_KEY);

    const connection = new SSHConnection(sshConfig, SSH_CONNECT_TIMEOUT_MS);
    await connection.connect();

    const sessionId = randomUUID();
    const client = connection.getClient();
    const session = await new Promise<SSHSession>((resolve, reject) => {
      client.shell({ term: DEFAULT_TERM, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (err, stream) => {
        if (err) { connection.close(); reject(new McpError(ErrorCode.InternalError, `SSH shell failed: ${err.message}`)); return; }
        resolve(new SSHSession(sessionId, name, resolvedHost, DEFAULT_PORT, resolvedUser, DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_TERM, DEFAULT_TIMEOUT, DEFAULT_CLOSED_RETENTION_MS, tuning, connection, stream));
      });
    });
    sessions.set(sessionId, session);

    // Auto open terminal
    let terminalUrl: string | undefined;
    if (DEFAULT_VIEWER_PORT > 0) {
      terminalUrl = `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${DEFAULT_VIEWER_PORT}/terminal/session/${encodeURIComponent(sessionId)}`;
      if (AUTO_OPEN_TERMINAL) {
        try {
          if (VIEWER_LAUNCH_MODE === 'terminal') {
            const binding = upsertViewerBinding(session, 'session');
            await launchTerminalViewer(binding);
          } else {
            await launchBrowserViewer(terminalUrl);
          }
        } catch { /* ignore */ }
      }
    }

    await delay(300);

    return createToolResponse(JSON.stringify({
      reused: false,
      sessionId,
      sessionName: name,
      host: resolvedHost,
      user: resolvedUser,
      terminalUrl,
      hint: 'Session opened. Use ssh-run to execute commands. The user can also type in the browser terminal.',
    }, null, 2));
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
    const ref = sanitizeOptionalText(session) || 'default';
    const target = resolveSession(ref);

    if (target.inputLock === 'user') {
      return createToolResponse(JSON.stringify({
        error: 'INPUT_LOCKED',
        lock: 'user',
        message: 'Terminal is locked by user. The user must switch to agent or common mode in the browser terminal before AI can send commands.',
      }, null, 2));
    }

    // Mutual exclusion: reject if another agent command is already running
    if (target.inputLock === 'agent') {
      return createToolResponse(JSON.stringify({
        error: 'AGENT_BUSY',
        lock: 'agent',
        message: 'Another agent command is already running on this session. Wait for it to complete or use ssh-command-status to check progress.',
      }, null, 2));
    }

    // Command validation
    const validation = validateCommand(command, OPERATION_MODE);
    if (!validation.allowed) {
      return createToolResponse(JSON.stringify({
        error: 'COMMAND_BLOCKED',
        category: validation.category,
        message: validation.message,
        suggestion: validation.suggestion,
        operationMode: OPERATION_MODE,
      }, null, 2));
    }

    // Terminal mode check
    const bufferTail = target.buffer.slice(-2000);
    const terminalMode = detectTerminalMode(bufferTail);

    // Password prompt blocks in ALL modes — sending a command here would type it as password
    if (terminalMode === 'password_prompt') {
      return createToolResponse(JSON.stringify({
        error: 'PASSWORD_REQUIRED',
        terminalMode: 'password_prompt',
        message: 'Terminal is at a password prompt. DO NOT send commands — they will be typed as the password.',
        suggestion: 'Options: (1) Ask the user to enter the password in the browser terminal. (2) Use ssh-session-control to send ctrl_c to cancel. (3) If you know the password, use ssh-session-send to type it directly.',
        operationMode: OPERATION_MODE,
      }, null, 2));
    }

    // Editor/pager check — only blocks in safe mode
    if (OPERATION_MODE === 'safe' && (terminalMode === 'editor' || terminalMode === 'pager')) {
      return createToolResponse(JSON.stringify({
        error: 'WRONG_TERMINAL_MODE',
        terminalMode,
        message: `Terminal is in ${terminalMode} mode. Cannot execute commands in this state.`,
        suggestion: terminalMode === 'editor' ? 'Send ctrl_c or ctrl_d via ssh-session-control to exit the editor first.'
          : 'Send "q" via ssh-session-control to exit the pager first.',
        operationMode: OPERATION_MODE,
      }, null, 2));
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
    if (useMarker) {
      // Use __MCP_EC to capture exit code reliably even with pipes
      target.write(`${command}; __MCP_EC=$?; echo "${sentinelMarker}$__MCP_EC___"\n`, 'agent');
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
        startOffset: beforeOffset,
        startTime: Date.now(),
        status: 'running',
      };
      runningCommands.set(commandId, entry);

      // Release lock
      target.inputLock = 'none';
      broadcastLock(target);

      // Start background monitor
      startBackgroundMonitor(entry, target);

      const partialSnapshot = target.read(beforeOffset, resolvedMaxChars);
      return createToolResponse(JSON.stringify({
        command,
        async: true,
        commandId,
        status: 'running',
        elapsedMs: completion.elapsedMs,
        sessionName: target.sessionName,
        host: target.host,
        terminalMode,
        operationMode: OPERATION_MODE,
        warning: validation.category !== 'safe' ? validation.message : undefined,
        hint: `Command is still running. Use ssh-command-status with commandId="${commandId}" to check progress.`,
      }, null, 2), [partialSnapshot.output.length > 0 ? partialSnapshot.output : '(no output yet)']);
    }

    // Command completed - read output
    let outputText = target.read(beforeOffset, resolvedMaxChars).output;

    // Clean output: ANSI → echo → sentinel
    outputText = stripAnsi(outputText);
    outputText = stripCommandEcho(outputText, command);
    if (useMarker) {
      outputText = stripSentinelFromOutput(outputText, sentinelMarker);
    }

    // Post-execution terminal mode check: detect password prompt
    const postTerminalMode = detectTerminalMode(target.buffer.slice(-2000));
    if (postTerminalMode === 'password_prompt') {
      // Release lock
      target.inputLock = 'none';
      broadcastLock(target);

      return createToolResponse(JSON.stringify({
        command,
        sessionName: target.sessionName,
        host: target.host,
        error: 'PASSWORD_REQUIRED',
        terminalMode: 'password_prompt',
        operationMode: OPERATION_MODE,
        message: 'The command is waiting for a password input. The terminal is now at a password prompt.',
        suggestion: 'DO NOT send another ssh-run command — it will be typed into the password field. Options: (1) Ask the user to enter the password in the browser terminal. (2) Use ssh-session-control to send ctrl_c to cancel the command. (3) If you know the password, use ssh-session-send to send it (not recommended for security).',
      }, null, 2), [outputText.length > 0 ? outputText : '(password prompt detected)']);
    }

    // Release lock
    target.inputLock = 'none';
    broadcastLock(target);

    const snapshot = target.read(beforeOffset, resolvedMaxChars);
    const exitCode = completion.exitCode;

    // Try structured parsing
    const parsed = tryParseCommandOutput(command, outputText);

    if (outputText.length <= resolvedMaxChars) {
      return createToolResponse(JSON.stringify({
        command,
        sessionName: target.sessionName,
        host: target.host,
        completionReason: completion.reason,
        elapsedMs: completion.elapsedMs,
        exitCode,
        terminalMode,
        operationMode: OPERATION_MODE,
        warning: validation.category !== 'safe' ? validation.message : undefined,
        parsed: parsed ? { type: parsed.type, data: parsed.data } : undefined,
        exitHint: 'Check output for command result. Use ssh-run again for next command.',
      }, null, 2), [outputText.length > 0 ? outputText : '(no output yet)']);
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
      return createToolResponse(JSON.stringify({
        command,
        sessionName: target.sessionName,
        host: target.host,
        completionReason: completion.reason,
        elapsedMs: completion.elapsedMs,
        terminalMode,
        operationMode: OPERATION_MODE,
        exitHint: 'Check output for command result. Use ssh-run again for next command.',
      }, null, 2), [snapshot.output.length > 0 ? snapshot.output : '(no output yet)']);
    }

    const omittedStart = headSnapshot.nextOffset;
    const omittedEnd = tailSnapshot.effectiveOffset;
    const omittedChars = omittedEnd - omittedStart;
    const totalOutputChars = snapshot.availableEnd - beforeOffset;

    const separator = `\n\n--- OUTPUT TRUNCATED: ${omittedChars} chars omitted (offset ${omittedStart} to ${omittedEnd}) ---\n--- To read omitted section: use ssh-session-read with session="${target.sessionName}", offset=${omittedStart}, maxChars=${omittedChars} ---\n\n`;
    const combinedOutput = headSnapshot.output + separator + tailSnapshot.output;

    return createToolResponse(JSON.stringify({
      command,
      sessionName: target.sessionName,
      host: target.host,
      outputTruncated: true,
      totalOutputChars,
      omittedRange: { start: omittedStart, end: omittedEnd, chars: omittedChars },
      completionReason: completion.reason,
      elapsedMs: completion.elapsedMs,
      terminalMode,
      operationMode: OPERATION_MODE,
      exitHint: `Output was truncated (${totalOutputChars} total chars). Head and tail are shown. Use ssh-session-read with offset=${omittedStart} to read the omitted middle section.`,
    }, null, 2), [combinedOutput]);

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
    const active = [...sessions.values()].filter(s => !s.closed).map(s => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      host: s.host,
      user: s.user,
      terminalUrl: DEFAULT_VIEWER_PORT > 0
        ? `http://${viewerHostForUrl(DEFAULT_VIEWER_HOST)}:${DEFAULT_VIEWER_PORT}/terminal/session/${encodeURIComponent(s.sessionId)}`
        : undefined,
      idleMinutes: Math.round((Date.now() - Date.parse(s.lastActivityAt)) / 60000),
      terminalMode: detectTerminalMode(s.buffer.slice(-2000)),
    }));

    return createToolResponse(JSON.stringify({
      activeSessions: active.length,
      sessions: active,
      viewerBaseUrl: getViewerBaseUrl(),
      operationMode: OPERATION_MODE,
      hint: active.length === 0
        ? 'No active sessions. Use ssh-quick-connect to start one.'
        : 'Sessions are running. Use ssh-run to execute commands.',
    }, null, 2));
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
      return createToolResponse(JSON.stringify({
        error: 'UNKNOWN_COMMAND',
        message: `No tracked command with id "${commandId}". It may have been cleaned up or already retrieved.`,
      }, null, 2));
    }

    const resolvedMaxChars = sanitizePositiveInt(maxChars, 'maxChars', 16000);

    if (entry.status === 'completed' || entry.status === 'interrupted') {
      const output = entry.output || '';
      runningCommands.delete(commandId);
      return createToolResponse(JSON.stringify({
        commandId,
        command: entry.command,
        status: entry.status,
        completionReason: entry.completionReason,
        elapsedMs: (entry.completedAt || Date.now()) - entry.startTime,
        hint: 'Command has finished. Output is included below.',
      }, null, 2), [output.length > 0 ? output : '(no output captured)']);
    }

    // Still running - read current partial output from session
    const session = sessions.get(entry.sessionId);
    if (!session) {
      entry.status = 'interrupted';
      entry.completedAt = Date.now();
      runningCommands.delete(commandId);
      return createToolResponse(JSON.stringify({
        commandId,
        command: entry.command,
        status: 'interrupted',
        message: 'Session no longer exists.',
        elapsedMs: Date.now() - entry.startTime,
      }, null, 2));
    }

    const snapshot = session.read(entry.startOffset, resolvedMaxChars);
    return createToolResponse(JSON.stringify({
      commandId,
      command: entry.command,
      status: 'running',
      elapsedMs: Date.now() - entry.startTime,
      hint: 'Command is still running. Call ssh-command-status again later to check. Partial output is included below.',
    }, null, 2), [snapshot.output.length > 0 ? snapshot.output : '(no output yet)']);
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
    const ref = sanitizeOptionalText(session) || 'default';
    const target = resolveSession(ref);

    const resolvedMaxRetries = maxRetries ?? 3;
    const resolvedBackoff = backoff ?? 'exponential';
    const resolvedDelayMs = delayMs ?? 1000;

    let successRe: RegExp | null = null;
    let failRe: RegExp | null = null;
    try {
      if (successPattern) successRe = new RegExp(successPattern);
      if (failPattern) failRe = new RegExp(failPattern);
    } catch (e) {
      return createToolResponse(JSON.stringify({
        error: 'INVALID_PATTERN',
        message: `Invalid regex pattern: ${(e as Error).message}`,
      }, null, 2));
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
        return createToolResponse(JSON.stringify({
          error: 'INPUT_LOCKED',
          lock: 'user',
          message: 'Terminal is locked by user.',
        }, null, 2));
      }

      target.inputLock = 'agent';
      broadcastLock(target);

      const sentinelId = randomUUID().slice(0, 8);
      const sentinelMarker = `___MCP_DONE_${sentinelId}_`;
      const beforeOffset = target.currentBufferEnd();

      if (USE_SENTINEL_MARKER) {
        target.write(`${command}; __MCP_EC=$?; echo "${sentinelMarker}$__MCP_EC___"\n`, 'agent');
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

      target.inputLock = 'none';
      broadcastLock(target);

      let output = target.read(beforeOffset, 16000).output;
      // Clean output: ANSI → echo → sentinel
      output = stripAnsi(output);
      output = stripCommandEcho(output, command);
      if (USE_SENTINEL_MARKER) {
        output = stripSentinelFromOutput(output, sentinelMarker);
      }

      lastOutput = output;
      lastExitCode = completion.exitCode;

      // Check success/fail patterns
      if (successRe && successRe.test(output)) {
        return createToolResponse(JSON.stringify({
          command,
          status: 'success',
          attempts,
          exitCode: lastExitCode,
          sessionName: target.sessionName,
          hint: `Command succeeded on attempt ${attempts}.`,
        }, null, 2), [output]);
      }

      if (failRe && failRe.test(output)) {
        continue; // Retry
      }

      // If sentinel gave us exit code 0, success
      if (lastExitCode === 0) {
        return createToolResponse(JSON.stringify({
          command,
          status: 'success',
          attempts,
          exitCode: 0,
          sessionName: target.sessionName,
          hint: `Command succeeded on attempt ${attempts}.`,
        }, null, 2), [output]);
      }

      // If no exit code info and completed normally, assume success
      if (lastExitCode === undefined && completion.completed) {
        return createToolResponse(JSON.stringify({
          command,
          status: 'success',
          attempts,
          sessionName: target.sessionName,
          hint: `Command completed on attempt ${attempts} (no exit code available).`,
        }, null, 2), [output]);
      }

      // Otherwise retry
    }

    // All retries exhausted
    return createToolResponse(JSON.stringify({
      command,
      status: 'failed',
      attempts,
      exitCode: lastExitCode,
      sessionName: target.sessionName,
      hint: `Command failed after ${attempts} attempts.`,
    }, null, 2), [lastOutput.length > 0 ? lastOutput : '(no output)']);
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
    if (viewerWss) {
      for (const client of viewerWss.clients) {
        try { client.close(1001, 'server shutdown'); } catch { /* ignore */ }
      }
      viewerWss.close();
    }
    viewerServer?.close();
    closeAllSessions('mcp server shutdown');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
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
  renderTerminalDashboard,
  renderSplitDashboard,
  renderViewerTranscript,
  renderViewerTranscriptEvent,
  stripAnsi,
} from './shared.js';
