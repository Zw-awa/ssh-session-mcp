import { renderSharedViewerScriptHelpers } from './script-shared.js';

export interface LegacyBrowserScriptSectionsOptions {
  attachPath: string;
  refreshMs: number;
}

export function renderLegacyBrowserSetupSection(options: LegacyBrowserScriptSectionsOptions) {
  return `
    const attachBasePath = ${JSON.stringify(options.attachPath)};
    const refreshMs = ${options.refreshMs};
    const actorEl = document.getElementById('actor');
    const focusBtn = document.getElementById('focusBtn');
    const clearBtn = document.getElementById('clearBtn');
    const terminalEl = document.getElementById('terminal');
    const terminalWrapEl = document.getElementById('terminalWrap');
    const statusBarEl = document.getElementById('statusBar');
    const controlButtons = Array.from(document.querySelectorAll('[data-control]'));
    const cleanupCallbacks = [];
    const state = {
      currentLine: '',
      eventSeq: undefined,
      outputOffset: undefined,
      lastEvent: undefined,
      lastStatusText: '[browser attach] connecting...',
      initialized: false,
      polling: false,
      closed: false,
      stopped: false,
      loadStarted: false,
      sendQueue: Promise.resolve(),
      resizeTimer: undefined,
      retryTimer: undefined,
      pollController: undefined,
    };
    const ansiPattern = /\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\].*?(?:\\u0007|\\u001B\\\\))/g;

    function registerCleanup(callback) {
      cleanupCallbacks.push(callback);
      return callback;
    }

    function listen(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      registerCleanup(function () {
        target.removeEventListener(eventName, handler);
      });
      return handler;
    }
  `;
}

export function renderLegacyBrowserUtilitySection() {
  return `
${renderSharedViewerScriptHelpers({
  eventTypeProperty: 'type',
  summaryMaxLength: 96,
})}
    function stripAnsi(text) {
      return text.replace(ansiPattern, '');
    }

    function normalizeBrowserOutput(text) {
      return stripAnsi(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    }

    function normalizeTransportData(text) {
      return text.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
    }

    function eventTheme(event, text) {
      if (text.startsWith('[browser attach] error')) return 'error';
      if (!event) return 'idle';
      return getViewerActorTheme(event.actor);
    }

    function setStatus(text, event) {
      state.lastStatusText = text;
      statusBarEl.textContent = text;
      statusBarEl.className = 'status ' + eventTheme(event, text);
    }

    function appendOutput(output) {
      if (!output || state.stopped) return;
      const normalized = normalizeBrowserOutput(output);
      const nearBottom = terminalWrapEl.scrollTop + terminalWrapEl.clientHeight >= terminalWrapEl.scrollHeight - 36;
      if (terminalEl.textContent === 'Connecting...') {
        terminalEl.textContent = '';
      }
      terminalEl.textContent += normalized;
      if (terminalEl.textContent.length > 280000) {
        terminalEl.textContent = terminalEl.textContent.slice(-220000);
      }
      if (nearBottom) {
        terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
      }
    }

    function getActor() {
      return actorEl.value || 'user';
    }

    function focusTerminal() {
      if (state.stopped) return;
      terminalEl.focus();
      terminalWrapEl.scrollTop = terminalWrapEl.scrollHeight;
    }

    function buildPasteRecords(text) {
      const records = [];
      const normalized = String(text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (const character of normalized) {
        if (character === '\\n') {
          records.push({
            actor: getActor(),
            text: state.currentLine.length > 0 ? state.currentLine : '<newline>',
            type: 'input'
          });
          state.currentLine = '';
          continue;
        }
        if (character === '\\t') {
          state.currentLine += '\\t';
          continue;
        }
        if (character >= ' ') {
          state.currentLine += character;
        }
      }
      return records;
    }
  `;
}

