#!/usr/bin/env node

interface ViewerCliConfig {
  actor: string;
  binding: string;
  exitOnClosed: boolean;
  exitOnUnavailableMs: number;
  helpFooter: boolean;
  host: string;
  intervalMs: number;
  leftChars: number;
  port: number;
  rightEvents: number;
  session: string;
  statusBar: boolean;
  syncWindowSize: boolean;
}

interface AttachEvent {
  actor?: string;
  at: string;
  seq: number;
  text: string;
  type: 'input' | 'control' | 'lifecycle' | 'output';
}

interface AttachPayload {
  binding?: {
    bindingKey: string;
  } | null;
  bindingKey?: string;
  events: AttachEvent[];
  nextEventSeq: number;
  nextOutputOffset: number;
  output: string;
  summary?: {
    closed?: boolean;
    host?: string;
    port?: number;
    sessionId?: string;
    sessionName?: string;
    user?: string;
  };
}

interface PendingWriteRecord {
  actor: string;
  text: string;
  type: 'input' | 'control';
}

interface LocalInputState {
  currentLine: string;
}

function parseArgv(argv: string[]): ViewerCliConfig {
  const defaults: ViewerCliConfig = {
    actor: 'user',
    binding: '',
    exitOnClosed: true,
    exitOnUnavailableMs: 3000,
    helpFooter: true,
    host: '127.0.0.1',
    intervalMs: 250,
    leftChars: 12000,
    port: 8765,
    rightEvents: 80,
    session: '',
    statusBar: true,
    syncWindowSize: true,
  };

  const config = { ...defaults };

  for (const rawArg of argv) {
    if (!rawArg.startsWith('--')) continue;
    const equalIndex = rawArg.indexOf('=');
    const key = equalIndex === -1 ? rawArg.slice(2) : rawArg.slice(2, equalIndex);
    const value = equalIndex === -1 ? '' : rawArg.slice(equalIndex + 1);

    switch (key) {
      case 'actor':
        if (value) config.actor = value;
        break;
      case 'host':
        if (value) config.host = value;
        break;
      case 'port':
        config.port = Number(value);
        break;
      case 'session':
        config.session = value;
        break;
      case 'binding':
        config.binding = value;
        break;
      case 'intervalMs':
        config.intervalMs = Number(value);
        break;
      case 'leftChars':
        config.leftChars = Number(value);
        break;
      case 'rightEvents':
        config.rightEvents = Number(value);
        break;
      case 'statusBar':
        config.statusBar = value !== 'false' && value !== '0';
        break;
      case 'exitOnUnavailableMs':
        config.exitOnUnavailableMs = Number(value);
        break;
      case 'exitOnClosed':
        config.exitOnClosed = value !== 'false' && value !== '0';
        break;
      case 'helpFooter':
        config.helpFooter = value !== 'false' && value !== '0';
        break;
      case 'syncWindowSize':
        config.syncWindowSize = value !== 'false' && value !== '0';
        break;
      default:
        break;
    }
  }

  if (!config.session.trim() && !config.binding.trim()) {
    throw new Error('Missing required --session=<sessionId|sessionName> or --binding=<bindingKey>');
  }

  const numericEntries: Array<[keyof ViewerCliConfig, number, (value: number) => boolean]> = [
    ['port', config.port, value => Number.isInteger(value) && value > 0 && value <= 65535],
    ['intervalMs', config.intervalMs, value => Number.isInteger(value) && value > 0],
    ['leftChars', config.leftChars, value => Number.isInteger(value) && value > 0],
    ['rightEvents', config.rightEvents, value => Number.isInteger(value) && value > 0],
    ['exitOnUnavailableMs', config.exitOnUnavailableMs, value => Number.isInteger(value) && value >= 0],
  ];

  for (const [field, value, validator] of numericEntries) {
    if (!validator(value)) {
      throw new Error(`Invalid --${field}`);
    }
  }

  if (config.actor.trim().length === 0 || config.actor.trim().length > 40) {
    throw new Error('Invalid --actor');
  }

  config.actor = config.actor.trim();
  return config;
}

