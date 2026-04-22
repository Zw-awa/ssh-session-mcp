import type { OperationMode } from '../server-state.js';
import { renderSharedViewerScriptHelpers } from './script-shared.js';

export function renderXtermSetupSection(options: {
  operationMode: OperationMode;
  wsPath: string;
}) {
  return `
  (function() {
    var wsPath = ${JSON.stringify(options.wsPath)};
    var terminal = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 14,
      fontFamily: 'Consolas, "SFMono-Regular", "Courier New", monospace',
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#72d6d1',
        selectionBackground: 'rgba(114,214,209,0.3)',
      },
      allowProposedApi: true,
    });
    var fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    var connDot = document.getElementById('connDot');
    var statusBar = document.getElementById('statusBar');
    var actorSelect = document.getElementById('actorSelect');
    var lockBadge = document.getElementById('lockBadge');
    var headerTitle = document.getElementById('headerTitle');
    var headerMeta = document.getElementById('headerMeta');
    var modeSelect = document.getElementById('modeSelect');
    var cleanupFns = [];
    var ws = null;
    var currentLine = '';
    var reconnectTimer = null;
    var knownRawChars = 0;
    var isFirstConnect = true;
    var currentLock = 'none';
    var scrollTimer = null;
    var offsetDecoder = null;
    var destroyed = false;

    function addCleanup(fn) {
      cleanupFns.push(fn);
      return fn;
    }

    function listen(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      addCleanup(function () {
        target.removeEventListener(eventName, handler);
      });
      return handler;
    }
  `;
}

export function renderXtermUiSection() {
  return `
${renderSharedViewerScriptHelpers({
  eventTypeProperty: 'eventType',
  summaryMaxLength: 80,
})}
    function getLockMode() {
      return actorSelect.value || 'common';
    }

    function getInputActor() {
      return 'user';
    }

    function isUserBlocked() {
      return currentLock === 'agent';
    }

    function updateLockUI(lock) {
      currentLock = lock;
      if (lock === 'agent') {
        lockBadge.textContent = 'AI active';
        lockBadge.className = 'lock-badge agent';
      } else if (lock === 'user') {
        lockBadge.textContent = 'user active';
        lockBadge.className = 'lock-badge user-lock';
      } else {
        lockBadge.textContent = 'unlocked';
        lockBadge.className = 'lock-badge none';
      }
      if (lock === 'user' && actorSelect.value !== 'user') {
        actorSelect.value = 'user';
      } else if (lock === 'none' && actorSelect.value !== 'common') {
        actorSelect.value = 'common';
      }
    }

    function setStatus(text, theme) {
      statusBar.textContent = text;
      statusBar.className = 'status-bar' + (theme ? ' ' + theme : '');
    }

    function cancelScheduledScroll() {
      if (scrollTimer === null) return;
      window.cancelAnimationFrame(scrollTimer);
      scrollTimer = null;
    }

    function scheduleScrollToBottom() {
      if (destroyed || scrollTimer !== null) return;
      scrollTimer = window.requestAnimationFrame(function() {
        scrollTimer = null;
        if (!destroyed) {
          terminal.scrollToBottom();
        }
      });
    }

    function eventTheme(event) {
      if (!event) return '';
      return getViewerActorTheme(event.actor);
    }

    function clearReconnectTimer() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function closeSocket() {
      if (!ws) return;
      try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(); } catch (e) {}
      ws = null;
    }
  `;
}

export function renderXtermConnectionSection() {
  return `
    function connect() {
      if (destroyed) return;
      clearReconnectTimer();
      closeSocket();
      offsetDecoder = new window.TextDecoder('utf-8');
      var loc = window.location;
      var wsUrl = (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + wsPath;
      if (!isFirstConnect && knownRawChars > 0) {
        wsUrl += (wsUrl.indexOf('?') === -1 ? '?' : '&') + 'rawOffset=' + knownRawChars;
      }
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function() {
        if (destroyed) {
          closeSocket();
          return;
        }
        connDot.className = 'conn-dot';
        if (isFirstConnect) { isFirstConnect = false; }
        currentLine = '';
        setStatus('Connected in ' + getLockMode() + ' mode', '');
        scheduleScrollToBottom();
      };

      ws.onmessage = function(evt) {
        if (destroyed) return;
        if (evt.data instanceof ArrayBuffer) {
          var chunk = new Uint8Array(evt.data);
          terminal.write(chunk, function() {
            scheduleScrollToBottom();
          });
          if (offsetDecoder) {
            knownRawChars += offsetDecoder.decode(chunk, { stream: true }).length;
          }
          return;
        }
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'init' && msg.summary) {
            var s = msg.summary;
            headerTitle.textContent = (s.sessionName || s.sessionId || 'SSH') + ' ' + s.user + '@' + s.host + ':' + s.port;
            headerMeta.textContent = s.user + '@' + s.host + ':' + s.port;
            document.title = headerTitle.textContent + ' \\u2022 SSH Terminal';
            if (s.inputLock) { updateLockUI(s.inputLock); }
            scheduleScrollToBottom();
          }
          if (msg.type === 'event') {
            setStatus(getEventTimePrefix(msg.at) + summarizeEvent(msg), eventTheme(msg));
          }
          if (msg.type === 'lock') {
            updateLockUI(msg.lock);
          }
          if (msg.type === 'mode') {
            modeSelect.value = msg.mode;
          }
          if (msg.type === 'lock_rejected') {
            setStatus(getInputBlockedStatusText(), 'locked');
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        if (destroyed) return;
        connDot.className = 'conn-dot disconnected';
        setStatus('Disconnected. Reconnecting...', 'error');
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = function() {};
    }
  `;
}

