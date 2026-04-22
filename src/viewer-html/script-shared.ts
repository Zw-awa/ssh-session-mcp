export interface SharedViewerScriptHelpersOptions {
  eventTypeProperty: 'type' | 'eventType';
  summaryMaxLength: number;
}

export function renderSharedViewerScriptHelpers(options: SharedViewerScriptHelpersOptions) {
  const clippedLength = Math.max(1, options.summaryMaxLength - 3);

  return `
    function getViewerActorTheme(actor) {
      if (actor === 'user') return 'user';
      if (actor === 'codex') return 'codex';
      if (actor === 'claude') return 'claude';
      return 'session';
    }

    function summarizeEvent(event) {
      var eventType = event.${options.eventTypeProperty};
      var compact = String(event.text || '').replace(/\\s+/g, ' ').trim();
      var clipped = compact.length > ${options.summaryMaxLength} ? compact.slice(0, ${clippedLength}) + '...' : compact;
      if (eventType === 'input') return '[' + (event.actor || 'agent') + '] ' + (clipped || '<newline>');
      if (eventType === 'control') return '[' + (event.actor || 'agent') + '] <' + (clipped || 'control') + '>';
      return '[session] ' + clipped;
    }

    function getEventTimePrefix(at) {
      var time = String(at || '').slice(11, 19);
      return time ? time + ' ' : '';
    }

    function formatViewerErrorStatus(prefix, error) {
      return prefix + (error && error.message ? error.message : String(error));
    }

    function getInputBlockedStatusText() {
      return 'Input blocked: AI is active. Switch to "common" or "user" to type.';
    }
  `;
}
