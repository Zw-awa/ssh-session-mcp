#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
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
  LOCAL_MODE,
  actualViewerPort,
  sessions,
  setActiveSession,
  getViewerBaseUrl,
  tuning,
  buildSessionMetadata,
  openSSHSession,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_TERM,
  DEFAULT_TIMEOUT,
  DEFAULT_CLOSED_RETENTION_MS,
  delay,
  WebSocket,
} from './server-state.js';

import { startViewerServer } from './viewer-server.js';
import { registerTools } from './tools.js';

// ── Register MCP tools ───────────────────────────────────────────────────────

registerTools();

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await loadViewerProcessState();
  await startViewerServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ── Local debug mode: auto-create a session so the user can test immediately ──
  if (LOCAL_MODE) {
    try {
      const sessionId = crypto.randomUUID();
      const nm = 'local-' + sessionId.slice(0, 8);
      const metadata = buildSessionMetadata({
        profileSource: 'manual',
        sessionId,
        sessionName: nm,
      });
      const session = await openSSHSession({
        cols: DEFAULT_COLS,
        closedRetentionMs: DEFAULT_CLOSED_RETENTION_MS,
        host: 'localhost',
        idleTimeoutMs: DEFAULT_TIMEOUT,
        metadata,
        port: 0,
        rows: DEFAULT_ROWS,
        sessionId,
        sessionName: nm,
        term: DEFAULT_TERM,
        user: process.env.USER || process.env.USERNAME || 'local',
      });
      sessions.set(sessionId, session);
      setActiveSession(session);

      // Warm up the local shell so the terminal shows output immediately.
      // cmd.exe in pipe mode doesn't print a prompt or echo by default;
      // sending a visible command proves the input/output chain works.
      const isWin = process.platform === 'win32';
      await delay(800);
      session.write(
        isWin ? 'echo === Local shell ready. Type commands below. ===\r\n' : 'echo "=== Local shell ready. Type commands below. ==="\n',
        'system',
      );

      logServerEvent('session.opened', {
        sessionId,
        sessionRef: metadata.sessionRef,
        profileSource: 'local',
      });

      const viewerUrl = getViewerBaseUrl();
      if (viewerUrl) {
        const terminalUrl = `${viewerUrl}/terminal/session/${encodeURIComponent(sessionId)}`;
        const homeUrl = viewerUrl;
        console.log(`\n  Local debug session ready.`);
        console.log(`  Terminal:  ${terminalUrl}`);
        console.log(`  Home page: ${homeUrl}\n`);
      }
    } catch (err) {
      console.error('Failed to create local debug session:', err);
    }
  }

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

export {
  appendSentinelToCommand,
  buildSentinelCommandSuffix,
  parseArgv,
  stripSentinelFromOutput,
  validateConfig,
} from './server-state.js';
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
