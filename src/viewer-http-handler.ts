import { constants as fsConstants, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  sessions, actualViewerPort, resolveSession, resolveAttachTarget,
  getViewerBaseUrl, buildViewerSessionUrl, createViewerPayload,
  createViewerBindingPayload, createAttachPayload,
  parsePositiveQueryInt, parseOptionalNonNegativeQueryInt,
  parseNonNegativeQueryInt, parseBooleanQuery, readJsonRequestBody,
  sanitizeActor, sanitizePositiveInt, logSessionEvent,
  DEFAULT_DASHBOARD_WIDTH, DEFAULT_DASHBOARD_HEIGHT,
  DEFAULT_DASHBOARD_LEFT_CHARS, DEFAULT_DASHBOARD_RIGHT_EVENTS,
  INSTANCE_ID, NODE_ID, PROFILES, DEBUG_MODE, LOCAL_MODE,
  sweepSessions, refreshActiveSession, buildSessionDiagnostics,
  openSSHSession, buildSessionMetadata, setActiveSession,
  buildConfiguredSessionPolicyRules,
  AUTH_MODE, clusterSessions, distributedModeEnabled, distributedStoreHealthy,
  extractViewerIdentity, forgetSession, getRoutableViewerBaseUrl,
  hasViewerRole, nodeLastHeartbeatAt, refreshDistributedCaches, rememberSession,
  resolveRemoteOwnerForBinding, resolveRemoteOwnerForSessionRef,
  type RemoteOwnerTarget, type ViewerIdentity, type ViewerRole,
  VIEWER_PORT_SETTING, RUNTIME_PATHS, LOG_CONFIG,
  DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_TERM,
  DEFAULT_TIMEOUT, DEFAULT_CLOSED_RETENTION_MS,
  type SessionWriteRecord, type ViewerAccessPolicy, McpError, ErrorCode, buildUserLockMessage,
  viewerAccessPolicy, setViewerAccessPolicy, saveViewerAccessPolicy,
  runningCommands, viewerBindings, viewerProcesses, viewerWss,
  validateCommand, detectTerminalMode, logServerEvent,
} from './server-state.js';
import {
  renderViewerErrorPage,
  renderViewerHomePage,
  renderViewerBindingPage,
  renderViewerSessionPage,
  renderXtermBindingPage,
  renderXtermSessionPage,
} from './viewer-html.js';
import {
  matchViewerHttpRoute,
  type ViewerAttachKind,
} from './viewer-routes.js';

interface ViewerResponseWriters {
  writeError(statusCode: number, error: unknown): void;
  writeHtml(statusCode: number, html: string): void;
  writeJson(statusCode: number, payload: unknown): void;
  writeText(statusCode: number, text: string, contentType?: string): void;
}

function createViewerResponseWriters(response: ServerResponse): ViewerResponseWriters {
  return {
    writeJson(statusCode, payload) {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload, null, 2));
    },
    writeHtml(statusCode, html) {
      response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    },
    writeText(statusCode, text, contentType = 'text/plain; charset=utf-8') {
      response.writeHead(statusCode, { 'content-type': contentType });
      response.end(text);
    },
    writeError(statusCode, error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: message }, null, 2));
    },
  };
}

function buildRequestPathWithQuery(url: URL) {
  return `${url.pathname}${url.search}`;
}

function buildRemoteOwnerPayload(target: RemoteOwnerTarget) {
  return {
    error: 'REMOTE_OWNER',
    ownerNodeId: target.ownerNodeId,
    routableBaseUrl: target.routableBaseUrl,
    redirectUrl: target.redirectUrl,
    availability: target.availability,
    sessionId: target.sessionId,
    bindingKey: target.bindingKey,
  };
}

function writeRemoteOwnerError(
  routeType: string,
  target: RemoteOwnerTarget,
  writers: ViewerResponseWriters,
  preferHtml = false,
) {
  if (preferHtml) {
    const baseUrl = target.redirectUrl || target.routableBaseUrl || getRoutableViewerBaseUrl() || '/';
    writers.writeHtml(409, renderViewerErrorPage({
      baseUrl,
      title: 'Remote Session Owner',
      detail: target.redirectUrl
        ? `This session is owned by node ${target.ownerNodeId}. Open ${target.redirectUrl} instead.`
        : `This session is owned by node ${target.ownerNodeId}. The owner node is not reachable from this replica.`,
      footerLabel: 'Owner Node',
      footerValue: target.ownerNodeId,
    }));
    return;
  }

  writers.writeError(409, new McpError(
    ErrorCode.InvalidRequest,
    JSON.stringify({
      routeType,
      ...buildRemoteOwnerPayload(target),
    }),
  ));
}

