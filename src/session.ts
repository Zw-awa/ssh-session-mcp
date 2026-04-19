import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import {
  createBufferSnapshot,
  createEventSnapshot,
  getControlSequence,
  normalizeTerminalInput,
  nowIso,
  optionalIso,
  type BufferSnapshot,
  type ControlKey,
  type EventSnapshot,
  type TranscriptEvent,
  type TranscriptEventType,
} from './shared.js';

export interface SSHConfig extends ConnectConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface SessionTuning {
  maxBufferChars: number;
  defaultReadChars: number;
  maxTranscriptEvents: number;
  maxTranscriptChars: number;
  maxTranscriptEventChars: number;
  defaultDashboardRightEvents: number;
  defaultDashboardLeftChars: number;
}

export interface SessionSummary {
  sessionId: string;
  sessionName?: string;
  host: string;
  port: number;
  user: string;
  cols: number;
  rows: number;
  term: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleTimeoutMs: number;
  idleExpiresAt?: string;
  closed: boolean;
  closedAt?: string;
  closeReason?: string;
  retainedUntil?: string;
  bufferStart: number;
  bufferEnd: number;
  eventStartSeq: number;
  eventEndSeq: number;
  inputLock: 'none' | 'agent' | 'user';
}

export interface SessionWriteRecord {
  actor: string;
  text: string;
  type: Extract<TranscriptEventType, 'input' | 'control'>;
}

