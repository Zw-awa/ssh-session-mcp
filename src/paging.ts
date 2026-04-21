import type { BufferSnapshot } from './shared.js';

export interface ReadMoreHint {
  availableEnd: number;
  availableStart: number;
  maxCharsSuggested: number;
  offset: number;
  session: string;
}

export function buildReadMoreHint(options: {
  availableEnd: number;
  availableStart: number;
  maxCharsSuggested: number;
  offset: number;
  session: string;
}): ReadMoreHint {
  return {
    session: options.session,
    offset: Math.max(options.availableStart, options.offset),
    maxCharsSuggested: Math.max(1, options.maxCharsSuggested),
    availableStart: options.availableStart,
    availableEnd: options.availableEnd,
  };
}

export function buildReadProgress(snapshot: BufferSnapshot) {
  return {
    availableStart: snapshot.availableStart,
    availableEnd: snapshot.availableEnd,
    recommendedNextOffset: snapshot.nextOffset < snapshot.availableEnd ? snapshot.nextOffset : snapshot.availableEnd,
  };
}

export function buildSnapshotReadMore(session: string, snapshot: BufferSnapshot, maxCharsSuggested: number) {
  return buildReadMoreHint({
    session,
    offset: snapshot.effectiveOffset,
    maxCharsSuggested,
    availableStart: snapshot.availableStart,
    availableEnd: snapshot.availableEnd,
  });
}
