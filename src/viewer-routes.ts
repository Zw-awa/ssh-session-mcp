export type ViewerAttachKind = 'session' | 'binding';
export type ViewerAttachSuffix = '' | '/input' | '/resize';

export type ViewerHttpRoute =
  | { type: 'health' }
  | { type: 'sessions-api' }
  | { type: 'attach-read'; kind: ViewerAttachKind; ref: string }
  | { type: 'attach-input'; kind: ViewerAttachKind; ref: string }
  | { type: 'attach-resize'; kind: ViewerAttachKind; ref: string }
  | { type: 'session-api'; sessionRef: string }
  | { type: 'viewer-binding-api'; bindingKey: string }
  | { type: 'terminal-session-page'; sessionRef: string }
  | { type: 'terminal-binding-page'; bindingKey: string }
  | { type: 'legacy-session-page'; sessionRef: string }
  | { type: 'legacy-binding-page'; bindingKey: string }
  | { type: 'home-page' }
  | { type: 'not-found' };

export interface ViewerWsRoute {
  kind: ViewerAttachKind;
  ref: string;
}

const ATTACH_PREFIXES: Record<ViewerAttachKind, string> = {
  binding: '/api/attach/binding/',
  session: '/api/attach/session/',
};

export function tryMatchAttachRoute(pathname: string, kind: ViewerAttachKind, suffix: ViewerAttachSuffix) {
  const prefix = ATTACH_PREFIXES[kind];
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }

  const rest = pathname.slice(prefix.length);
  if (!rest) {
    return undefined;
  }

  if (!suffix) {
    if (rest.endsWith('/input') || rest.endsWith('/resize')) {
      return undefined;
    }

    return decodeURIComponent(rest);
  }

  if (!rest.endsWith(suffix)) {
    return undefined;
  }

  return decodeURIComponent(rest.slice(0, -suffix.length));
}

export function matchViewerHttpRoute(method: string | undefined, pathname: string): ViewerHttpRoute {
  const normalizedMethod = method?.toUpperCase();

  if (pathname === '/health') {
    return { type: 'health' };
  }

  if (pathname === '/api/sessions') {
    return { type: 'sessions-api' };
  }

  for (const kind of ['session', 'binding'] as const) {
    if (normalizedMethod === 'GET') {
      const attachReadRef = tryMatchAttachRoute(pathname, kind, '');
      if (attachReadRef) {
        return { type: 'attach-read', kind, ref: attachReadRef };
      }
    }

    if (normalizedMethod === 'POST') {
      const attachInputRef = tryMatchAttachRoute(pathname, kind, '/input');
      if (attachInputRef) {
        return { type: 'attach-input', kind, ref: attachInputRef };
      }

      const attachResizeRef = tryMatchAttachRoute(pathname, kind, '/resize');
      if (attachResizeRef) {
        return { type: 'attach-resize', kind, ref: attachResizeRef };
      }
    }
  }

  if (pathname.startsWith('/api/session/')) {
    return {
      type: 'session-api',
      sessionRef: decodeURIComponent(pathname.slice('/api/session/'.length)),
    };
  }

  if (pathname.startsWith('/api/viewer-binding/')) {
    return {
      type: 'viewer-binding-api',
      bindingKey: decodeURIComponent(pathname.slice('/api/viewer-binding/'.length)),
    };
  }

  if (pathname.startsWith('/terminal/session/')) {
    return {
      type: 'terminal-session-page',
      sessionRef: decodeURIComponent(pathname.slice('/terminal/session/'.length)),
    };
  }

  if (pathname.startsWith('/terminal/binding/')) {
    return {
      type: 'terminal-binding-page',
      bindingKey: decodeURIComponent(pathname.slice('/terminal/binding/'.length)),
    };
  }

  if (pathname.startsWith('/session/')) {
    return {
      type: 'legacy-session-page',
      sessionRef: decodeURIComponent(pathname.slice('/session/'.length)),
    };
  }

  if (pathname.startsWith('/binding/')) {
    return {
      type: 'legacy-binding-page',
      bindingKey: decodeURIComponent(pathname.slice('/binding/'.length)),
    };
  }

  if (pathname === '/' || pathname === '/index.html') {
    return { type: 'home-page' };
  }

  return { type: 'not-found' };
}

export function matchViewerWsRoute(pathname: string): ViewerWsRoute | null {
  const sessionMatch = pathname.match(/^\/ws\/attach\/session\/(.+)$/);
  if (sessionMatch) {
    return {
      kind: 'session',
      ref: decodeURIComponent(sessionMatch[1]),
    };
  }

  const bindingMatch = pathname.match(/^\/ws\/attach\/binding\/(.+)$/);
  if (bindingMatch) {
    return {
      kind: 'binding',
      ref: decodeURIComponent(bindingMatch[1]),
    };
  }

  return null;
}
