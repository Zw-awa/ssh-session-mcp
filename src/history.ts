export type HistoryLineType = 'output' | 'input' | 'control' | 'lifecycle';

export interface HistoryLine {
  line: number;
  at?: string;
  actor?: string;
  text: string;
  type: HistoryLineType;
}

export interface HistorySnapshot {
  requestedLine: number | null;
  effectiveLine: number;
  nextLine: number;
  availableStart: number;
  availableEnd: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  lines: HistoryLine[];
  view: string;
}

export interface HistoryStats {
  lineStart: number;
  lineEnd: number;
  pendingOutput: boolean;
  maxLines: number;
  storedLines: number;
}

function normalizeForHistory(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitCompleteLines(text: string) {
  if (text.length === 0) {
    return { complete: [] as string[], pending: '' };
  }

  const normalized = normalizeForHistory(text);
  const parts = normalized.split('\n');
  const endsWithBreak = normalized.endsWith('\n');
  if (endsWithBreak && parts[parts.length - 1] === '') {
    parts.pop();
  }
  const pending = endsWithBreak ? '' : (parts.pop() ?? '');
  return {
    complete: parts,
    pending,
  };
}

function normalizeEventLines(text: string) {
  const normalized = normalizeForHistory(text);
  if (normalized.length === 0) {
    return [''];
  }

  const trimmed = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return trimmed.split('\n');
}

export function formatHistoryLine(line: HistoryLine) {
  if (line.type === 'output') {
    return line.text;
  }

  if (line.type === 'input') {
    return `[${line.actor || 'agent'}] ${line.text}`;
  }

  if (line.type === 'control') {
    return `[${line.actor || 'agent'}] <${line.text}>`;
  }

  return `[session] ${line.text}`;
}

export class SessionHistory {
  private readonly lines: HistoryLine[] = [];
  private nextLine = 1;
  private pendingOutput = '';

  constructor(private readonly maxLines: number) {}

  private trim() {
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }

  private pushLine(type: HistoryLineType, text: string, at?: string, actor?: string) {
    this.lines.push({
      line: this.nextLine,
      at,
      actor,
      text,
      type,
    });
    this.nextLine += 1;
    this.trim();
  }

  private snapshotLines() {
    const materialized = [...this.lines];
    if (this.pendingOutput.length > 0) {
      materialized.push({
        line: this.nextLine,
        text: this.pendingOutput,
        type: 'output',
      });
    }
    return materialized;
  }

  flushPendingOutput() {
    if (this.pendingOutput.length === 0) {
      return;
    }

    this.pushLine('output', this.pendingOutput);
    this.pendingOutput = '';
  }

  appendOutput(text: string, at?: string) {
    if (text.length === 0) {
      return;
    }

    const merged = `${this.pendingOutput}${text}`;
    const { complete, pending } = splitCompleteLines(merged);

    for (const line of complete) {
      this.pushLine('output', line, at);
    }

    this.pendingOutput = pending;
  }

  appendEvent(type: Exclude<HistoryLineType, 'output'>, text: string, actor?: string, at?: string) {
    this.flushPendingOutput();
    for (const line of normalizeEventLines(text)) {
      this.pushLine(type, line, at, actor);
    }
  }

  summary(): HistoryStats {
    const materialized = this.snapshotLines();
    return {
      lineStart: materialized[0]?.line ?? this.nextLine,
      lineEnd: materialized.length > 0 ? materialized[materialized.length - 1].line : this.nextLine,
      pendingOutput: this.pendingOutput.length > 0,
      maxLines: this.maxLines,
      storedLines: materialized.length,
    };
  }

  read(line: number | undefined, maxLines: number): HistorySnapshot {
    const materialized = this.snapshotLines();
    const availableStart = materialized[0]?.line ?? this.nextLine;
    const availableEnd = materialized.length > 0 ? materialized[materialized.length - 1].line + 1 : this.nextLine;
    const safeMaxLines = Math.max(1, maxLines);

    let effectiveLine: number;
    let truncatedBefore = false;

    if (typeof line === 'number') {
      if (line < availableStart) {
        effectiveLine = availableStart;
        truncatedBefore = true;
      } else if (line > availableEnd) {
        effectiveLine = availableEnd;
      } else {
        effectiveLine = line;
      }
    } else {
      effectiveLine = Math.max(availableStart, availableEnd - safeMaxLines);
      truncatedBefore = effectiveLine > availableStart;
    }

    const startIndex = effectiveLine - availableStart;
    const slice = materialized.slice(startIndex, startIndex + safeMaxLines);
    const nextLine = slice.length > 0 ? slice[slice.length - 1].line + 1 : effectiveLine;

    return {
      requestedLine: typeof line === 'number' ? line : null,
      effectiveLine,
      nextLine,
      availableStart,
      availableEnd,
      truncatedBefore,
      truncatedAfter: nextLine < availableEnd,
      lines: slice,
      view: slice.map(entry => `${entry.line.toString().padStart(6, ' ')}  ${formatHistoryLine(entry)}`).join('\n'),
    };
  }
}
