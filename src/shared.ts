import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function sanitizeRequiredText(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} cannot be empty`);
  }

  return trimmed;
}

export function sanitizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sanitizePort(value: number | undefined, fallback: number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      throw new McpError(ErrorCode.InvalidParams, 'port must be an integer between 1 and 65535');
    }
    return value;
  }
  return fallback;
}

export function sanitizePositiveInt(value: number | undefined, fieldName: string, fallback: number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a positive integer`);
    }
    return value;
  }
  return fallback;
}

export function sanitizeNonNegativeInt(value: number | undefined, fieldName: string, fallback: number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a non-negative integer`);
    }
    return value;
  }
  return fallback;
}

export function sanitizeActor(value: string | undefined, fallback = 'agent'): string {
  const actor = sanitizeOptionalText(value) || fallback;
  if (actor.length > 40) {
    throw new McpError(ErrorCode.InvalidParams, 'actor must be 40 characters or fewer');
  }
  return actor;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeTerminalInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\r');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function optionalIso(ms: number | undefined): string | undefined {
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}

export type ControlKey =
  | 'ctrl_c'
  | 'ctrl_d'
  | 'enter'
  | 'tab'
  | 'esc'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'backspace';

export function getControlSequence(control: ControlKey): string {
  const map: Record<ControlKey, string> = {
    ctrl_c: '\x03',
    ctrl_d: '\x04',
    enter: '\r',
    tab: '\t',
    esc: '\x1b',
    up: '\x1b[A',
    down: '\x1b[B',
    left: '\x1b[D',
    right: '\x1b[C',
    backspace: '\x7f',
  };
  return map[control];
}

export interface BufferSnapshot {
  requestedOffset: number | null;
  effectiveOffset: number;
  nextOffset: number;
  availableStart: number;
  availableEnd: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  output: string;
}

export function createBufferSnapshot(
  bufferStart: number,
  buffer: string,
  offset: number | undefined,
  maxChars: number,
  defaultReadChars: number,
): BufferSnapshot {
  const availableStart = bufferStart;
  const availableEnd = bufferStart + buffer.length;
  const safeMaxChars = maxChars > 0 ? maxChars : defaultReadChars;

  let effectiveOffset: number;
  let truncatedBefore = false;

  if (typeof offset === 'number') {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new McpError(ErrorCode.InvalidParams, 'offset must be a non-negative integer');
    }

    if (offset < availableStart) {
      effectiveOffset = availableStart;
      truncatedBefore = true;
    } else if (offset > availableEnd) {
      effectiveOffset = availableEnd;
    } else {
      effectiveOffset = offset;
    }
  } else {
    effectiveOffset = Math.max(availableStart, availableEnd - safeMaxChars);
    truncatedBefore = effectiveOffset > availableStart;
  }

  const sliceStart = effectiveOffset - availableStart;
  const slice = buffer.slice(sliceStart, sliceStart + safeMaxChars);
  const nextOffset = effectiveOffset + slice.length;

  return {
    requestedOffset: typeof offset === 'number' ? offset : null,
    effectiveOffset,
    nextOffset,
    availableStart,
    availableEnd,
    truncatedBefore,
    truncatedAfter: nextOffset < availableEnd,
    output: slice,
  };
}

export type TranscriptEventType = 'input' | 'output' | 'control' | 'lifecycle';

export interface TranscriptEvent {
  seq: number;
  at: string;
  type: TranscriptEventType;
  text: string;
  actor?: string;
}

export function renderTranscriptEvent(event: TranscriptEvent): string {
  if (event.type === 'output') {
    return event.text;
  }

  if (event.type === 'input') {
    const actor = event.actor || 'agent';
    const payload = event.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd() || '<newline>';
    return `[${actor} ${event.at}]\n${payload}`;
  }

  if (event.type === 'control') {
    const actor = event.actor || 'agent';
    return `[${actor} ${event.at}] <${event.text}>`;
  }

  return `[session ${event.at}] ${event.text}`;
}

export interface EventSnapshot {
  requestedEventSeq: number | null;
  effectiveEventSeq: number;
  nextEventSeq: number;
  availableStartSeq: number;
  availableEndSeq: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  viewTruncatedBefore: boolean;
  events: TranscriptEvent[];
  view: string;
}

export function createEventSnapshot(
  eventStartSeq: number,
  events: TranscriptEvent[],
  eventSeq: number | undefined,
  maxEvents: number,
  maxViewChars: number,
  defaultEventCount: number,
  defaultViewChars: number,
): EventSnapshot {
  const availableStartSeq = eventStartSeq;
  const availableEndSeq = eventStartSeq + events.length;
  const safeMaxEvents = maxEvents > 0 ? maxEvents : defaultEventCount;
  const safeMaxViewChars = maxViewChars > 0 ? maxViewChars : defaultViewChars;

  let effectiveEventSeq: number;
  let truncatedBefore = false;

  if (typeof eventSeq === 'number') {
    if (!Number.isInteger(eventSeq) || eventSeq < 0) {
      throw new McpError(ErrorCode.InvalidParams, 'eventSeq must be a non-negative integer');
    }

    if (eventSeq < availableStartSeq) {
      effectiveEventSeq = availableStartSeq;
      truncatedBefore = true;
    } else if (eventSeq > availableEndSeq) {
      effectiveEventSeq = availableEndSeq;
    } else {
      effectiveEventSeq = eventSeq;
    }
  } else {
    effectiveEventSeq = Math.max(availableStartSeq, availableEndSeq - safeMaxEvents);
    truncatedBefore = effectiveEventSeq > availableStartSeq;
  }

  const startIndex = effectiveEventSeq - availableStartSeq;
  const slice = events.slice(startIndex, startIndex + safeMaxEvents);
  const nextEventSeq = effectiveEventSeq + slice.length;
  const fullView = slice.map(renderTranscriptEvent).join('\n\n');
  const viewTruncatedBefore = fullView.length > safeMaxViewChars;
  const view = viewTruncatedBefore ? fullView.slice(-safeMaxViewChars) : fullView;

  return {
    requestedEventSeq: typeof eventSeq === 'number' ? eventSeq : null,
    effectiveEventSeq,
    nextEventSeq,
    availableStartSeq,
    availableEndSeq,
    truncatedBefore,
    truncatedAfter: nextEventSeq < availableEndSeq,
    viewTruncatedBefore,
    events: slice,
    view,
  };
}

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\u0007|\u001B\\))/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_PATTERN, '');
}

export function normalizePaneText(text: string, removeAnsi: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const withoutAnsi = removeAnsi ? stripAnsi(normalized) : normalized;
  return stripControlChars(withoutAnsi);
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (typeof codePoint !== 'number') continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function sliceDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';

  let width = 0;
  let out = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (typeof codePoint !== 'number') continue;
    const charWidth = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? 0
      : (isFullWidthCodePoint(codePoint) ? 2 : 1);

    if (width + charWidth > maxWidth) break;

    out += character;
    width += charWidth;
  }

  return out;
}

function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return sliceDisplay(text, maxWidth);
  return `${sliceDisplay(text, maxWidth - 3)}...`;
}

function padDisplay(text: string, width: number): string {
  const padded = truncateDisplay(text, width);
  return `${padded}${' '.repeat(Math.max(0, width - displayWidth(padded)))}`;
}

function wrapDisplayText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  const normalized = text.replace(/\t/g, '    ');

  for (const logicalLine of normalized.split('\n')) {
    if (logicalLine.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    let currentWidth = 0;

    for (const character of logicalLine) {
      const codePoint = character.codePointAt(0);
      if (typeof codePoint !== 'number') continue;
      const charWidth = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? 0
        : (isFullWidthCodePoint(codePoint) ? 2 : 1);

      if (currentWidth > 0 && currentWidth + charWidth > safeWidth) {
        lines.push(current);
        current = character;
        currentWidth = charWidth;
      } else {
        current += character;
        currentWidth += charWidth;
      }
    }

    lines.push(current);
  }

  return lines;
}

function selectPaneLines(text: string, width: number, height: number, placeholder: string): string[] {
  const wrapped = wrapDisplayText(text.trim().length > 0 ? text : placeholder, width);
  const visible = wrapped.slice(-height);
  while (visible.length < height) {
    visible.push('');
  }
  return visible;
}

export function renderSplitDashboard(options: {
  leftTitle: string;
  rightTitle: string;
  leftText: string;
  rightText: string;
  width: number;
  height: number;
}): string {
  const safeWidth = Math.max(60, options.width);
  const safeHeight = Math.max(8, options.height);
  const paneWidth = Math.max(24, Math.floor((safeWidth - 3) / 2));
  const contentHeight = Math.max(3, safeHeight - 4);

  const leftLines = selectPaneLines(options.leftText, paneWidth, contentHeight, '(no terminal output yet)');
  const rightLines = selectPaneLines(options.rightText, paneWidth, contentHeight, '(no user/agent input yet)');
  const border = `+${'-'.repeat(paneWidth)}+${'-'.repeat(paneWidth)}+`;
  const titleRow = `|${padDisplay(options.leftTitle, paneWidth)}|${padDisplay(options.rightTitle, paneWidth)}|`;
  const rows = leftLines.map((left, index) => `|${padDisplay(left, paneWidth)}|${padDisplay(rightLines[index] || '', paneWidth)}|`);

  return [border, titleRow, border, ...rows, border].join('\n');
}
