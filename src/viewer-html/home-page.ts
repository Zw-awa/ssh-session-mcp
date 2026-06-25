/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  sessions,
  escapeHtml,
  sessionDisplayName,
  getViewerBaseUrl,
  LOCAL_MODE,
  DEFAULT_VIEWER_REFRESH_MS,
  viewerAccessPolicy,
} from '../server-state.js';
import { renderViewerDocument } from './page-shell.js';
import { HOME_PAGE_STYLES } from './page-styles.js';

function buildInitialSessions() {
  return [...sessions.values()]
    .filter(session => !session.closed)
    .map(session => ({
      ...session.summary(),
      viewerUrl: (getViewerBaseUrl() || '') + '/terminal/session/' + encodeURIComponent(session.sessionId),
      title: sessionDisplayName(session.summary()),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function buildClientScript(debug: boolean, refreshMs: number) {
  const payload = JSON.stringify({
    debug,
    refreshMs,
    initialViewerAccessPolicy: viewerAccessPolicy,
    initialSessions: buildInitialSessions(),
  });

  return `
const boot = ${payload};
// fetch("/api/sessions")
let refreshTimer = null;
let activeSessionRef = null;
let sessionRules = {};
let viewerAccessState = boot.initialViewerAccessPolicy;
let ruleDragState = null;
let detailState = {};

function qs(id) { return document.getElementById(id); }
function escapeText(text) { const div = document.createElement('div'); div.appendChild(document.createTextNode(String(text))); return div.innerHTML; }
function prettyTime(value) { return new Date(value).toLocaleString(); }
function idleLabel(updatedAt) {
  const minutes = Math.round((Date.now() - Date.parse(updatedAt)) / 60000);
  if (minutes < 1) return 'active';
  if (minutes === 1) return '1m idle';
  return minutes + 'm idle';
}
function severityRank(action) {
  if (action === 'error') return 3;
  if (action === 'warning') return 2;
  return 1;
}
function normalizeRule(rule, index) {
  return {
    id: String(rule.id || '').trim(),
    enabled: rule.enabled !== false,
    pattern: String(rule.pattern || ''),
    flags: String(rule.flags || ''),
    priority: Number.isInteger(rule.priority) ? rule.priority : index,
    mode: rule.mode === 'full' || rule.mode === 'both' ? rule.mode : 'safe',
    category: ['blocked', 'interactive', 'streaming', 'long_running'].includes(rule.category) ? rule.category : 'dangerous',
    action: rule.action === 'warning' || rule.action === 'log' ? rule.action : 'error',
    message: String(rule.message || ''),
    suggestion: typeof rule.suggestion === 'string' ? rule.suggestion : '',
    source: rule.source === 'default' ? 'default' : 'session',
  };
}
function sortRules(rules) {
  return [...rules]
    .map((rule, index) => normalizeRule(rule, index))
    .sort((a, b) => {
      const severityDiff = severityRank(b.action) - severityRank(a.action);
      if (severityDiff !== 0) return severityDiff;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    })
    .map((rule, index) => ({ ...rule, priority: index }));
}
function reindexRules(rules) {
  return rules.map((rule, index) => ({ ...rule, priority: index }));
}
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, boot.refreshMs);
}
function sr() { scheduleRefresh(); }
// fetch("/api/sessions")
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (error) { throw new Error(text || response.statusText); }
  if (!response.ok) throw new Error(data.error || response.statusText || 'Request failed');
  return data;
}
async function refreshAll() {
  try {
    const [sessionsPayload, accessPayload] = await Promise.all([
      fetchJson('/api/sessions'),
      fetchJson('/api/viewer-access-policy'),
    ]);
    activeSessionRef = sessionsPayload.activeSessionRef;
    viewerAccessState = accessPayload.policy;
    renderViewerAccessPanel();
    renderSessions(sessionsPayload.sessions || []);
    await refreshOpenDetails();
  } catch (error) {
    qs('globalNotice').textContent = 'Refresh failed: ' + error.message;
  } finally {
    scheduleRefresh();
  }
}
function detailMeta(sessionId) {
  if (!detailState[sessionId]) {
    detailState[sessionId] = { open: false, dirty: false };
  }
  return detailState[sessionId];
}
function markDetailDirty(sessionId, dirty) {
  const state = detailMeta(sessionId);
  state.dirty = dirty;
}
function renderViewerAccessPanel() {
  const modeEl = qs('viewerAccessMode');
  if (!modeEl) return;
  modeEl.value = viewerAccessState.mode;
  if (document.activeElement !== qs('viewerIpAllowlist')) {
    qs('viewerIpAllowlist').value = (viewerAccessState.ipAllowlist || []).join('\\n');
  }
  if (document.activeElement !== qs('viewerIpDenylist')) {
    qs('viewerIpDenylist').value = (viewerAccessState.ipDenylist || []).join('\\n');
  }
  if (document.activeElement !== qs('viewerAllowedOrigins')) {
    qs('viewerAllowedOrigins').value = (viewerAccessState.allowedOrigins || []).join('\\n');
  }
  qs('viewerAccessUpdatedAt').textContent = viewerAccessState.updatedAt ? 'Updated: ' + prettyTime(viewerAccessState.updatedAt) : 'Updated: n/a';
}
function badgeClass(session) {
  if (session.inputLock === 'agent') return 'status-badge badge-agent';
  if (session.inputLock === 'user') return 'status-badge badge-user';
  return 'status-badge badge-idle';
}
function modeBadge(session) {
  return '<span class="status-badge badge-mode">' + escapeText(session.operationMode || 'safe') + '</span>';
}
function lockBadge(session) {
  if (session.inputLock === 'agent') return '<span class="status-badge badge-agent">AI active</span>';
  if (session.inputLock === 'user') return '<span class="status-badge badge-user">' + escapeText(session.lockPolicy === 'auto' ? 'user drafting' : 'user only') + '</span>';
  return '';
}
function debugControlsMarkup(sessionId) {
  if (!boot.debug) {
    return '';
  }
  return '<div class="debug-tools">' +
    '<div class="debug-runner">' +
      '<input class="rule-input debug-input" data-agent-input="' + escapeText(sessionId) + '" id="agent-input-' + escapeText(sessionId) + '" placeholder="Run as agent..." />' +
      '<button class="btn" data-action="debug-run" data-session="' + escapeText(sessionId) + '">Run</button>' +
    '</div>' +
    '<div class="debug-controls">' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="ctrl_c">C-c</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="ctrl_d">C-d</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="enter">Enter</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="up">↑</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="down">↓</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="left">←</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="right">→</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="backspace">BS</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="tab">Tab</button>' +
      '<button class="btn" data-action="debug-control" data-session="' + escapeText(sessionId) + '" data-control="esc">Esc</button>' +
      '<button class="btn" data-action="set-active" data-session="' + escapeText(sessionId) + '">Set Active</button>' +
    '</div>' +
  '</div>';
}
function sessionMarkup(session) {
  const isActive = activeSessionRef && session.sessionRef === activeSessionRef;
  const activeBadge = isActive ? '<span class="status-badge badge-active">active</span>' : '';
  return '<article class="session-card" data-session-card="' + escapeText(session.sessionId) + '">' +
    '<div class="session-header">' +
      '<div class="session-heading">' +
        '<div class="session-title" data-role="title">' + escapeText(session.sessionName || session.sessionRef || session.sessionId) + activeBadge + modeBadge(session) + lockBadge(session) + '</div>' +
        '<div class="session-meta" data-role="connection">' + escapeText(session.user + '@' + session.host + ':' + session.port) + '</div>' +
        '<div class="session-meta" data-role="times">Created: ' + escapeText(prettyTime(session.createdAt)) + ' · Last activity: ' + escapeText(prettyTime(session.updatedAt)) + '</div>' +
      '</div>' +
      '<div class="session-actions">' +
        '<a class="btn btn-primary" data-role="terminal-link" href="/terminal/session/' + encodeURIComponent(session.sessionId) + '">Terminal</a>' +
        '<button class="btn" data-action="details" data-role="details-button" data-session="' + escapeText(session.sessionId) + '">Details</button>' +
        '<button class="btn" data-action="mode" data-session="' + escapeText(session.sessionId) + '">Mode</button>' +
        '<button class="btn btn-danger" data-action="close" data-session="' + escapeText(session.sessionId) + '">Close</button>' +
      '</div>' +
    '</div>' +
    '<div class="session-state-row"><span class="' + badgeClass(session) + '" data-role="idle-badge">' + escapeText(idleLabel(session.updatedAt)) + '</span><span class="session-meta" data-role="policy-meta">Policy: ' + escapeText(session.lockPolicy) + (session.userDraftActive ? ' · draft active' : '') + '</span></div>' +
    '<div class="detail-shell" id="detail-' + escapeText(session.sessionId) + '"></div>' +
    debugControlsMarkup(session.sessionId) +
  '</article>';
}
function syncSessionCard(card, session) {
  const isActive = activeSessionRef && session.sessionRef === activeSessionRef;
  const activeBadge = isActive ? '<span class="status-badge badge-active">active</span>' : '';
  const title = card.querySelector('[data-role="title"]');
  const connection = card.querySelector('[data-role="connection"]');
  const times = card.querySelector('[data-role="times"]');
  const terminalLink = card.querySelector('[data-role="terminal-link"]');
  const idleBadge = card.querySelector('[data-role="idle-badge"]');
  const policyMeta = card.querySelector('[data-role="policy-meta"]');
  const detailsButton = card.querySelector('[data-role="details-button"]');
  const detailShell = card.querySelector('.detail-shell');
  const open = detailShell && detailShell.dataset.open === 'true';

  if (title) {
    title.innerHTML = escapeText(session.sessionName || session.sessionRef || session.sessionId) + activeBadge + modeBadge(session) + lockBadge(session);
  }
  if (connection) {
    connection.textContent = session.user + '@' + session.host + ':' + session.port;
  }
  if (times) {
    times.textContent = 'Created: ' + prettyTime(session.createdAt) + ' · Last activity: ' + prettyTime(session.updatedAt);
  }
  if (terminalLink) {
    terminalLink.setAttribute('href', '/terminal/session/' + encodeURIComponent(session.sessionId));
  }
  if (idleBadge) {
    idleBadge.className = badgeClass(session);
    idleBadge.textContent = idleLabel(session.updatedAt);
  }
  if (policyMeta) {
    policyMeta.textContent = 'Policy: ' + session.lockPolicy + (session.userDraftActive ? ' · draft active' : '');
  }
  if (detailsButton) {
    detailsButton.textContent = open ? 'Hide' : 'Details';
  }
}
function renderSessions(list) {
  const root = qs('sessions');
  if (!root) return;
  if (!Array.isArray(list) || list.length === 0) {
    if (!root.querySelector('.empty-state')) {
      root.innerHTML = '<div class="empty-state">No active SSH sessions</div>';
    }
    return;
  }
  const existingCards = new Map(Array.from(root.querySelectorAll('.session-card[data-session-card]')).map(card => [card.getAttribute('data-session-card'), card]));
  const orderedCards = [];

  for (const session of list) {
    let card = existingCards.get(session.sessionId);
    if (!card) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = sessionMarkup(session);
      card = wrapper.firstElementChild;
    }
    syncSessionCard(card, session);
    orderedCards.push(card);
    existingCards.delete(session.sessionId);
  }

  const currentOrder = Array.from(root.querySelectorAll('.session-card[data-session-card]')).map(card => card.getAttribute('data-session-card'));
  const desiredOrder = orderedCards.map(card => card.getAttribute('data-session-card'));
  const sameOrder = currentOrder.length === desiredOrder.length && currentOrder.every((value, index) => value === desiredOrder[index]);
  if (!sameOrder) {
    root.replaceChildren(...orderedCards);
  } else {
    for (const card of orderedCards) {
      if (!card.parentElement) {
        root.appendChild(card);
      }
    }
  }

  for (const orphan of existingCards.values()) {
    orphan.remove();
  }
}
function parseLines(text) {
  return text.split(/\\r?\\n/).map(line => line.trim()).filter(line => line.length > 0);
}
async function saveViewerAccessPolicy() {
  try {
    const payload = {
      mode: qs('viewerAccessMode').value,
      ipAllowlist: parseLines(qs('viewerIpAllowlist').value),
      ipDenylist: parseLines(qs('viewerIpDenylist').value),
      allowedOrigins: parseLines(qs('viewerAllowedOrigins').value),
    };
    const result = await fetchJson('/api/viewer-access-policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    viewerAccessState = result.policy;
    renderViewerAccessPanel();
    qs('globalNotice').textContent = 'Viewer access policy saved.';
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to save viewer access policy: ' + error.message;
  }
}
function renderRuleEditor(sessionId, payload) {
  const rules = sortRules(payload.activeRules || []);
  sessionRules[sessionId] = rules;
  return '<section class="rule-editor">' +
    '<div class="rule-editor-header">' +
      '<div><strong>Rules</strong><div class="tiny-text">Order: error > warning > log. Within the same level, upper rows win.</div></div>' +
      '<div class="rule-editor-actions">' +
        '<button class="btn" data-action="add-rule" data-session="' + escapeText(sessionId) + '">Add Rule</button>' +
        '<button class="btn btn-primary" data-action="save-rules" data-session="' + escapeText(sessionId) + '">Save Rules</button>' +
      '</div>' +
    '</div>' +
    '<div class="rule-list" id="rule-list-' + escapeText(sessionId) + '">' +
      rules.map((rule, index) => renderRuleRow(sessionId, rule, index)).join('') +
    '</div>' +
  '</section>';
}
function renderRuleRow(sessionId, rule, index) {
  return '<div class="rule-row" data-rule-index="' + index + '" data-session="' + escapeText(sessionId) + '">' +
    '<div class="rule-row-top">' +
      '<div class="rule-handle" draggable="true" data-drag-handle="true" title="Drag to reorder">::</div>' +
      '<label class="rule-toggle"><input type="checkbox" data-field="enabled" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '"' + (rule.enabled ? ' checked' : '') + '> enabled</label>' +
      '<input class="rule-input short" data-field="id" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '" value="' + escapeText(rule.id) + '" placeholder="rule id">' +
      '<select class="rule-input short" data-field="action" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '">' +
        ['error','warning','log'].map(value => '<option value="' + value + '"' + (rule.action === value ? ' selected' : '') + '>' + value + '</option>').join('') +
      '</select>' +
      '<select class="rule-input short" data-field="mode" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '">' +
        ['safe','full','both'].map(value => '<option value="' + value + '"' + (rule.mode === value ? ' selected' : '') + '>' + value + '</option>').join('') +
      '</select>' +
      '<select class="rule-input short" data-field="category" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '">' +
        ['dangerous','blocked','interactive','streaming','long_running'].map(value => '<option value="' + value + '"' + (rule.category === value ? ' selected' : '') + '>' + value + '</option>').join('') +
      '</select>' +
      '<button class="btn btn-danger" data-action="delete-rule" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '">Delete</button>' +
    '</div>' +
    '<div class="rule-row-bottom">' +
      '<input class="rule-input wide" data-field="pattern" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '" value="' + escapeText(rule.pattern) + '" placeholder="regex pattern">' +
      '<input class="rule-input short" data-field="flags" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '" value="' + escapeText(rule.flags || '') + '" placeholder="flags">' +
      '<input class="rule-input wide" data-field="message" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '" value="' + escapeText(rule.message) + '" placeholder="message">' +
      '<input class="rule-input wide" data-field="suggestion" data-session="' + escapeText(sessionId) + '" data-rule-index="' + index + '" value="' + escapeText(rule.suggestion || '') + '" placeholder="suggestion (optional)">' +
    '</div>' +
  '</div>';
}
async function fetchDetailPayload(sessionId) {
  const [diag, history, policyPayload] = await Promise.all([
    fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/diagnostics'),
    fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/history?maxLines=16'),
    fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/policy'),
  ]);
  return { diag, history, policyPayload };
}
function renderDetailContent(sessionId, payload) {
  return '<section class="detail-panel"><h3>Diagnostics</h3><div class="detail-copy">Terminal: ' + escapeText(payload.diag.terminalMode || 'unknown') + ' · Mode: ' + escapeText(payload.diag.session.operationMode || 'safe') + ' · Lock: ' + escapeText(payload.diag.session.inputLock || 'none') + '</div><pre class="history-view">' + escapeText(payload.history.view || '(no history yet)') + '</pre></section>' +
    renderRuleEditor(sessionId, payload.policyPayload);
}
async function refreshOpenDetails() {
  const openShells = Array.from(document.querySelectorAll('.detail-shell[data-open="true"]'));
  for (const shell of openShells) {
    const sessionId = shell.id.replace('detail-', '');
    const state = detailMeta(sessionId);
    if (state.dirty) {
      continue;
    }
    const activeElement = document.activeElement;
    if (activeElement && shell.contains(activeElement)) {
      continue;
    }
    try {
      const payload = await fetchDetailPayload(sessionId);
      shell.innerHTML = renderDetailContent(sessionId, payload);
      shell.dataset.open = 'true';
    } catch {
      // keep current content
    }
  }
}
async function openDetails(sessionId) {
  const shell = qs('detail-' + sessionId);
  if (!shell) return;
  const state = detailMeta(sessionId);
  const button = document.querySelector('[data-action="details"][data-session="' + CSS.escape(sessionId) + '"]');
  if (shell.dataset.open === 'true') {
    shell.dataset.open = 'false';
    shell.innerHTML = '';
    state.open = false;
    state.dirty = false;
    if (button) button.textContent = 'Details';
    return;
  }
  shell.dataset.open = 'true';
  state.open = true;
  state.dirty = false;
  if (button) button.textContent = 'Hide';
  shell.innerHTML = '<div class="detail-loading">Loading…</div>';
  try {
    const payload = await fetchDetailPayload(sessionId);
    shell.innerHTML = renderDetailContent(sessionId, payload);
  } catch (error) {
    shell.innerHTML = '<div class="detail-error">Failed to load details: ' + escapeText(error.message) + '</div>';
  }
}
function updateRuleField(target) {
  const sessionId = target.getAttribute('data-session');
  const index = Number(target.getAttribute('data-rule-index'));
  const field = target.getAttribute('data-field');
  if (!sessionRules[sessionId] || !sessionRules[sessionId][index] || !field) return;
  sessionRules[sessionId][index][field] = target.type === 'checkbox' ? target.checked : target.value;
  markDetailDirty(sessionId, true);
}
function rerenderRuleList(sessionId) {
  const listEl = qs('rule-list-' + sessionId);
  if (!listEl || !sessionRules[sessionId]) return;
  listEl.innerHTML = sessionRules[sessionId].map((rule, index) => renderRuleRow(sessionId, rule, index)).join('');
}
function addRule(sessionId) {
  sessionRules[sessionId] = sortRules([...(sessionRules[sessionId] || []), {
    id: 'rule-' + Date.now(),
    enabled: true,
    pattern: '',
    flags: '',
    priority: (sessionRules[sessionId] || []).length,
    mode: 'safe',
    category: 'dangerous',
    action: 'error',
    message: '',
    suggestion: '',
  }]);
  markDetailDirty(sessionId, true);
  rerenderRuleList(sessionId);
}
function deleteRule(sessionId, index) {
  if (!sessionRules[sessionId]) return;
  sessionRules[sessionId].splice(index, 1);
  sessionRules[sessionId] = reindexRules(sessionRules[sessionId]);
  markDetailDirty(sessionId, true);
  rerenderRuleList(sessionId);
}
async function saveRules(sessionId) {
  try {
    const payload = {
      rules: sortRules(sessionRules[sessionId] || []),
    };
    const response = await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    sessionRules[sessionId] = sortRules(response.activeRules || []);
    markDetailDirty(sessionId, false);
    const shell = qs('detail-' + sessionId);
    if (shell) {
      const detailPayload = await fetchDetailPayload(sessionId);
      shell.innerHTML = renderDetailContent(sessionId, detailPayload);
      shell.dataset.open = 'true';
    } else {
      rerenderRuleList(sessionId);
    }
    qs('globalNotice').textContent = 'Rules saved for ' + sessionId + '.';
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to save rules: ' + error.message;
  }
}
async function switchMode(sessionId) {
  try {
    const payload = await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/mode');
    const current = payload.operationMode === 'full' ? 'full' : 'safe';
    const next = current === 'safe' ? 'full' : 'safe';
    await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ mode: next }),
    });
    qs('globalNotice').textContent = 'Session ' + sessionId + ' mode switched to ' + next + '.';
    refreshAll();
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to switch mode: ' + error.message;
  }
}
async function closeSession(sessionId) {
  if (!window.confirm('Close this session?')) return;
  try {
    await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/close', { method: 'POST' });
    delete detailState[sessionId];
    refreshAll();
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to close session: ' + error.message;
  }
}
async function createLocalSession() {
  try {
    await fetchJson('/api/sessions', { method: 'POST' });
    refreshAll();
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to create local session: ' + error.message;
  }
}
async function sendAgentCommand(sessionId) {
  const input = qs('agent-input-' + sessionId);
  const command = input && 'value' in input ? String(input.value || '').trim() : '';
  if (!command) {
    return;
  }
  try {
    await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/agent-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ command }),
    });
    if (input && 'value' in input) {
      input.value = '';
    }
    qs('globalNotice').textContent = 'Agent command sent to ' + sessionId + '.';
    refreshAll();
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to run agent command: ' + error.message;
  }
}
async function sendAgentControl(sessionId, key) {
  try {
    await fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ key }),
    });
    qs('globalNotice').textContent = 'Sent ' + key + ' to ' + sessionId + '.';
    refreshAll();
  } catch (error) {
    qs('globalNotice').textContent = 'Failed to send control key: ' + error.message;
  }
}
function cs(sessionId) { void closeSession(sessionId); }
function nls() { void createLocalSession(); }
function td(sessionId) { void openDetails(sessionId); }
function sa(sessionId) { void fetchJson('/api/session/' + encodeURIComponent(sessionId) + '/set-active', { method: 'POST' }).then(refreshAll); }
function sac(sessionId) { void sendAgentCommand(sessionId); }
function sck(sessionId, key) { void sendAgentControl(sessionId, key); }
// function sac() {}
// function sck() {}
document.addEventListener('click', function(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.getAttribute('data-action');
  const sessionId = button.getAttribute('data-session');
  const index = Number(button.getAttribute('data-rule-index'));
  if (action === 'details' && sessionId) { openDetails(sessionId); return; }
  if (action === 'mode' && sessionId) { switchMode(sessionId); return; }
  if (action === 'close' && sessionId) { closeSession(sessionId); return; }
  if (action === 'set-active' && sessionId) { sa(sessionId); return; }
  if (action === 'debug-run' && sessionId) { sendAgentCommand(sessionId); return; }
  if (action === 'debug-control' && sessionId) { sendAgentControl(sessionId, button.getAttribute('data-control')); return; }
  if (action === 'add-rule' && sessionId) { addRule(sessionId); return; }
  if (action === 'delete-rule' && sessionId) { deleteRule(sessionId, index); return; }
  if (action === 'save-rules' && sessionId) { saveRules(sessionId); return; }
  if (action === 'save-viewer-access') { saveViewerAccessPolicy(); return; }
  if (action === 'new-local-session') { createLocalSession(); return; }
});
document.addEventListener('input', function(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  if (target.hasAttribute('data-field')) {
    updateRuleField(target);
    return;
  }
});
document.addEventListener('keydown', function(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const sessionId = target.getAttribute('data-agent-input');
  if (!sessionId) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    sendAgentCommand(sessionId);
  }
});
document.addEventListener('dragstart', function(event) {
  const handle = event.target.closest('[data-drag-handle="true"]');
  if (!handle) return;
  const row = handle.closest('.rule-row');
  if (!row) return;
  ruleDragState = {
    sessionId: row.getAttribute('data-session'),
    index: Number(row.getAttribute('data-rule-index')),
  };
  row.classList.add('dragging');
});
document.addEventListener('dragend', function(event) {
  const row = event.target.closest('.rule-row');
  if (row) row.classList.remove('dragging');
});
document.addEventListener('dragover', function(event) {
  const row = event.target.closest('.rule-row');
  if (!row || !ruleDragState) return;
  event.preventDefault();
});
document.addEventListener('drop', function(event) {
  const row = event.target.closest('.rule-row');
  if (!row || !ruleDragState) return;
  event.preventDefault();
  const sessionId = row.getAttribute('data-session');
  const targetIndex = Number(row.getAttribute('data-rule-index'));
  if (!sessionRules[sessionId] || ruleDragState.sessionId !== sessionId) return;
  const [moved] = sessionRules[sessionId].splice(ruleDragState.index, 1);
  sessionRules[sessionId].splice(targetIndex, 0, moved);
  sessionRules[sessionId] = reindexRules(sessionRules[sessionId]);
  ruleDragState = null;
  markDetailDirty(sessionId, true);
  rerenderRuleList(sessionId);
});
window.addEventListener("pagehide", function() {
  if (refreshTimer) clearTimeout(refreshTimer);
}, { once: true });
renderViewerAccessPanel();
renderSessions(boot.initialSessions);
scheduleRefresh();
`;
}

export function renderViewerHomePage(debug = false) {
  const baseUrl = getViewerBaseUrl() || '';
  return renderViewerDocument({
    title: 'SSH Session MCP Viewer',
    styles: HOME_PAGE_STYLES,
    body: `
  <header class="hero">
    <div>
      <p class="hero-kicker">SSH Session MCP</p>
      <h1>Viewer Control Plane</h1>
      <p class="hero-copy">Manage viewer IP policies, inspect per-session guardrails, and edit command rules without leaving the browser terminal workspace.</p>
    </div>
    <div class="hero-meta">
      <div><span>Viewer</span><strong>${escapeHtml(baseUrl)}</strong></div>
      <div><span>Auto-refresh</span><strong>${DEFAULT_VIEWER_REFRESH_MS}ms</strong></div>
    </div>
  </header>
  <div class="tiny-text">Viewer base URL: <code>${escapeHtml(baseUrl)}</code></div>
  <main class="home-grid">
    <section class="policy-panel">
      <div class="panel-heading">
        <div>
          <h2>Viewer Access Policy</h2>
          <p>Default stays on <code>127.0.0.1</code>. Use IP rules only when you intentionally expose the viewer.</p>
        </div>
        <button class="btn btn-primary" data-action="save-viewer-access">Save Access Policy</button>
      </div>
      <div class="access-form">
        <label>
          <span>Mode</span>
          <select id="viewerAccessMode" class="rule-input short">
            <option value="allow_all">allow_all</option>
            <option value="allowlist">allowlist</option>
            <option value="denylist">denylist</option>
          </select>
        </label>
        <label>
          <span>Allowed IPs</span>
          <textarea id="viewerIpAllowlist" class="rule-textarea" placeholder="One IP per line"></textarea>
        </label>
        <label>
          <span>Denied IPs</span>
          <textarea id="viewerIpDenylist" class="rule-textarea" placeholder="One IP per line"></textarea>
        </label>
        <label>
          <span>Allowed Origins</span>
          <textarea id="viewerAllowedOrigins" class="rule-textarea" placeholder="https://example.com"></textarea>
        </label>
      </div>
      <div class="tiny-text" id="viewerAccessUpdatedAt"></div>
    </section>
    <section class="sessions-panel">
      <div class="panel-heading">
        <div>
          <h2>Sessions</h2>
          <p>Every session now carries its own <code>safe</code>/<code>full</code> mode and its own ordered rule list.</p>
        </div>
        ${LOCAL_MODE ? '<button class="btn" data-action="new-local-session">New Local Session</button>' : ''}
      </div>
      <div id="globalNotice" class="global-notice">Viewer ready.</div>
      <div class="sessions" id="sessions"></div>
    </section>
  </main>`,
    bodyExtras: `<script>\n${buildClientScript(debug, DEFAULT_VIEWER_REFRESH_MS)}\n</script>`,
  });
}
