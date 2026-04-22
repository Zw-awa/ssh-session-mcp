import { describe, expect, it } from 'vitest';

import {
  matchViewerHttpRoute,
  matchViewerWsRoute,
  tryMatchAttachRoute,
} from '../src/viewer-routes.js';

describe('viewer routes', () => {
  it('matches attach routes without confusing base reads and suffix actions', () => {
    expect(tryMatchAttachRoute('/api/attach/session/demo-session', 'session', '')).toBe('demo-session');
    expect(tryMatchAttachRoute('/api/attach/session/demo-session/input', 'session', '')).toBeUndefined();
    expect(tryMatchAttachRoute('/api/attach/session/demo-session/input', 'session', '/input')).toBe('demo-session');
    expect(tryMatchAttachRoute('/api/attach/binding/demo-binding/resize', 'binding', '/resize')).toBe('demo-binding');
  });

  it('matches HTTP API and page routes with decoded refs', () => {
    expect(matchViewerHttpRoute('GET', '/health')).toEqual({ type: 'health' });
    expect(matchViewerHttpRoute('GET', '/api/sessions')).toEqual({ type: 'sessions-api' });
    expect(matchViewerHttpRoute('GET', '/api/attach/session/demo%20session')).toEqual({
      type: 'attach-read',
      kind: 'session',
      ref: 'demo session',
    });
    expect(matchViewerHttpRoute('POST', '/api/attach/binding/demo-binding/input')).toEqual({
      type: 'attach-input',
      kind: 'binding',
      ref: 'demo-binding',
    });
    expect(matchViewerHttpRoute('POST', '/api/attach/session/demo-session/resize')).toEqual({
      type: 'attach-resize',
      kind: 'session',
      ref: 'demo-session',
    });
    expect(matchViewerHttpRoute('GET', '/terminal/session/demo')).toEqual({
      type: 'terminal-session-page',
      sessionRef: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/terminal/binding/demo')).toEqual({
      type: 'terminal-binding-page',
      bindingKey: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/session/demo')).toEqual({
      type: 'legacy-session-page',
      sessionRef: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/binding/demo')).toEqual({
      type: 'legacy-binding-page',
      bindingKey: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/api/session/demo')).toEqual({
      type: 'session-api',
      sessionRef: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/api/viewer-binding/demo')).toEqual({
      type: 'viewer-binding-api',
      bindingKey: 'demo',
    });
    expect(matchViewerHttpRoute('GET', '/')).toEqual({ type: 'home-page' });
    expect(matchViewerHttpRoute('GET', '/missing')).toEqual({ type: 'not-found' });
  });

  it('matches websocket attach routes and rejects unrelated paths', () => {
    expect(matchViewerWsRoute('/ws/attach/session/demo%20session')).toEqual({
      kind: 'session',
      ref: 'demo session',
    });
    expect(matchViewerWsRoute('/ws/attach/binding/demo-binding')).toEqual({
      kind: 'binding',
      ref: 'demo-binding',
    });
    expect(matchViewerWsRoute('/ws/other/demo')).toBeNull();
  });
});
