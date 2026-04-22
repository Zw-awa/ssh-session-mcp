import {
  getViewerBaseUrl,
  resolveSession,
  resolveSessionForBinding,
} from '../server-state.js';
import type { SessionSummary } from '../session.js';
import { renderViewerErrorPage } from './error-page.js';

export interface ViewerPageTarget {
  baseUrl: string;
  footerLabel: string;
  footerValue: string;
  sessionData: SessionSummary;
}

export type ViewerPageTargetResult =
  | { ok: true; target: ViewerPageTarget }
  | { ok: false; html: string };

function renderMissingTargetPage(options: {
  baseUrl: string;
  detail: string;
  footerLabel: string;
  footerValue: string;
  title: string;
}): ViewerPageTargetResult {
  return {
    ok: false,
    html: renderViewerErrorPage(options),
  };
}

export function resolveViewerSessionPageTarget(sessionRef: string): ViewerPageTargetResult {
  const baseUrl = getViewerBaseUrl() || '';

  try {
    return {
      ok: true,
      target: {
        baseUrl,
        footerLabel: 'Session ID',
        footerValue: sessionRef,
        sessionData: resolveSession(sessionRef).summary(),
      },
    };
  } catch {
    return renderMissingTargetPage({
      baseUrl,
      detail: `Session reference: ${sessionRef}`,
      footerLabel: 'Session ID',
      footerValue: sessionRef,
      title: 'Session not found',
    });
  }
}

export function resolveViewerBindingPageTarget(bindingKey: string): ViewerPageTargetResult {
  const baseUrl = getViewerBaseUrl() || '';

  try {
    const { session } = resolveSessionForBinding(bindingKey);

    return {
      ok: true,
      target: {
        baseUrl,
        footerLabel: 'Binding key',
        footerValue: bindingKey,
        sessionData: session.summary(),
      },
    };
  } catch {
    return renderMissingTargetPage({
      baseUrl,
      detail: `Binding key: ${bindingKey}`,
      footerLabel: 'Binding key',
      footerValue: bindingKey,
      title: 'Binding not found',
    });
  }
}

export function formatViewerConnectionMeta(sessionData: SessionSummary) {
  return `${sessionData.user}@${sessionData.host}:${sessionData.port}`;
}

export function formatViewerActivityMeta(sessionData: SessionSummary, extraLines: string[] = []) {
  const lines = [
    formatViewerConnectionMeta(sessionData),
    ...extraLines,
    `Created: ${new Date(sessionData.createdAt).toLocaleString()}`,
    `Last activity: ${new Date(sessionData.updatedAt).toLocaleString()}`,
  ];

  return lines.join('\n');
}