interface ChangeWaiter {
  outputOffset?: number;
  eventSeq?: number;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class SSHConnection {
  private conn: Client | null = null;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;

  constructor(
    private readonly sshConfig: SSHConfig,
    private readonly connectTimeoutMs: number,
  ) {}

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) return;
    if (this.isConnecting && this.connectionPromise) return this.connectionPromise;

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        try {
          this.conn?.end();
        } catch {
          // ignore
        }
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, 'SSH connection timeout'));
      }, this.connectTimeoutMs);

      this.conn.on('ready', () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('close', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.connect(this.sshConfig);
    });

    return this.connectionPromise;
  }

  isConnected(): boolean {
    return this.conn !== null && (this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
  }

  getClient(): Client {
    if (!this.conn) {
      throw new McpError(ErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
  }

  close(): void {
    if (!this.conn) return;
    const active = this.conn;
    this.conn = null;

    try {
      active.end();
    } catch {
      // ignore
    }

    try {
      (active as any).destroy?.();
    } catch {
      // ignore
    }
  }
}

export class SSHSession {
  public readonly createdAt = nowIso();
  public updatedAt = this.createdAt;
  public lastActivityAt = this.createdAt;
  public closedAt: string | undefined;
  public closeReason: string | undefined;
  public buffer = '';
  public bufferStart = 0;
  public rawBuffer = '';
  public rawBufferStart = 0;
  public closed = false;
  public inputLock: 'none' | 'agent' | 'user' = 'none';

  private eventSeqStart = 0;
  private nextEventSeq = 0;
  private transcriptCharCount = 0;
  private readonly events: TranscriptEvent[] = [];
  private readonly waiters = new Set<ChangeWaiter>();
  private readonly rawOutputListeners = new Set<(chunk: Buffer) => void>();
  private readonly eventListeners = new Set<(event: TranscriptEvent) => void>();
  private lastActivityMs = Date.now();

  constructor(
    public readonly sessionId: string,
    public readonly sessionName: string | undefined,
    public readonly host: string,
    public readonly port: number,
    public readonly user: string,
    public cols: number,
    public rows: number,
    public readonly term: string,
    public readonly idleTimeoutMs: number,
    public readonly closedRetentionMs: number,
    private readonly tuning: SessionTuning,
    private readonly connection: SSHConnection,
    private readonly stream: ClientChannel,
  ) {
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const text = buf.toString();
      this.appendOutput(text, buf);
    };

    stream.on('data', onData);

    const stderr = (stream as any).stderr;
    if (stderr?.on) {
      stderr.on('data', onData);
    }

    stream.on('close', (code?: number, signal?: string) => {
      const detail = `channel closed${typeof code === 'number' ? ` code=${code}` : ''}${signal ? ` signal=${signal}` : ''}`;
      this.finalize(detail, { closeStream: false });
    });

    stream.on('error', (err: Error) => {
      this.finalize(`channel error: ${err.message}`, { closeStream: false });
    });

    this.pushEvent('lifecycle', `session opened: ${this.user}@${this.host}:${this.port} (${this.term} ${this.cols}x${this.rows})`, undefined, this.createdAt, false);
  }

  private markUpdated(at: string, countAsActivity: boolean) {
    this.updatedAt = at;
    if (countAsActivity) {
      this.lastActivityAt = at;
      this.lastActivityMs = Date.parse(at);
    }
  }

  private hasRequestedChange(outputOffset?: number, eventSeq?: number): boolean {
    if (typeof outputOffset === 'number' && (this.currentBufferEnd() > outputOffset || this.closed)) {
      return true;
    }

    if (typeof eventSeq === 'number' && (this.currentEventEnd() > eventSeq || this.closed)) {
      return true;
    }

    return false;
  }

  private flushWaiters() {
    for (const waiter of [...this.waiters]) {
      if (!this.hasRequestedChange(waiter.outputOffset, waiter.eventSeq)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  private clipEventText(text: string): string {
    if (text.length <= this.tuning.maxTranscriptEventChars) {
      return text;
    }
    const dropped = text.length - this.tuning.maxTranscriptEventChars;
    return `[chunk truncated ${dropped} chars]\n${text.slice(-this.tuning.maxTranscriptEventChars)}`;
  }

  private trimTranscriptEvents() {
    while (this.events.length > this.tuning.maxTranscriptEvents || this.transcriptCharCount > this.tuning.maxTranscriptChars) {
      const removed = this.events.shift();
      if (!removed) break;
      this.transcriptCharCount -= removed.text.length;
    }
    this.eventSeqStart = this.events[0]?.seq ?? this.nextEventSeq;
  }

  private pushEvent(
    type: TranscriptEventType,
    text: string,
    actor: string | undefined,
    at = nowIso(),
    countAsActivity = true,
  ) {
    const clipped = this.clipEventText(text);
    const event: TranscriptEvent = {
      seq: this.nextEventSeq,
      at,
      type,
      text: clipped,
      actor,
    };
    this.events.push(event);
    this.nextEventSeq += 1;
    this.transcriptCharCount += clipped.length;
    this.trimTranscriptEvents();
    this.markUpdated(at, countAsActivity);
    this.flushWaiters();

    if (type !== 'output') {
      for (const listener of this.eventListeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    }
  }

  private appendOutput(text: string, rawChunk?: Buffer) {
    if (text.length === 0) return;

    this.buffer += text;
    if (this.buffer.length > this.tuning.maxBufferChars) {
      const trimChars = this.buffer.length - this.tuning.maxBufferChars;
      this.buffer = this.buffer.slice(trimChars);
      this.bufferStart += trimChars;
    }

    this.rawBuffer += text;
    if (this.rawBuffer.length > this.tuning.maxBufferChars) {
      const trimChars = this.rawBuffer.length - this.tuning.maxBufferChars;
      this.rawBuffer = this.rawBuffer.slice(trimChars);
      this.rawBufferStart += trimChars;
    }

    const buf = rawChunk || Buffer.from(text);
    for (const listener of this.rawOutputListeners) {
      try { listener(buf); } catch { /* ignore */ }
    }

    this.pushEvent('output', text, undefined, nowIso(), true);
  }

  currentBufferEnd(): number {
    return this.bufferStart + this.buffer.length;
  }

  currentRawBufferEnd(): number {
    return this.rawBufferStart + this.rawBuffer.length;
  }

  currentEventEnd(): number {
    return this.nextEventSeq;
  }

  read(offset: number | undefined, maxChars: number): BufferSnapshot {
    return createBufferSnapshot(this.bufferStart, this.buffer, offset, maxChars, this.tuning.defaultReadChars);
  }

  readRaw(offset: number | undefined, maxChars: number): BufferSnapshot {
    return createBufferSnapshot(this.rawBufferStart, this.rawBuffer, offset, maxChars, this.tuning.defaultReadChars);
  }

  onRawOutput(listener: (chunk: Buffer) => void): () => void {
    this.rawOutputListeners.add(listener);
    return () => { this.rawOutputListeners.delete(listener); };
  }

  onEvent(listener: (event: TranscriptEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  readEvents(eventSeq: number | undefined, maxEvents: number, maxViewChars: number): EventSnapshot {
    return createEventSnapshot(
      this.eventSeqStart,
      this.events,
      eventSeq,
      maxEvents,
      maxViewChars,
      this.tuning.defaultDashboardRightEvents,
      this.tuning.defaultDashboardLeftChars,
    );
  }

  getConversationEvents(maxEvents: number): TranscriptEvent[] {
    return this.events
      .filter(event => event.type !== 'output')
      .slice(-Math.max(1, maxEvents));
  }

  async waitForChange(options: { outputOffset?: number; eventSeq?: number; waitMs: number }): Promise<void> {
    const { outputOffset, eventSeq, waitMs } = options;
    if (waitMs <= 0) return;
    if (typeof outputOffset !== 'number' && typeof eventSeq !== 'number') return;
    if (this.hasRequestedChange(outputOffset, eventSeq)) return;

    await new Promise<void>(resolve => {
      let waiter!: ChangeWaiter;
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, waitMs);

      waiter = {
        outputOffset,
        eventSeq,
        resolve,
        timer,
      };

      this.waiters.add(waiter);
    });
  }

  writeRaw(data: string, records: SessionWriteRecord[] = []) {
    if (this.closed) {
      throw new McpError(ErrorCode.InvalidParams, `Session is closed: ${this.closeReason || this.sessionId}`);
    }

    this.stream.write(data);
    const at = nowIso();

    if (records.length > 0) {
      for (const record of records) {
        this.pushEvent(record.type, record.text, record.actor, at, true);
      }
      return;
    }

    this.markUpdated(at, true);
  }

  write(input: string, actor: string) {
    this.writeRaw(normalizeTerminalInput(input), [
      { actor, text: input, type: 'input' },
    ]);
  }

  sendControl(control: ControlKey, actor: string) {
    this.writeRaw(getControlSequence(control), [
      { actor, text: control, type: 'control' },
    ]);
  }

  resize(cols: number, rows: number) {
    if (this.closed) {
      throw new McpError(ErrorCode.InvalidParams, `Session is closed: ${this.closeReason || this.sessionId}`);
    }

    const channel = this.stream as any;
    if (typeof channel.setWindow === 'function') {
      channel.setWindow(rows, cols, 480, 640);
    }

    this.cols = cols;
    this.rows = rows;
    this.pushEvent('lifecycle', `terminal resized: ${cols}x${rows}`, undefined, nowIso(), true);
  }

  finalize(reason: string, options: { closeStream?: boolean } = {}) {
    if (this.closed) return;

    const at = nowIso();
    this.closed = true;
    this.closedAt = at;
    this.closeReason = reason;
    this.pushEvent('lifecycle', reason, undefined, at, false);

    if (options.closeStream !== false) {
      try {
        this.stream.end();
      } catch {
        // ignore
      }
    }

    this.connection.close();
    this.flushWaiters();
  }

  close(reason = 'closed by client') {
    this.finalize(reason);
  }

  shouldCloseForIdle(nowMs: number): boolean {
    return !this.closed && this.idleTimeoutMs > 0 && nowMs - this.lastActivityMs >= this.idleTimeoutMs;
  }

  shouldPrune(nowMs: number): boolean {
    if (!this.closed || !this.closedAt) return false;
    return nowMs - Date.parse(this.closedAt) >= this.closedRetentionMs;
  }

  summary(): SessionSummary {
    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      host: this.host,
      port: this.port,
      user: this.user,
      cols: this.cols,
      rows: this.rows,
      term: this.term,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastActivityAt: this.lastActivityAt,
      idleTimeoutMs: this.idleTimeoutMs,
      idleExpiresAt: !this.closed && this.idleTimeoutMs > 0 ? optionalIso(this.lastActivityMs + this.idleTimeoutMs) : undefined,
      closed: this.closed,
      closedAt: this.closedAt,
      closeReason: this.closeReason,
      retainedUntil: this.closed && this.closedAt ? optionalIso(Date.parse(this.closedAt) + this.closedRetentionMs) : undefined,
      bufferStart: this.bufferStart,
      bufferEnd: this.currentBufferEnd(),
      eventStartSeq: this.eventSeqStart,
      eventEndSeq: this.currentEventEnd(),
      inputLock: this.inputLock,
    };
  }
}
