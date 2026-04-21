import type { LogMode } from './logger.js';
import type { SessionSummary } from './session.js';

export interface DiagnosticWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning';
}

export interface SessionDiagnosticReport {
  session: SessionSummary;
  terminalMode: string;
  runningCommand: {
    commandId: string;
    program?: string;
    startedAt: string;
    status: string;
  } | null;
  viewer: {
    bindingKey?: string;
    mode?: string;
    pid?: number;
    reused?: boolean;
    staleProcess: boolean;
  };
  buffers: {
    bufferEnd: number;
    bufferStart: number;
    eventEndSeq: number;
    eventStartSeq: number;
    historyLineEnd: number;
    historyLineStart: number;
    historyPendingOutput: boolean;
  };
  logging: {
    dir: string;
    enabled: boolean;
    mode: LogMode;
  };
  warnings: DiagnosticWarning[];
}

export interface DiagnosticsOverview {
  generatedAt: string;
  logging: {
    dir: string;
    enabled: boolean;
    mode: LogMode;
  };
  sessions: SessionDiagnosticReport[];
}

export function buildSessionDiagnosticReport(options: {
  historyLineEnd: number;
  historyLineStart: number;
  historyPendingOutput: boolean;
  logDir: string;
  logMode: LogMode;
  runningCommand?: {
    commandId: string;
    program?: string;
    startedAt: string;
    status: string;
  };
  session: SessionSummary;
  staleViewerProcess?: boolean;
  terminalMode: string;
  viewer?: {
    bindingKey?: string;
    mode?: string;
    pid?: number;
    reused?: boolean;
  };
}): SessionDiagnosticReport {
  const warnings: DiagnosticWarning[] = [];

  if (options.terminalMode === 'password_prompt') {
    warnings.push({
      code: 'password_prompt',
      severity: 'warning',
      message: 'Terminal is waiting for a password. Sending agent commands now is unsafe.',
    });
  }

  if (options.staleViewerProcess) {
    warnings.push({
      code: 'stale_viewer_process',
      severity: 'warning',
      message: 'Viewer state references a dead local viewer process.',
    });
  }

  if (options.session.inputLock === 'agent' && !options.runningCommand) {
    warnings.push({
      code: 'agent_lock_without_command',
      severity: 'warning',
      message: 'Session is locked to agent input, but no tracked running command is attached.',
    });
  }

  if (options.session.inputLock === 'user') {
    warnings.push({
      code: 'user_lock_active',
      severity: 'info',
      message: 'User-only input lock is active. Agent writes will be rejected.',
    });
  }

  if (options.session.bufferStart > 0 || options.session.eventStartSeq > 0 || options.historyLineStart > 1) {
    warnings.push({
      code: 'buffer_trimmed',
      severity: 'info',
      message: 'Old output, events, or history lines have already been trimmed from in-memory buffers.',
    });
  }

  if (options.session.closed) {
    warnings.push({
      code: 'closed_session_retained',
      severity: 'info',
      message: 'Session is closed and only retained temporarily for inspection.',
    });
  }

  return {
    session: options.session,
    terminalMode: options.terminalMode,
    runningCommand: options.runningCommand
      ? {
        commandId: options.runningCommand.commandId,
        program: options.runningCommand.program,
        startedAt: options.runningCommand.startedAt,
        status: options.runningCommand.status,
      }
      : null,
    viewer: {
      bindingKey: options.viewer?.bindingKey,
      mode: options.viewer?.mode,
      pid: options.viewer?.pid,
      reused: options.viewer?.reused,
      staleProcess: options.staleViewerProcess === true,
    },
    buffers: {
      bufferStart: options.session.bufferStart,
      bufferEnd: options.session.bufferEnd,
      eventStartSeq: options.session.eventStartSeq,
      eventEndSeq: options.session.eventEndSeq,
      historyLineStart: options.historyLineStart,
      historyLineEnd: options.historyLineEnd,
      historyPendingOutput: options.historyPendingOutput,
    },
    logging: {
      mode: options.logMode,
      enabled: options.logMode !== 'off',
      dir: options.logDir,
    },
    warnings,
  };
}

export function buildDiagnosticsOverview(options: {
  logDir: string;
  logMode: LogMode;
  sessions: SessionDiagnosticReport[];
}) {
  return {
    generatedAt: new Date().toISOString(),
    logging: {
      mode: options.logMode,
      enabled: options.logMode !== 'off',
      dir: options.logDir,
    },
    sessions: options.sessions,
  } satisfies DiagnosticsOverview;
}