function targetLabel(config: ViewerCliConfig) {
  return config.binding.trim() ? config.binding.trim() : config.session.trim();
}

function attachBasePath(config: ViewerCliConfig) {
  const encoded = encodeURIComponent(targetLabel(config));
  return config.binding.trim()
    ? `/api/attach/binding/${encoded}`
    : `/api/attach/session/${encoded}`;
}

function attachUrl(config: ViewerCliConfig, suffix = '') {
  return new URL(`${attachBasePath(config)}${suffix}`, `http://${config.host}:${config.port}`);
}

async function fetchAttachPayload(
  config: ViewerCliConfig,
  state: {
    eventSeq?: number;
    outputOffset?: number;
  },
  waitMs: number,
) {
  const url = attachUrl(config);
  url.searchParams.set('maxChars', String(config.leftChars));
  url.searchParams.set('maxEvents', String(config.rightEvents));
  url.searchParams.set('waitMs', String(waitMs));
  if (typeof state.outputOffset === 'number') {
    url.searchParams.set('outputOffset', String(state.outputOffset));
  }
  if (typeof state.eventSeq === 'number') {
    url.searchParams.set('eventSeq', String(state.eventSeq));
  }

  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  return response.json() as Promise<AttachPayload>;
}

async function postAttachJson(config: ViewerCliConfig, suffix: '/input' | '/resize', payload: Record<string, unknown>) {
  const response = await fetch(attachUrl(config, suffix), {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
}

function summarizeEvent(event: AttachEvent) {
  const compact = event.text.replace(/\s+/g, ' ').trim();
  const clipped = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;

  if (event.type === 'input') {
    return `[${event.actor || 'agent'}] ${clipped || '<newline>'}`;
  }

  if (event.type === 'control') {
    return `[${event.actor || 'agent'}] <${clipped}>`;
  }

  return `[session] ${clipped}`;
}

function setWindowTitle(title: string) {
  const safeTitle = title.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 240);
  process.title = safeTitle;

  if (process.stdout.isTTY) {
    process.stdout.write(`\u001b]0;${safeTitle}\u0007`);
  }
}

function sessionTitle(payload: AttachPayload) {
  const summary = payload.summary;
  if (!summary) {
    return payload.bindingKey || 'ssh-session';
  }

  const name = summary.sessionName || summary.sessionId || 'session';
  const host = summary.host || 'unknown-host';
  const port = typeof summary.port === 'number' ? summary.port : 22;
  const user = summary.user || 'unknown-user';
  return `SSH ${name} ${user}@${host}:${port}`;
}

function clearOnce() {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

function clipDisplayText(text: string, maxChars: number) {
  const chars = [...text];
  if (chars.length <= maxChars) {
    return text;
  }

  if (maxChars <= 1) {
    return chars.slice(0, maxChars).join('');
  }

  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function normalizeNewlines(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeTransportData(value: string) {
  return value.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
}

function buildWriteRecords(rawData: string, actor: string, state: LocalInputState) {
  const records: PendingWriteRecord[] = [];

  if (rawData === '\u0003') {
    state.currentLine = '';
    records.push({ actor, text: 'ctrl_c', type: 'control' });
    return records;
  }

  if (rawData === '\u0004') {
    records.push({ actor, text: 'ctrl_d', type: 'control' });
    return records;
  }

  if (rawData.includes('\u001b')) {
    return records;
  }

  const normalized = normalizeNewlines(rawData);
  for (const character of normalized) {
    if (character === '\n') {
      records.push({
        actor,
        text: state.currentLine.length > 0 ? state.currentLine : '<newline>',
        type: 'input',
      });
      state.currentLine = '';
      continue;
    }

    if (character === '\u007f' || character === '\b') {
      state.currentLine = state.currentLine.slice(0, -1);
      continue;
    }

    if (character === '\t') {
      state.currentLine += '\t';
      continue;
    }

    if (character >= ' ') {
      state.currentLine += character;
    }
  }

  return records;
}

function shouldUseStatusBar(config: ViewerCliConfig) {
  return config.statusBar && process.stdout.isTTY;
}

function currentTerminalSize(config: ViewerCliConfig) {
  const cols = Number.isInteger(process.stdout.columns) && (process.stdout.columns || 0) > 0 ? process.stdout.columns! : 120;
  const rows = Number.isInteger(process.stdout.rows) && (process.stdout.rows || 0) > 0 ? process.stdout.rows! : 40;
  const reserveStatusRow = shouldUseStatusBar(config) && rows >= 4;
  const remoteRows = reserveStatusRow ? rows - 1 : rows;
  return {
    cols,
    rows,
    remoteRows: Math.max(2, remoteRows),
    statusRow: reserveStatusRow ? rows : undefined,
  };
}

function applyLocalLayout(config: ViewerCliConfig) {
  if (!shouldUseStatusBar(config)) {
    return;
  }

  const { rows, statusRow } = currentTerminalSize(config);
  if (!statusRow || rows < 2) {
    return;
  }

  process.stdout.write(`\x1b[1;${rows - 1}r`);
}

function enterAttachScreen(config: ViewerCliConfig) {
  if (shouldUseStatusBar(config)) {
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    applyLocalLayout(config);
    return;
  }

  clearOnce();
}

function leaveAttachScreen(config: ViewerCliConfig) {
  if (shouldUseStatusBar(config)) {
    process.stdout.write('\x1b[r\x1b[?1049l');
  }
}

function statusBarTheme(event: AttachEvent | undefined, summary: string) {
  if (event?.actor === 'user') {
    return '\x1b[48;5;25m\x1b[38;5;255m';
  }

  if (event?.actor === 'codex') {
    return '\x1b[48;5;208m\x1b[38;5;16m';
  }

  if (event?.actor === 'claude') {
    return '\x1b[48;5;98m\x1b[38;5;255m';
  }

  if (summary.startsWith('[attach] error')) {
    return '\x1b[48;5;160m\x1b[38;5;255m';
  }

  return '\x1b[48;5;238m\x1b[38;5;255m';
}

function renderStatusBar(
  config: ViewerCliConfig,
  state: {
    lastEvent?: AttachEvent;
    lastEventSummary: string;
  },
  fallbackText: string,
) {
  if (!shouldUseStatusBar(config)) {
    return;
  }

  const { cols, statusRow } = currentTerminalSize(config);
  if (!statusRow) {
    return;
  }

  applyLocalLayout(config);
  const summary = state.lastEventSummary || fallbackText;
  const text = clipDisplayText(summary, Math.max(1, cols));
  const theme = statusBarTheme(state.lastEvent, summary);
  const padded = text.padEnd(cols, ' ');
  process.stdout.write(`\x1b7\x1b[${statusRow};1H\x1b[2K${theme}${padded}\x1b[0m\x1b8`);
}

function formatStatusEvent(event: AttachEvent | undefined, fallback: string) {
  if (!event) {
    return fallback;
  }

  const time = event.at.slice(11, 19);
  return `${time} ${summarizeEvent(event)}`;
}

async function main() {
  const config = parseArgv(process.argv.slice(2));
  const attachState: {
    currentLine: string;
    eventSeq?: number;
    lastEvent?: AttachEvent;
    lastEventSummary: string;
    outputOffset?: number;
    titleBase: string;
  } = {
    currentLine: '',
    eventSeq: undefined,
    lastEvent: undefined,
    lastEventSummary: '',
    outputOffset: undefined,
    titleBase: targetLabel(config),
  };

  let initialized = false;
  let unavailableSince: number | undefined;
  let closedSince: number | undefined;
  let lastError = '';
  let stopping = false;
  let resizeTimer: NodeJS.Timeout | undefined;
  let writeQueue = Promise.resolve();

  const cleanupAndExit = (code: number) => {
    if (stopping) return;
    stopping = true;
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = undefined;
    }

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }

    leaveAttachScreen(config);
    process.stdout.write('\n[attach] detached\n');
    process.exit(code);
  };

  const queueWrite = (payload: Record<string, unknown>) => {
    writeQueue = writeQueue
      .then(() => postAttachJson(config, '/input', payload))
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) {
          process.stderr.write(`\n[attach] input error: ${message}\n`);
          lastError = message;
        }
      });
  };

  const queueResize = () => {
    if (!config.syncWindowSize) {
      return;
    }

    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      const { cols, remoteRows } = currentTerminalSize(config);
      if (shouldUseStatusBar(config)) {
        renderStatusBar(config, attachState, '[attach] resize pending');
      }
      writeQueue = writeQueue
        .then(() => postAttachJson(config, '/resize', { cols, rows: remoteRows }))
        .catch(() => {
          // ignore resize failures; the polling loop will surface connection errors if needed
        })
        .finally(() => {
          renderStatusBar(config, attachState, '[attach] connected');
        });
    }, 80);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', chunk => {
      const rawData = chunk.toString('utf8');
      if (rawData === '\u001d') {
        cleanupAndExit(0);
        return;
      }

      const records = buildWriteRecords(rawData, config.actor, attachState);
      queueWrite({
        data: normalizeTransportData(rawData),
        records,
      });
    });
  }

  if (process.stdout.isTTY) {
    process.stdout.on('resize', queueResize);
  }

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('exit', () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }

    leaveAttachScreen(config);
  });

  enterAttachScreen(config);
  if (config.helpFooter) {
    process.stdout.write('[attach] shared SSH terminal ready. Ctrl+] detaches this window. Input source is shown in the window title and local status bar.\n\n');
  }

  renderStatusBar(config, attachState, `[attach] connected as ${config.actor}; Ctrl+] detaches`);

  queueResize();

  for (;;) {
    try {
      const payload = await fetchAttachPayload(config, {
        outputOffset: attachState.outputOffset,
        eventSeq: attachState.eventSeq,
      }, initialized ? config.intervalMs : 0);
      initialized = true;
      unavailableSince = undefined;
      lastError = '';

      if (!attachState.titleBase || attachState.titleBase === targetLabel(config)) {
        attachState.titleBase = sessionTitle(payload);
      }

      if (payload.output.length > 0) {
        process.stdout.write(payload.output);
      }

      if (payload.events.length > 0) {
        const latestEvent = payload.events[payload.events.length - 1];
        attachState.lastEvent = latestEvent;
        attachState.lastEventSummary = formatStatusEvent(latestEvent, attachState.lastEventSummary);
      }

      setWindowTitle(
        attachState.lastEventSummary
          ? `${attachState.titleBase} | ${attachState.lastEventSummary}`
          : attachState.titleBase,
      );

      renderStatusBar(config, attachState, `[attach] connected as ${config.actor}; Ctrl+] detaches`);

      attachState.outputOffset = payload.nextOutputOffset;
      attachState.eventSeq = payload.nextEventSeq;

      const closed = payload.summary?.closed === true;
      if (closed) {
        if (closedSince === undefined) {
          closedSince = Date.now();
        } else if (config.exitOnClosed && Date.now() - closedSince >= Math.min(config.intervalMs * 2, 1500)) {
          cleanupAndExit(0);
        }
      } else {
        closedSince = undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        process.stderr.write(`\n[attach] ${message}\n`);
        lastError = message;
      }

      renderStatusBar(config, attachState, `[attach] error: ${message}`);

      if (unavailableSince === undefined) {
        unavailableSince = Date.now();
      } else if (config.exitOnUnavailableMs > 0 && Date.now() - unavailableSince >= config.exitOnUnavailableMs) {
        cleanupAndExit(0);
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(config.intervalMs, 500)));
    }
  }
}

main().catch(error => {
  console.error('[attach] fatal:', error);
  process.exit(1);
});
