import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogMode = 'off' | 'meta';

export interface LoggerConfig {
  dir: string;
  mode: LogMode;
}

interface LogRecord {
  at: string;
  data?: Record<string, unknown>;
  event: string;
  scope: 'server' | 'session';
  sessionId?: string;
}

const DEFAULT_LOG_DIR = fileURLToPath(new URL('../logs/session-mcp/', import.meta.url));

function normalizeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(item => normalizeValue(item))
      .filter(item => item !== undefined);
  }

  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = normalizeValue(item);
      if (next !== undefined) {
        normalized[key] = next;
      }
    }
    return normalized;
  }

  return String(value);
}

export function resolveLoggerConfig(modeRaw: string | undefined, dirRaw: string | undefined): LoggerConfig {
  const mode = modeRaw === 'meta' ? 'meta' : 'off';
  return {
    mode,
    dir: dirRaw && dirRaw.trim().length > 0 ? dirRaw.trim() : DEFAULT_LOG_DIR,
  };
}

export function summarizeCommandMeta(command: string) {
  const trimmed = command.trim();
  return {
    commandLength: command.length,
    commandProgram: trimmed.length > 0 ? trimmed.split(/\s+/)[0] : '',
  };
}

export class SessionLogger {
  private queue = Promise.resolve();

  constructor(private readonly config: LoggerConfig) {}

  getConfig() {
    return {
      ...this.config,
      enabled: this.config.mode !== 'off',
    };
  }

  private append(filePath: string, record: LogRecord) {
    if (this.config.mode === 'off') {
      return Promise.resolve();
    }

    const payload = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(async () => {
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, payload, 'utf8');
    }).catch(() => {
      // Logging must never break MCP behavior.
    });

    return this.queue;
  }

  private serverLogPath() {
    return `${this.config.dir}/server.jsonl`;
  }

  private sessionLogPath(sessionId: string) {
    return `${this.config.dir}/sessions/${sessionId}.jsonl`;
  }

  logServer(event: string, data?: Record<string, unknown>) {
    return this.append(this.serverLogPath(), {
      at: new Date().toISOString(),
      event,
      scope: 'server',
      data: normalizeValue(data) as Record<string, unknown> | undefined,
    });
  }

  logSession(sessionId: string, event: string, data?: Record<string, unknown>) {
    return this.append(this.sessionLogPath(sessionId), {
      at: new Date().toISOString(),
      event,
      scope: 'session',
      sessionId,
      data: normalizeValue(data) as Record<string, unknown> | undefined,
    });
  }
}
