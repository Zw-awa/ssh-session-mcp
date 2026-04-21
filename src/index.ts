#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  loadDotEnv,
  isCliEnabled,
  server,
  viewerServer,
  viewerWss,
  sweepSessions,
  closeAllSessions,
  loadViewerProcessState,
  removeServerInfoState,
  logServerEvent,
  DEFAULT_IDLE_SWEEP_MS,
  WebSocket,
} from './server-state.js';

import { startViewerServer } from './viewer-server.js';
import { registerTools } from './tools.js';

// ── .env bootstrap ───────────────────────────────────────────────────────────

loadDotEnv();

// ── Register MCP tools ───────────────────────────────────────────────────────

registerTools();

// ── Main ─────────────────────────────────────────────────────────────────────

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

// ── Re-exports for tests ────────────────────────────────────────────────────

export { buildSentinelCommandSuffix, parseArgv, stripSentinelFromOutput, validateConfig } from './server-state.js';
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
