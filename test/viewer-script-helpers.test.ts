import { describe, expect, it } from 'vitest';

import { renderSharedViewerScriptHelpers } from '../src/viewer-html/script-shared.js';

describe('viewer script shared helpers', () => {
  it('renders helpers for legacy browser events', () => {
    const script = renderSharedViewerScriptHelpers({
      eventTypeProperty: 'type',
      summaryMaxLength: 96,
    });

    expect(script).toContain('function getViewerActorTheme(actor)');
    expect(script).toContain("var eventType = event.type;");
    expect(script).toContain("compact.length > 96 ? compact.slice(0, 93) + '...' : compact;");
    expect(script).toContain("return 'Input blocked: AI is active. Switch to \"common\" or \"user\" to type.';");
  });

  it('renders helpers for xterm websocket events', () => {
    const script = renderSharedViewerScriptHelpers({
      eventTypeProperty: 'eventType',
      summaryMaxLength: 80,
    });

    expect(script).toContain("var eventType = event.eventType;");
    expect(script).toContain("compact.length > 80 ? compact.slice(0, 77) + '...' : compact;");
    expect(script).toContain('function getEventTimePrefix(at)');
    expect(script).toContain('function formatViewerErrorStatus(prefix, error)');
  });
});
