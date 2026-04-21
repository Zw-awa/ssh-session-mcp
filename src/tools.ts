import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  server,
  sessions,
  runningCommands,
  viewerBindings,
  viewerProcesses,
  activeSessionId,
  INSTANCE_ID,
  PROFILES,
  CONFIG_DEFAULTS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_USER,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_TERM,
  DEFAULT_TIMEOUT,
  DEFAULT_CLOSED_RETENTION_MS,
  DEFAULT_IDLE_SWEEP_MS,
  DEFAULT_READ_CHARS,
  DEFAULT_DASHBOARD_WIDTH,
  DEFAULT_DASHBOARD_HEIGHT,
  DEFAULT_DASHBOARD_LEFT_CHARS,
  DEFAULT_DASHBOARD_RIGHT_EVENTS,
  DEFAULT_WATCH_WAIT_MS,
  DEFAULT_VIEWER_REFRESH_MS,
  MAX_BUFFER_CHARS,
  MAX_HISTORY_LINES,
  OPERATION_MODE,
  setOperationMode,
  USE_SENTINEL_MARKER,
  AUTO_OPEN_TERMINAL,
  VIEWER_LAUNCH_MODE,
  VIEWER_PORT_SETTING,
  LOG_CONFIG,
  RUNTIME_PATHS,
  tuning,
  logger,
  resolveSession,
  resolveSessionForBinding,
  resolveAttachTarget,
  resolveProfileOrThrow,
  resolveConfiguredDefaultDeviceId,
  ensureUniqueSessionName,
  findOpenSessionByName,
  findOpenProfileSession,
  findRunningCommandForSession,
  inferProfileSource,
  allocateConnectionName,
  buildSessionMetadata,
  buildSessionDiagnostics,
  buildDashboard,
  buildDashboardState,
  buildConnectionKey,
  buildViewerBindingKeyForSession,
  buildViewerBindingUrl,
  buildViewerSessionUrl,
  buildSentinelCommandSuffix,
  cleanCommandOutput,
  startBackgroundMonitor,
  sweepSessions,
  setActiveSession,
  refreshActiveSession,
  sessionDisplayName,
  sessionReadRef,
  openSSHSession,
  ensureViewerForSession,
  upsertViewerBinding,
  launchBrowserViewer,
  actualViewerPort,
  DEFAULT_PASSWORD,
  DEFAULT_KEY,
  loadViewerProcessState,
  saveViewerProcessState,
  terminateViewerProcess,
  viewerProcessAlive,
  viewerScopeValue,
  viewerModeValue,
  getViewerBaseUrl,
  createToolResponse,
  createJsonToolResponse,
  applyToolContract,
  logSessionEvent,
  logServerEvent,
  broadcastLock,
  escapeRegExp,
  type RunningCommand,
  type ViewerLaunchMode,
  type ViewerSingletonScope,
  type OperationMode,
  type CompletionResult,
  SSHSession,
  SSHConnection,
  DEFAULT_PROMPT_PATTERNS,
  delay,
  sanitizeActor,
  sanitizeNonNegativeInt,
  sanitizeOptionalText,
  sanitizePort,
  sanitizePositiveInt,
  sanitizeRequiredText,
  stripAnsi,
  normalizePaneText,
  buildDiagnosticsOverview,
  buildReadMoreHint,
  buildReadProgress,
  buildSnapshotReadMore,
  summarizeAuth,
  summarizeCommandMeta,
  validateCommand,
  detectTerminalMode,
  isKnownSlowCommand,
  tryParseCommandOutput,
  McpError,
  ErrorCode,
} from './server-state.js';

export function registerTools() {
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
  'One-step: open SSH session using configured device profiles when available, otherwise fall back to legacy .env defaults. Reuse an existing session when possible and return viewer details when enabled.',
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
          source: PROFILES.source,
          configResolution: PROFILES.resolution,
          activeSessionRef: existing.metadata.sessionRef,
          session: existing.summary(),
          terminalUrl,
          viewerBaseUrl: getViewerBaseUrl(),
          viewerEnabled: Boolean(getViewerBaseUrl()),
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
        source: PROFILES.source,
        configResolution: PROFILES.resolution,
        activeSessionRef: metadata.sessionRef,
        configPath: PROFILES.path,
        configPaths: PROFILES.paths,
        terminalUrl,
        viewerBaseUrl: getViewerBaseUrl(),
        viewerEnabled: Boolean(getViewerBaseUrl()),
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
        source: PROFILES.source,
        configResolution: PROFILES.resolution,
        activeSessionRef: existing.metadata.sessionRef,
        session: existing.summary(),
        terminalUrl,
        viewerBaseUrl: getViewerBaseUrl(),
        viewerEnabled: Boolean(getViewerBaseUrl()),
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
      source: PROFILES.source,
      configResolution: PROFILES.resolution,
      activeSessionRef: metadata.sessionRef,
      configPath: PROFILES.path,
      configPaths: PROFILES.paths,
      terminalUrl,
      viewerBaseUrl: getViewerBaseUrl(),
      viewerEnabled: Boolean(getViewerBaseUrl()),
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

}
