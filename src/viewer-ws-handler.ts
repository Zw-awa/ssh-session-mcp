import { WebSocket } from 'ws';

import type { ControlKey } from './shared.js';
import {
  viewerWss,
  viewerClientSessions,
  resolveAttachTarget,
  sanitizeActor,
  sanitizePositiveInt,
  logSessionEvent,
  logServerEvent,
  broadcastLock,
  OPERATION_MODE,
  setOperationMode,
  type OperationMode,
  type SessionWriteRecord,
  SSHSession,
} from './server-state.js';
import type { ViewerAttachKind } from './viewer-routes.js';

const CONTROL_KEYS: Record<ControlKey, true> = {
  ctrl_c: true,
  ctrl_d: true,
  enter: true,
  tab: true,
  esc: true,
  up: true,
  down: true,
  left: true,
  right: true,
  backspace: true,
};

function isControlKey(value: string): value is ControlKey {
  return Object.hasOwn(CONTROL_KEYS, value);
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

function sendInitPayload(ws: WebSocket, session: SSHSession, bindingKey: string | undefined) {
  ws.send(JSON.stringify({
    type: 'init',
    summary: session.summary(),
    bindingKey,
    rawBufferEnd: session.currentRawBufferEnd(),
  }));
}

function replayRawBuffer(ws: WebSocket, session: SSHSession, rawOffset?: number) {
  const currentRawEnd = session.currentRawBufferEnd();

  if (typeof rawOffset === 'number' && rawOffset >= session.rawBufferStart && rawOffset < currentRawEnd) {
    const slice = session.rawBuffer.slice(rawOffset - session.rawBufferStart);
    if (slice.length > 0) {
      ws.send(Buffer.from(slice), { binary: true });
    }
    return;
  }

  if (typeof rawOffset !== 'number' || rawOffset < session.rawBufferStart) {
    if (session.rawBuffer.length > 0) {
      ws.send(Buffer.from(session.rawBuffer), { binary: true });
    }
  }
}

function replayRecentEvents(ws: WebSocket, session: SSHSession) {
  const recentEvents = session.getConversationEvents(50);
  for (const event of recentEvents) {
    ws.send(JSON.stringify({
      type: 'event',
      seq: event.seq,
      at: event.at,
      eventType: event.type,
      text: event.text,
      actor: event.actor,
    }));
  }
}

function broadcastModeChange(sessionId: string) {
  if (!viewerWss) {
    return;
  }

  const modeMsg = JSON.stringify({ type: 'mode', mode: OPERATION_MODE });
  for (const client of viewerWss.clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }
    try {
      client.send(modeMsg);
    } catch {
      // ignore per-client send failures
    }
  }

  logServerEvent('operation_mode.changed', { mode: OPERATION_MODE, sessionId });
}

function sendLockRejected(ws: WebSocket, lock: 'none' | 'agent' | 'user', message: string) {
  ws.send(JSON.stringify({
    type: 'lock_rejected',
    lock,
    message,
  }));
}

function collectInputRecords(rawRecords: unknown): SessionWriteRecord[] {
  const records: SessionWriteRecord[] = [];
  if (!Array.isArray(rawRecords)) {
    return records;
  }

  for (const value of rawRecords) {
    if (!isSessionWriteRecordCandidate(value)) {
      continue;
    }

    records.push({
      actor: sanitizeActor(value.actor, 'user'),
      text: value.text,
      type: value.type,
    });
  }

  return records;
}

function handleViewerSocketMessage(ws: WebSocket, session: SSHSession, data: WebSocket.RawData, isBinary: boolean) {
  if (isBinary) {
    return;
  }

  try {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'lock' && typeof msg.lock === 'string') {
      const validLocks = ['none', 'agent', 'user'];
      if (validLocks.includes(msg.lock)) {
        session.inputLock = msg.lock as 'none' | 'agent' | 'user';
        broadcastLock(session);
      }
      return;
    }

    if (msg.type === 'mode' && typeof msg.mode === 'string') {
      const validModes = ['safe', 'full'];
      if (validModes.includes(msg.mode)) {
        setOperationMode(msg.mode as OperationMode);
        broadcastModeChange(session.sessionId);
      }
      return;
    }

    if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length > 0) {
      if (session.inputLock === 'agent') {
        sendLockRejected(ws, session.inputLock, 'Input locked by AI agent. Switch to "common" or "user" mode to type.');
        return;
      }

      const records = collectInputRecords(msg.records);
      session.writeRaw(msg.data, records);
      logSessionEvent(session.sessionId, 'session.input', {
        actor: records[0]?.actor || 'user',
        sentChars: msg.data.length,
      });
      return;
    }

    if (msg.type === 'control' && typeof msg.key === 'string') {
      if (session.inputLock === 'agent') {
        sendLockRejected(ws, session.inputLock, 'Input locked by AI agent.');
        return;
      }
      if (!isControlKey(msg.key)) {
        return;
      }
      const actor = sanitizeActor(msg.actor, 'user');
      session.sendControl(msg.key, actor);
      logSessionEvent(session.sessionId, 'session.control', {
        actor,
        control: msg.key,
      });
      return;
    }

    if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      session.resize(
        sanitizePositiveInt(msg.cols, 'cols', session.cols),
        sanitizePositiveInt(msg.rows, 'rows', session.rows),
      );
    }
  } catch {
    // ignore invalid viewer websocket messages
  }
}

export function handleWsAttach(ws: WebSocket, kind: ViewerAttachKind, ref: string, rawOffset?: number) {
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

  viewerClientSessions.set(ws, session.sessionId);

  sendInitPayload(ws, session, bindingKey);
  replayRawBuffer(ws, session, rawOffset);
  replayRecentEvents(ws, session);

  const unsubOutput = session.onRawOutput((chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  const unsubEvent = session.onEvent((event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'event',
        seq: event.seq,
        at: event.at,
        eventType: event.type,
        text: event.text,
        actor: event.actor,
      }));
    }
  });

  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    handleViewerSocketMessage(ws, session, data, isBinary);
  };
  ws.on('message', onMessage);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    ws.off('message', onMessage);
    ws.off('close', cleanup);
    ws.off('error', cleanup);
    viewerClientSessions.delete(ws);
    unsubOutput();
    unsubEvent();
  };

  ws.once('close', cleanup);
  ws.once('error', cleanup);
}