export function renderXtermInputSection() {
  return `
    function sendJson(obj) {
      if (!destroyed && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }

    var dataDisposable = terminal.onData(function(data) {
      if (destroyed) return;
      if (isUserBlocked()) {
        setStatus(getInputBlockedStatusText(), 'locked');
        return;
      }
      var records = [];
      var normalized = data.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (var i = 0; i < normalized.length; i++) {
        var ch = normalized[i];
        if (ch === '\\n') {
          records.push({ actor: getInputActor(), text: currentLine.length > 0 ? currentLine : '<newline>', type: 'input' });
          currentLine = '';
        } else if (ch === '\\u007f' || ch === '\\b') {
          currentLine = currentLine.slice(0, -1);
        } else if (ch === '\\u0003') {
          currentLine = '';
          records.push({ actor: getInputActor(), text: 'ctrl_c', type: 'control' });
        } else if (ch === '\\u0004') {
          records.push({ actor: getInputActor(), text: 'ctrl_d', type: 'control' });
        } else if (ch >= ' ') {
          currentLine += ch;
        }
      }
      var transportData = data.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r');
      sendJson({ type: 'input', data: transportData, records: records });
    });
    addCleanup(function () { dataDisposable.dispose(); });

    var binaryDisposable = terminal.onBinary(function(data) {
      if (destroyed || isUserBlocked()) return;
      sendJson({ type: 'input', data: data, records: [] });
    });
    addCleanup(function () { binaryDisposable.dispose(); });

    var resizeDisposable = terminal.onResize(function(size) {
      if (destroyed) return;
      sendJson({ type: 'resize', cols: size.cols, rows: size.rows });
      scheduleScrollToBottom();
    });
    addCleanup(function () { resizeDisposable.dispose(); });
  `;
}

export function renderXtermLifecycleSection() {
  return `
    function handleWindowResize() {
      if (destroyed) return;
      fitAddon.fit();
      scheduleScrollToBottom();
    }

    function handleActorChange() {
      if (destroyed) return;
      var lockMode = getLockMode();
      if (lockMode === 'common') {
        sendJson({ type: 'lock', lock: 'none' });
        updateLockUI('none');
        setStatus('Switched to common mode. Both user and AI can type.', 'user');
      } else if (lockMode === 'user') {
        sendJson({ type: 'lock', lock: 'user' });
        updateLockUI('user');
        setStatus('Switched to user mode. AI input is blocked.', 'user');
      } else {
        sendJson({ type: 'lock', lock: 'agent' });
        updateLockUI('agent');
        setStatus('Switched to ' + lockMode + ' mode. AI controls the terminal. Your input is blocked.', 'claude');
      }
      terminal.focus();
    }

    function handleModeChange() {
      if (destroyed) return;
      var newMode = modeSelect.value;
      if (newMode === 'full') {
        var confirmed = confirm('Warning: Full mode allows AI to execute dangerous commands (rm -rf, mkfs, etc.) without blocking.\\n\\nAre you sure you want to switch to full mode?');
        if (!confirmed) {
          modeSelect.value = 'safe';
          return;
        }
      }
      sendJson({ type: 'mode', mode: newMode });
      setStatus('Operation mode switched to: ' + newMode, newMode === 'full' ? 'error' : 'user');
      terminal.focus();
    }

    function shutdown() {
      if (destroyed) return;
      destroyed = true;
      clearReconnectTimer();
      cancelScheduledScroll();
      closeSocket();
      while (cleanupFns.length > 0) {
        var fn = cleanupFns.pop();
        if (!fn) continue;
        try { fn(); } catch (e) {}
      }
      try {
        if (typeof fitAddon.dispose === 'function') {
          fitAddon.dispose();
        }
      } catch (e) {}
      try { terminal.dispose(); } catch (e) {}
    }

    listen(window, 'resize', handleWindowResize);
    listen(actorSelect, 'change', handleActorChange);
    listen(modeSelect, 'change', handleModeChange);
    listen(window, 'pagehide', shutdown);
    listen(window, 'beforeunload', shutdown);

    connect();
    terminal.focus();
    scheduleScrollToBottom();
  })();
  `;
}
