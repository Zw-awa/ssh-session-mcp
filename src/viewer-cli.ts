#!/usr/bin/env node

interface ViewerCliConfig {
  host: string;
  port: number;
  session: string;
  binding: string;
  intervalMs: number;
  width: number;
  height: number;
  leftChars: number;
  rightEvents: number;
  stripAnsiFromLeft: boolean;
  exitOnUnavailableMs: number;
  exitOnClosed: boolean;
  helpFooter: boolean;
}

function parseArgv(argv: string[]): ViewerCliConfig {
  const defaults: ViewerCliConfig = {
    host: '127.0.0.1',
    port: 8765,
    session: '',
    binding: '',
    intervalMs: 1000,
    width: 160,
    height: 28,
    leftChars: 12000,
    rightEvents: 40,
    stripAnsiFromLeft: true,
    exitOnUnavailableMs: 3000,
    exitOnClosed: true,
    helpFooter: true,
  };

  const config = { ...defaults };

  for (const rawArg of argv) {
    if (!rawArg.startsWith('--')) continue;
    const equalIndex = rawArg.indexOf('=');
    const key = equalIndex === -1 ? rawArg.slice(2) : rawArg.slice(2, equalIndex);
    const value = equalIndex === -1 ? '' : rawArg.slice(equalIndex + 1);

    switch (key) {
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
      case 'width':
        config.width = Number(value);
        break;
      case 'height':
        config.height = Number(value);
        break;
      case 'leftChars':
        config.leftChars = Number(value);
        break;
      case 'rightEvents':
        config.rightEvents = Number(value);
        break;
      case 'stripAnsiFromLeft':
        config.stripAnsiFromLeft = value !== 'false' && value !== '0';
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
    ['width', config.width, value => Number.isInteger(value) && value > 0],
    ['height', config.height, value => Number.isInteger(value) && value > 0],
    ['leftChars', config.leftChars, value => Number.isInteger(value) && value > 0],
    ['rightEvents', config.rightEvents, value => Number.isInteger(value) && value > 0],
    ['exitOnUnavailableMs', config.exitOnUnavailableMs, value => Number.isInteger(value) && value >= 0],
  ];

  for (const [field, value, validator] of numericEntries) {
    if (!validator(value)) {
      throw new Error(`Invalid --${field}`);
    }
  }

  return config;
}

function clearScreen() {
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[3J\x1b[H');
}

function restoreCursor() {
  process.stdout.write('\x1b[?25h');
}

async function fetchDashboard(config: ViewerCliConfig) {
  const path = config.binding.trim()
    ? `/api/viewer-binding/${encodeURIComponent(config.binding)}`
    : `/api/session/${encodeURIComponent(config.session)}`;
  const url = new URL(path, `http://${config.host}:${config.port}`);
  url.searchParams.set('width', String(config.width));
  url.searchParams.set('height', String(config.height));
  url.searchParams.set('leftChars', String(config.leftChars));
  url.searchParams.set('rightEvents', String(config.rightEvents));
  url.searchParams.set('stripAnsiFromLeft', String(config.stripAnsiFromLeft));

  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  return response.json() as Promise<{
    dashboard: string;
    summary?: {
      sessionName?: string;
      sessionId?: string;
      closed?: boolean;
    };
  }>;
}

async function main() {
  const config = parseArgv(process.argv.slice(2));
  let lastRendered = '';
  let lastClosed = false;
  let lastError = '';
  let unavailableSince: number | undefined;
  let closedSince: number | undefined;
  let stopping = false;

  const cleanupAndExit = (code: number) => {
    if (stopping) return;
    stopping = true;
    restoreCursor();
    process.stdout.write('\n');
    process.exit(code);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (text === '\u0003' || text.toLowerCase() === 'q') {
        cleanupAndExit(0);
      }
    });
  }

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('exit', () => {
    restoreCursor();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
  });

  for (;;) {
    try {
      const payload = await fetchDashboard(config);
      const closed = payload.summary?.closed === true;
      unavailableSince = undefined;
      const footerLines = [];
      if (config.helpFooter) {
        footerLines.push('[viewer] read-only window; press q or Ctrl+C to exit.');
      }
      if (closed) {
        footerLines.push(config.exitOnClosed
          ? '[viewer] session is closed; leaving viewer shortly.'
          : '[viewer] session is closed; press q or Ctrl+C to exit.');
      }
      const footer = footerLines.length > 0 ? `\n\n${footerLines.join('\n')}\n` : '\n';
      const nextRendered = `${payload.dashboard}${footer}`;

      if (nextRendered !== lastRendered || closed !== lastClosed) {
        clearScreen();
        process.stdout.write(nextRendered);
        lastRendered = nextRendered;
        lastClosed = closed;
      }
      lastError = '';

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
      const message = `[viewer] ${error instanceof Error ? error.message : String(error)}\n`;
      if (message !== lastError) {
        clearScreen();
        process.stdout.write(message);
        lastError = message;
        lastRendered = '';
        lastClosed = false;
      }

      if (unavailableSince === undefined) {
        unavailableSince = Date.now();
      } else if (config.exitOnUnavailableMs > 0 && Date.now() - unavailableSince >= config.exitOnUnavailableMs) {
        cleanupAndExit(0);
      }
    }

    await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

main().catch(error => {
  console.error('[viewer] fatal:', error);
  process.exit(1);
});