export function renderLegacyBrowserTransportSection() {
  return `
    function enqueue(task) {
      if (state.stopped) {
        return Promise.resolve();
      }
      state.sendQueue = state.sendQueue.then(function () {
        if (state.stopped) {
          return undefined;
        }
        return task();
      }).catch(function (error) {
        if (!state.stopped) {
          setStatus(formatViewerErrorStatus('[browser attach] error: ', error));
        }
      });
      return state.sendQueue;
    }

    async function postJson(suffix, payload) {
      if (state.stopped) {
        return {};
      }
      const response = await fetch(attachBasePath + suffix, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + await response.text());
      }
      return response.json();
    }

    function sendRaw(data, records) {
      return enqueue(function () {
        return postJson('/input', {
          data: data,
          records: records || []
        });
      });
    }

    function sendControl(control, sequence) {
      if (control === 'ctrl_c') {
        state.currentLine = '';
      }
      return sendRaw(sequence, [{
        actor: getActor(),
        text: control,
        type: 'control'
      }]);
    }
  `;
}

export function renderLegacyBrowserPollingSection() {
  return `
    function estimateTerminalSize() {
      const rect = terminalWrapEl.getBoundingClientRect();
      const styles = window.getComputedStyle(terminalEl);
      const fontSize = Number.parseFloat(styles.fontSize || '14') || 14;
      const lineHeight = Number.parseFloat(styles.lineHeight || String(fontSize * 1.45)) || fontSize * 1.45;
      const charWidth = fontSize * 0.62;
      const cols = Math.max(40, Math.floor((rect.width - 36) / charWidth));
      const rows = Math.max(12, Math.floor((rect.height - 36) / lineHeight));
      return { cols, rows };
    }

    function scheduleResize() {
      if (state.stopped || state.closed) return;
      if (state.resizeTimer) {
        window.clearTimeout(state.resizeTimer);
      }
      state.resizeTimer = window.setTimeout(function () {
        state.resizeTimer = undefined;
        if (state.stopped || state.closed) return;
        const size = estimateTerminalSize();
        enqueue(function () {
          return postJson('/resize', size);
        });
      }, 120);
    }

    async function pollOnce(waitMs) {
      if (state.stopped) return;
      const url = new URL(attachBasePath, window.location.origin);
      url.searchParams.set('maxChars', '16000');
      url.searchParams.set('maxEvents', '120');
      url.searchParams.set('waitMs', String(waitMs));
      if (typeof state.outputOffset === 'number') {
        url.searchParams.set('outputOffset', String(state.outputOffset));
      }
      if (typeof state.eventSeq === 'number') {
        url.searchParams.set('eventSeq', String(state.eventSeq));
      }

      const controller = new AbortController();
      state.pollController = controller;

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ': ' + await response.text());
        }

        const payload = await response.json();
        appendOutput(payload.output || '');
        if (Array.isArray(payload.events) && payload.events.length > 0) {
          const latestEvent = payload.events[payload.events.length - 1];
          state.lastEvent = latestEvent;
          setStatus(getEventTimePrefix(latestEvent.at) + summarizeEvent(latestEvent), latestEvent);
        } else if (!state.initialized) {
          setStatus('[browser attach] connected');
        }

        state.outputOffset = payload.nextOutputOffset;
        state.eventSeq = payload.nextEventSeq;
        state.initialized = true;
        state.closed = payload.summary && payload.summary.closed === true;

        if (state.closed && !state.lastStatusText.includes('[closed]')) {
          setStatus('[browser attach] session closed');
        }
      } finally {
        if (state.pollController === controller) {
          state.pollController = undefined;
        }
      }
    }

    function waitForRetry(delayMs) {
      return new Promise(function (resolve) {
        state.retryTimer = window.setTimeout(function () {
          state.retryTimer = undefined;
          resolve();
        }, delayMs);
      });
    }

    async function pollLoop() {
      if (state.polling) return;
      state.polling = true;
      try {
        while (!state.stopped && !state.closed) {
          try {
            await pollOnce(state.initialized ? refreshMs : 0);
          } catch (error) {
            if (state.stopped || (error && error.name === 'AbortError')) {
              break;
            }
            setStatus(formatViewerErrorStatus('[browser attach] error: ', error));
            await waitForRetry(Math.min(refreshMs, 800));
          }
        }
      } finally {
        state.polling = false;
      }
    }
  `;
}