function parseWriterError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: raw };
  }
}

function writeViewerError(
  statusCode: number,
  error: unknown,
  writers: ViewerResponseWriters,
) {
  writers.writeJson(statusCode, parseWriterError(error));
}

function requiredViewerRoleForRoute(route: ReturnType<typeof matchViewerHttpRoute>, method: string | undefined): ViewerRole | undefined {
  switch (route.type) {
    case 'live':
    case 'ready':
    case 'metrics':
    case 'health':
      return undefined;
    case 'viewer-access-policy-api':
      return method?.toUpperCase() === 'GET' ? 'viewer_read' : 'session_admin';
    case 'attach-input':
    case 'attach-resize':
    case 'session-control':
      return 'viewer_write';
    case 'session-mode-api':
    case 'session-policy-api':
    case 'session-close':
    case 'session-set-active':
    case 'session-agent-input':
    case 'sessions-create':
      return 'session_admin';
    default:
      return 'viewer_read';
  }
}

function ensureViewerIdentityAuthorized(identity: ViewerIdentity | undefined, requiredRole: ViewerRole | undefined) {
  if (AUTH_MODE !== 'proxy' || !requiredRole) {
    return;
  }

  if (!identity) {
    throw new McpError(ErrorCode.InvalidRequest, 'Missing trusted viewer identity headers.');
  }

  if (!hasViewerRole(identity, requiredRole)) {
    throw new McpError(ErrorCode.InvalidRequest, `Viewer identity lacks required role: ${requiredRole}`);
  }
}

async function resolveRemoteOwnerForRoute(route: ReturnType<typeof matchViewerHttpRoute>, url: URL): Promise<RemoteOwnerTarget | undefined> {
  const pathWithQuery = buildRequestPathWithQuery(url);

  switch (route.type) {
    case 'attach-read':
    case 'attach-input':
    case 'attach-resize':
      return route.kind === 'binding'
        ? resolveRemoteOwnerForBinding(route.ref, pathWithQuery)
        : resolveRemoteOwnerForSessionRef(route.ref, pathWithQuery);
    case 'session-api':
    case 'session-close':
    case 'session-diagnostics':
    case 'session-history':
    case 'session-policy-api':
    case 'session-mode-api':
    case 'session-agent-input':
    case 'session-control':
    case 'session-set-active':
    case 'terminal-session-page':
    case 'legacy-session-page':
      return resolveRemoteOwnerForSessionRef(route.sessionRef, pathWithQuery);
    case 'viewer-binding-api':
    case 'terminal-binding-page':
    case 'legacy-binding-page':
      return resolveRemoteOwnerForBinding(route.bindingKey, pathWithQuery);
    default:
      return undefined;
  }
}

function isSessionWriteRecordCandidate(value: unknown): value is {
  actor?: string;
  text: string;
  type: 'input' | 'control';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    actor?: unknown;
    text?: unknown;
    type?: unknown;
  };

  return (candidate.type === 'input' || candidate.type === 'control')
    && typeof candidate.text === 'string'
    && (typeof candidate.actor === 'undefined' || typeof candidate.actor === 'string');
}

function parseAttachReadOptions(searchParams: URLSearchParams) {
  return {
    requestedOutputOffset: parseOptionalNonNegativeQueryInt(searchParams.get('outputOffset')),
    requestedEventSeq: parseOptionalNonNegativeQueryInt(searchParams.get('eventSeq')),
    maxChars: parsePositiveQueryInt(searchParams.get('maxChars'), DEFAULT_DASHBOARD_LEFT_CHARS),
    maxEvents: parsePositiveQueryInt(searchParams.get('maxEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS * 4),
    waitMs: parseNonNegativeQueryInt(searchParams.get('waitMs'), 0),
  };
}

function parseViewerSnapshotOptions(searchParams: URLSearchParams) {
  return {
    width: parsePositiveQueryInt(searchParams.get('width'), DEFAULT_DASHBOARD_WIDTH),
    height: parsePositiveQueryInt(searchParams.get('height'), DEFAULT_DASHBOARD_HEIGHT),
    leftChars: parsePositiveQueryInt(searchParams.get('leftChars'), DEFAULT_DASHBOARD_LEFT_CHARS),
    rightEvents: parsePositiveQueryInt(searchParams.get('rightEvents'), DEFAULT_DASHBOARD_RIGHT_EVENTS),
    stripAnsiFromLeft: parseBooleanQuery(searchParams.get('stripAnsiFromLeft'), true),
  };
}

function createRequestAbortScope(request: IncomingMessage) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  request.once('close', abort);
  request.once('aborted', abort);

  return {
    signal: controller.signal,
    cleanup() {
      request.off('close', abort);
      request.off('aborted', abort);
    },
  };
}

function buildLivePayload() {
  return {
    ok: true,
    instanceId: INSTANCE_ID,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

async function buildReadinessPayload() {
  const checks = {
    stateDirWritable: false,
    viewerReady: !VIEWER_PORT_SETTING.enabled,
    distributedStoreReachable: true,
    nodeHeartbeatFresh: true,
  };

  try {
    await fs.mkdir(RUNTIME_PATHS.instanceDir, { recursive: true });
    await fs.access(RUNTIME_PATHS.instanceDir, fsConstants.W_OK);
    checks.stateDirWritable = true;
  } catch {
    checks.stateDirWritable = false;
  }

  if (VIEWER_PORT_SETTING.enabled) {
    checks.viewerReady = actualViewerPort > 0;
  }

  if (distributedModeEnabled()) {
    checks.distributedStoreReachable = await distributedStoreHealthy();
    checks.nodeHeartbeatFresh = Boolean(nodeLastHeartbeatAt);
  }

  const ok = checks.stateDirWritable
    && checks.viewerReady
    && checks.distributedStoreReachable
    && checks.nodeHeartbeatFresh;

  return {
    ok,
    instanceId: INSTANCE_ID,
    configPath: PROFILES.path,
    stateDir: RUNTIME_PATHS.instanceDir,
    logDir: LOG_CONFIG.dir,
    viewerEnabled: VIEWER_PORT_SETTING.enabled,
    distributedMode: distributedModeEnabled(),
    viewerPort: actualViewerPort || undefined,
    checks,
  };
}

function buildMetricsPayload() {
  const startedAtSeconds = Math.floor((Date.now() - process.uptime() * 1000) / 1000);
  const viewerClients = viewerWss?.clients.size || 0;
  const viewerEnabled = VIEWER_PORT_SETTING.enabled ? 1 : 0;
  const viewerReady = !VIEWER_PORT_SETTING.enabled || actualViewerPort > 0 ? 1 : 0;
  const ownerSessions = [...sessions.values()].filter(session => session.metadata.ownerNodeId === undefined || session.metadata.ownerNodeId === NODE_ID).length;
  const orphanedClusterSessions = [...clusterSessions.values()].filter(record => record.availability === 'unavailable').length;

  return [
    '# HELP ssh_session_mcp_up Whether the ssh-session-mcp process is running.',
    '# TYPE ssh_session_mcp_up gauge',
    'ssh_session_mcp_up 1',
    '# HELP ssh_session_mcp_process_start_time_seconds Unix time when the current process started.',
    '# TYPE ssh_session_mcp_process_start_time_seconds gauge',
    `ssh_session_mcp_process_start_time_seconds ${startedAtSeconds}`,
    '# HELP ssh_session_mcp_sessions Number of tracked sessions.',
    '# TYPE ssh_session_mcp_sessions gauge',
    `ssh_session_mcp_sessions ${sessions.size}`,
    '# HELP ssh_session_mcp_running_commands Number of tracked running commands.',
    '# TYPE ssh_session_mcp_running_commands gauge',
    `ssh_session_mcp_running_commands ${[...runningCommands.values()].filter(entry => entry.status === 'running').length}`,
    '# HELP ssh_session_mcp_viewer_bindings Number of active viewer bindings.',
    '# TYPE ssh_session_mcp_viewer_bindings gauge',
    `ssh_session_mcp_viewer_bindings ${viewerBindings.size}`,
    '# HELP ssh_session_mcp_viewer_processes Number of tracked viewer processes.',
    '# TYPE ssh_session_mcp_viewer_processes gauge',
    `ssh_session_mcp_viewer_processes ${viewerProcesses.size}`,
    '# HELP ssh_session_mcp_viewer_clients Number of connected websocket viewer clients.',
    '# TYPE ssh_session_mcp_viewer_clients gauge',
    `ssh_session_mcp_viewer_clients ${viewerClients}`,
    '# HELP ssh_session_mcp_viewer_enabled Whether the viewer HTTP server is configured.',
    '# TYPE ssh_session_mcp_viewer_enabled gauge',
    `ssh_session_mcp_viewer_enabled ${viewerEnabled}`,
    '# HELP ssh_session_mcp_viewer_ready Whether the viewer HTTP server is currently listening.',
    '# TYPE ssh_session_mcp_viewer_ready gauge',
    `ssh_session_mcp_viewer_ready ${viewerReady}`,
    '# HELP ssh_session_mcp_owner_sessions Number of sessions currently owned by this node.',
    '# TYPE ssh_session_mcp_owner_sessions gauge',
    `ssh_session_mcp_owner_sessions ${ownerSessions}`,
    '# HELP ssh_session_mcp_orphaned_cluster_sessions Number of distributed session records marked unavailable.',
    '# TYPE ssh_session_mcp_orphaned_cluster_sessions gauge',
    `ssh_session_mcp_orphaned_cluster_sessions ${orphanedClusterSessions}`,
    '',
  ].join('\n');
}

function buildHealthPayload() {
  return {
    ok: true,
    instanceId: INSTANCE_ID,
    configPath: PROFILES.path,
    stateDir: RUNTIME_PATHS.instanceDir,
    logDir: LOG_CONFIG.dir,
    logMode: LOG_CONFIG.mode,
    distributedMode: distributedModeEnabled(),
    viewerBaseUrl: getViewerBaseUrl(),
    viewerPort: actualViewerPort || undefined,
    sessions: sessions.size,
  };
}

async function buildSessionsPayload() {
  sweepSessions();
  if (distributedModeEnabled()) {
    await refreshDistributedCaches();
    return {
      instanceId: INSTANCE_ID,
      activeSessionRef: refreshActiveSession()?.metadata.sessionRef || null,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerPort: actualViewerPort || undefined,
      viewerAccessPolicy,
      sessions: [...clusterSessions.values()]
        .map(record => ({
          ...record.summary,
          viewerUrl: record.routableBaseUrl
            ? `${record.routableBaseUrl}/session/${encodeURIComponent(record.summary.sessionId)}`
            : undefined,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }

  return {
    instanceId: INSTANCE_ID,
    activeSessionRef: refreshActiveSession()?.metadata.sessionRef || null,
    viewerBaseUrl: getViewerBaseUrl(),
    viewerPort: actualViewerPort || undefined,
    viewerAccessPolicy,
    sessions: [...sessions.values()]
      .map(session => ({
        ...session.summary(),
        viewerUrl: buildViewerSessionUrl(session),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}

function buildViewerAccessPolicyPayload() {
  return {
    viewerBaseUrl: getViewerBaseUrl(),
    viewerPort: actualViewerPort || undefined,
    policy: viewerAccessPolicy,
  };
}

async function handleAttachReadRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  url: URL,
  writers: ViewerResponseWriters,
) {
  try {
    const { binding, session } = resolveAttachTarget(kind, ref);
    const options = parseAttachReadOptions(url.searchParams);
    const baselineOutputOffset = typeof options.requestedOutputOffset === 'number'
      ? options.requestedOutputOffset
      : session.currentBufferEnd();
    const baselineEventSeq = typeof options.requestedEventSeq === 'number'
      ? options.requestedEventSeq
      : session.currentEventEnd();

    if (options.waitMs > 0) {
      const abortScope = createRequestAbortScope(request);
      try {
        await session.waitForChange({
          outputOffset: baselineOutputOffset,
          eventSeq: baselineEventSeq,
          waitMs: options.waitMs,
          signal: abortScope.signal,
        });
      } finally {
        abortScope.cleanup();
      }
    }

    if (request.destroyed) {
      return;
    }

    writers.writeJson(200, createAttachPayload(session, {
      bindingKey: binding?.bindingKey,
      outputOffset: options.requestedOutputOffset,
      eventSeq: options.requestedEventSeq,
      maxChars: options.maxChars,
      maxEvents: options.maxEvents,
    }));
  } catch (error) {
    writers.writeError(404, error);
  }
}

async function handleAttachInputRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  writers: ViewerResponseWriters,
) {
  try {
    const { session } = resolveAttachTarget(kind, ref);
    const body = await readJsonRequestBody(request);
    const rawData = typeof body.data === 'string' ? body.data : undefined;

    if (!rawData || rawData.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'data must be a non-empty string');
    }

    if (session.effectiveInputLock() === 'agent') {
      throw new McpError(ErrorCode.InvalidRequest, 'Input locked by AI agent. Switch the terminal back to common or user mode before typing here.');
    }

      const records: SessionWriteRecord[] = [];

    if (Array.isArray(body.records)) {
      for (const value of body.records) {
        if (!isSessionWriteRecordCandidate(value)) {
          continue;
        }

        records.push({
          actor: sanitizeActor(value.actor, 'user'),
          text: value.text,
          type: value.type,
        });
      }
    } else if ((body.recordType === 'input' || body.recordType === 'control') && typeof body.displayText === 'string') {
      records.push({
        actor: sanitizeActor(typeof body.actor === 'string' ? body.actor : undefined, 'user'),
        text: body.displayText,
        type: body.recordType,
      });
    }

    if (typeof (session as typeof session & { noteUserDraftDelta?: (data: string) => void }).noteUserDraftDelta === 'function') {
      session.noteUserDraftDelta(rawData);
    }
    session.writeRaw(rawData, records);
    logSessionEvent(session.sessionId, 'session.input', {
      actor: records[0]?.actor || 'user',
      sentChars: rawData.length,
    });
    writers.writeJson(200, {
      ok: true,
      ...session.summary(),
      recordedEvents: records.length,
      nextOutputOffset: session.currentBufferEnd(),
      nextEventSeq: session.currentEventEnd(),
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

async function handleViewerAccessPolicyRequest(request: IncomingMessage, writers: ViewerResponseWriters) {
  if ((request.method || 'GET').toUpperCase() === 'GET') {
    writers.writeJson(200, buildViewerAccessPolicyPayload());
    return;
  }

  try {
    const body = await readJsonRequestBody(request);
    const mode = body.mode === 'allowlist' || body.mode === 'denylist' ? body.mode : 'allow_all';
    const ipAllowlist = Array.isArray(body.ipAllowlist) ? body.ipAllowlist.map(value => String(value)) : [];
    const ipDenylist = Array.isArray(body.ipDenylist) ? body.ipDenylist.map(value => String(value)) : [];
    const allowedOrigins = Array.isArray(body.allowedOrigins) ? body.allowedOrigins.map(value => String(value)) : [];
    const nextPolicy: ViewerAccessPolicy = {
      mode,
      ipAllowlist,
      ipDenylist,
      allowedOrigins,
      updatedAt: new Date().toISOString(),
    };
    setViewerAccessPolicy(nextPolicy);
    await saveViewerAccessPolicy();
    writers.writeJson(200, buildViewerAccessPolicyPayload());
  } catch (error) {
    writers.writeError(400, error);
  }
}

async function handleSessionPolicyRequest(sessionRef: string, request: IncomingMessage, writers: ViewerResponseWriters) {
  try {
    const session = resolveSession(sessionRef);
    if ((request.method || 'GET').toUpperCase() === 'GET') {
      writers.writeJson(200, {
        session: session.summary(),
        inheritedRules: session.getDefaultPolicyRules(),
        activeRules: session.getPolicyRules(),
        sessionOverrideRules: session.getSessionOverrideRules(),
      });
      return;
    }

    const body = await readJsonRequestBody(request);
    if (!Array.isArray(body.rules)) {
      throw new McpError(ErrorCode.InvalidRequest, 'rules must be an array');
    }

    session.resetPolicyRules(session.getDefaultPolicyRules());
    for (const [index, value] of body.rules.entries()) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const candidate = value as Record<string, unknown>;
      const id = sanitizeActor(typeof candidate.id === 'string' ? candidate.id : undefined, '');
      if (!id) {
        continue;
      }
      session.upsertPolicyRule({
        id,
        enabled: candidate.enabled !== false,
        pattern: typeof candidate.pattern === 'string' ? candidate.pattern : '',
        flags: typeof candidate.flags === 'string' ? candidate.flags : '',
        priority: typeof candidate.priority === 'number' ? candidate.priority : index,
        mode: candidate.mode === 'full' || candidate.mode === 'both' ? candidate.mode : 'safe',
        category: candidate.category === 'blocked' || candidate.category === 'interactive' || candidate.category === 'streaming' || candidate.category === 'long_running'
          ? candidate.category
          : 'dangerous',
        action: candidate.action === 'warning' || candidate.action === 'log' ? candidate.action : 'error',
        message: typeof candidate.message === 'string' ? candidate.message : '',
        suggestion: typeof candidate.suggestion === 'string' ? candidate.suggestion : undefined,
        source: 'session',
      } as any);
    }

    writers.writeJson(200, {
      session: session.summary(),
      inheritedRules: session.getDefaultPolicyRules(),
      activeRules: session.getPolicyRules(),
      sessionOverrideRules: session.getSessionOverrideRules(),
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

async function handleSessionModeRequest(sessionRef: string, request: IncomingMessage, writers: ViewerResponseWriters) {
  try {
    const session = resolveSession(sessionRef);
    if ((request.method || 'GET').toUpperCase() === 'GET') {
      writers.writeJson(200, {
        session: session.summary(),
        operationMode: session.operationMode,
      });
      return;
    }

    const body = await readJsonRequestBody(request);
    const nextMode = body.mode === 'full' ? 'full' : 'safe';
    session.setOperationMode(nextMode);
    writers.writeJson(200, {
      session: session.summary(),
      operationMode: session.operationMode,
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

async function handleAttachResizeRequest(
  request: IncomingMessage,
  kind: ViewerAttachKind,
  ref: string,
  writers: ViewerResponseWriters,
) {
  try {
    const { session } = resolveAttachTarget(kind, ref);
    const body = await readJsonRequestBody(request);
    const cols = typeof body.cols === 'number' ? body.cols : Number(body.cols);
    const rows = typeof body.rows === 'number' ? body.rows : Number(body.rows);
    const resolvedCols = sanitizePositiveInt(cols, 'cols', session.cols);
    const resolvedRows = sanitizePositiveInt(rows, 'rows', session.rows);

    session.resize(resolvedCols, resolvedRows);
    writers.writeJson(200, {
      ok: true,
      ...session.summary(),
      cols: resolvedCols,
      rows: resolvedRows,
    });
  } catch (error) {
    writers.writeError(400, error);
  }
}

function handleSessionApiRequest(sessionRef: string, url: URL, writers: ViewerResponseWriters) {
  try {
    const session = resolveSession(sessionRef);
    writers.writeJson(200, createViewerPayload(session, parseViewerSnapshotOptions(url.searchParams)));
  } catch (error) { writers.writeError(404, error); }
}

function handleSessionCloseRequest(sessionRef: string, writers: ViewerResponseWriters) {
  try {
    const s = resolveSession(sessionRef);
    s.close(); forgetSession(s.sessionId); sweepSessions();
    writers.writeJson(200, { ok: true, closed: s.metadata.sessionRef || s.sessionId });
  } catch (error) { writers.writeError(404, error); }
}

function handleSessionDiagnosticsRequest(sessionRef: string, writers: ViewerResponseWriters) {
  try { writers.writeJson(200, buildSessionDiagnostics(resolveSession(sessionRef))); }
  catch (error) { writers.writeError(404, error); }
}

function handleSessionHistoryRequest(sessionRef: string, url: URL, writers: ViewerResponseWriters) {
  try {
    const s = resolveSession(sessionRef);
    const m = parsePositiveQueryInt(url.searchParams.get('maxLines'), 40);
    const snap = s.readHistory(undefined, m);
    writers.writeJson(200, { sessionRef: s.metadata.sessionRef, lines: snap.lines, view: snap.view,
      availableStart: snap.availableStart, availableEnd: snap.availableEnd,
      truncatedBefore: snap.truncatedBefore, truncatedAfter: snap.truncatedAfter });
  } catch (error) { writers.writeError(404, error); }
}

async function handleSessionAgentInputRequest(sessionRef: string, writers: ViewerResponseWriters, request?: IncomingMessage) {
  if (!DEBUG_MODE) { writers.writeError(403, new McpError(ErrorCode.InvalidRequest, 'debug only')); return; }
  try {
    const s = resolveSession(sessionRef);
    const body = request ? await readJsonRequestBody(request) : {};
    const cmd = typeof body.command === 'string' ? body.command.trim() : '';
    if (!cmd) { writers.writeError(400, new McpError(ErrorCode.InvalidRequest, 'command required')); return; }
    if (s.effectiveInputLock() === 'user') { writers.writeError(403, new McpError(ErrorCode.InvalidRequest, buildUserLockMessage(s, 'send commands'))); return; }
    const validation = validateCommand(cmd, s.operationMode, s.getPolicyRules());
    if (!validation.allowed) {
      logSessionEvent(s.sessionId, 'command.blocked', {
        actor: 'debug-agent',
        category: validation.category,
        action: validation.action,
        ruleId: validation.ruleId,
        ruleSource: validation.source,
        operationMode: s.operationMode,
      });
      writers.writeError(403, new McpError(ErrorCode.InvalidRequest, validation.message || 'command blocked by policy'));
      return;
    }
    const terminalMode = detectTerminalMode(s.buffer.slice(-2000));
    if (terminalMode === 'password_prompt') {
      writers.writeError(403, new McpError(ErrorCode.InvalidRequest, 'terminal is at a password prompt'));
      return;
    }
    if (s.operationMode === 'safe' && (terminalMode === 'editor' || terminalMode === 'pager')) {
      writers.writeError(403, new McpError(ErrorCode.InvalidRequest, `terminal is in ${terminalMode} mode`));
      return;
    }
    s.setAgentInputActive(true);
    s.write(cmd + '\n', 'agent');
    s.setAgentInputActive(false);
    writers.writeJson(200, { ok: true, sent: cmd, sessionRef: s.metadata.sessionRef });
  } catch (error) { writers.writeError(404, error); }
}

async function handleSessionControlRequest(sessionRef: string, writers: ViewerResponseWriters, request?: IncomingMessage) {
  if (!DEBUG_MODE) { writers.writeError(403, new McpError(ErrorCode.InvalidRequest, 'debug only')); return; }
  try {
    const s = resolveSession(sessionRef);
    const body = request ? await readJsonRequestBody(request) : {};
    const key = typeof body.key === 'string' ? body.key : '';
    if (!['ctrl_c','ctrl_d','enter','tab','esc','up','down','left','right','backspace'].includes(key))
      { writers.writeError(400, new McpError(ErrorCode.InvalidRequest, 'invalid key')); return; }
    s.sendControl(key as any, 'agent');
    writers.writeJson(200, { ok: true, key, sessionRef: s.metadata.sessionRef });
  } catch (error) { writers.writeError(404, error); }
}

function handleSessionSetActiveRequest(sessionRef: string, writers: ViewerResponseWriters) {
  try { setActiveSession(resolveSession(sessionRef)); writers.writeJson(200, { ok: true }); }
  catch (error) { writers.writeError(404, error); }
}

async function handleSessionsCreateRequest(writers: ViewerResponseWriters) {
  if (!LOCAL_MODE) { writers.writeError(400, new McpError(ErrorCode.InvalidRequest, 'local only')); return; }
  try {
    const sid = randomUUID();
    const nm = 'local-' + sid.slice(0, 8);
    const m = buildSessionMetadata({ profileSource: 'manual', sessionId: sid, sessionName: nm });
    const s = await openSSHSession({ cols: DEFAULT_COLS, closedRetentionMs: DEFAULT_CLOSED_RETENTION_MS,
      host: 'localhost', idleTimeoutMs: DEFAULT_TIMEOUT, metadata: m, port: 0,
      policyRules: buildConfiguredSessionPolicyRules(),
      rows: DEFAULT_ROWS, sessionId: sid, sessionName: nm, term: DEFAULT_TERM,
      user: process.env.USER || process.env.USERNAME || 'local' });
    rememberSession(s); setActiveSession(s);
    writers.writeJson(201, { ok: true, session: s.summary(), viewerUrl: buildViewerSessionUrl(s) });
  } catch (error) { writers.writeError(500, error); }
}

function handleViewerBindingApiRequest(bindingKey: string, url: URL, writers: ViewerResponseWriters) {
  try {
    writers.writeJson(200, createViewerBindingPayload(bindingKey, parseViewerSnapshotOptions(url.searchParams)));
  } catch (error) {
    writers.writeError(404, error);
  }
}

export async function handleViewerHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const route = matchViewerHttpRoute(request.method, url.pathname);
  const writers = createViewerResponseWriters(response);
  const identity = extractViewerIdentity(request.headers);

  try {
    ensureViewerIdentityAuthorized(identity, requiredViewerRoleForRoute(route, request.method));
  } catch (error) {
    writeViewerError(403, error, writers);
    return;
  }

  const remoteOwner = distributedModeEnabled()
    ? await resolveRemoteOwnerForRoute(route, url)
    : undefined;
  if (remoteOwner) {
    switch (route.type) {
      case 'terminal-session-page':
      case 'terminal-binding-page':
      case 'legacy-session-page':
      case 'legacy-binding-page':
        writeRemoteOwnerError(route.type, remoteOwner, writers, true);
        return;
      case 'not-found':
      case 'home-page':
      case 'live':
      case 'ready':
      case 'metrics':
      case 'health':
      case 'sessions-api':
      case 'viewer-access-policy-api':
      case 'sessions-create':
        break;
      default:
        writers.writeJson(409, buildRemoteOwnerPayload(remoteOwner));
        return;
    }
  }

  switch (route.type) {
    case 'live':
      writers.writeJson(200, buildLivePayload());
      return;
    case 'ready': {
      const payload = await buildReadinessPayload();
      writers.writeJson(payload.ok ? 200 : 503, payload);
      return;
    }
    case 'metrics':
      writers.writeText(200, buildMetricsPayload(), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    case 'health':
      writers.writeJson(200, buildHealthPayload());
      return;
    case 'sessions-api':
      writers.writeJson(200, await buildSessionsPayload());
      return;
    case 'viewer-access-policy-api':
      await handleViewerAccessPolicyRequest(request, writers);
      return;
    case 'attach-read':
      await handleAttachReadRequest(request, route.kind, route.ref, url, writers);
      return;
    case 'attach-input':
      await handleAttachInputRequest(request, route.kind, route.ref, writers);
      return;
    case 'attach-resize':
      await handleAttachResizeRequest(request, route.kind, route.ref, writers);
      return;
    case 'session-api':
      handleSessionApiRequest(route.sessionRef, url, writers);
      return;
    case 'viewer-binding-api':
      handleViewerBindingApiRequest(route.bindingKey, url, writers);
      return;
    case 'terminal-session-page':
      writers.writeHtml(200, renderXtermSessionPage(route.sessionRef));
      return;
    case 'terminal-binding-page':
      writers.writeHtml(200, renderXtermBindingPage(route.bindingKey));
      return;
    case 'legacy-session-page':
      writers.writeHtml(200, renderViewerSessionPage(route.sessionRef));
      return;
    case 'legacy-binding-page':
      writers.writeHtml(200, renderViewerBindingPage(route.bindingKey));
      return;
    case 'home-page':
      writers.writeHtml(200, renderViewerHomePage(DEBUG_MODE));
      return;
    case 'session-close':
      handleSessionCloseRequest(route.sessionRef, writers);
      return;
    case 'session-diagnostics':
      handleSessionDiagnosticsRequest(route.sessionRef, writers);
      return;
    case 'session-history':
      handleSessionHistoryRequest(route.sessionRef, url, writers);
      return;
    case 'session-policy-api':
      await handleSessionPolicyRequest(route.sessionRef, request, writers);
      return;
    case 'session-mode-api':
      await handleSessionModeRequest(route.sessionRef, request, writers);
      return;
    case 'session-agent-input':
      await handleSessionAgentInputRequest(route.sessionRef, writers, request);
      return;
    case 'session-control':
      await handleSessionControlRequest(route.sessionRef, writers, request);
      return;
    case 'session-set-active':
      handleSessionSetActiveRequest(route.sessionRef, writers);
      return;
    case 'sessions-create':
      await handleSessionsCreateRequest(writers);
      return;
    case 'not-found':
      writers.writeText(404, 'Not found');
      return;
  }
}