export function renderLegacyBrowserInteractionSection() {
  return `
    function handleTerminalKeydown(event) {
      if (state.stopped || event.metaKey) return;

      if (event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
          event.preventDefault();
          void sendControl('ctrl_c', '\\u0003');
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          void sendControl('ctrl_d', '\\u0004');
          return;
        }
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const recordText = state.currentLine.length > 0 ? state.currentLine : '<newline>';
        state.currentLine = '';
        void sendRaw('\\r', [{
          actor: getActor(),
          text: recordText,
          type: 'input'
        }]);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        state.currentLine = state.currentLine.slice(0, -1);
        void sendRaw('\\u007f', []);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        state.currentLine += '\\t';
        void sendRaw('\\t', []);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        void sendRaw('\\u001b[A', []);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        void sendRaw('\\u001b[B', []);
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void sendRaw('\\u001b[D', []);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void sendRaw('\\u001b[C', []);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        void sendRaw('\\u001b', []);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
        event.preventDefault();
        state.currentLine += event.key;
        void sendRaw(event.key, []);
      }
    }

    function handleTerminalPaste(event) {
      if (state.stopped) return;
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text');
      const records = buildPasteRecords(text);
      void sendRaw(normalizeTransportData(text), records);
    }

    function handleFocusClick() {
      focusTerminal();
    }

    function handleClearClick() {
      terminalEl.textContent = '';
      focusTerminal();
    }

    function handleActorChange() {
      if (state.stopped) return;
      setStatus('[browser attach] actor -> ' + getActor());
      focusTerminal();
    }

    function handleControlClick(event) {
      if (state.stopped) return;
      const control = event.currentTarget.getAttribute('data-control');
      if (control === 'ctrl_c') {
        void sendControl('ctrl_c', '\\u0003');
        return;
      }
      if (control === 'ctrl_d') {
        void sendControl('ctrl_d', '\\u0004');
      }
    }
  `;
}

export function renderLegacyBrowserLifecycleSection() {
  return `
    function shutdown() {
      if (state.stopped) return;
      state.stopped = true;
      state.polling = false;
      if (state.resizeTimer) {
        window.clearTimeout(state.resizeTimer);
        state.resizeTimer = undefined;
      }
      if (state.retryTimer) {
        window.clearTimeout(state.retryTimer);
        state.retryTimer = undefined;
      }
      if (state.pollController) {
        state.pollController.abort();
        state.pollController = undefined;
      }
      while (cleanupCallbacks.length > 0) {
        const callback = cleanupCallbacks.pop();
        if (!callback) continue;
        try {
          callback();
        } catch {
          // ignore cleanup errors
        }
      }
    }

    function handleWindowLoad() {
      if (state.loadStarted || state.stopped) return;
      state.loadStarted = true;
      focusTerminal();
      scheduleResize();
      void pollLoop();
    }

    listen(terminalEl, 'keydown', handleTerminalKeydown);
    listen(terminalEl, 'paste', handleTerminalPaste);
    listen(focusBtn, 'click', handleFocusClick);
    listen(clearBtn, 'click', handleClearClick);
    controlButtons.forEach(function (button) {
      listen(button, 'click', handleControlClick);
    });
    listen(actorEl, 'change', handleActorChange);
    listen(window, 'resize', scheduleResize);
    listen(terminalWrapEl, 'click', focusTerminal);
    listen(window, 'load', handleWindowLoad);
    listen(window, 'pagehide', shutdown);
    listen(window, 'beforeunload', shutdown);
  `;
}
