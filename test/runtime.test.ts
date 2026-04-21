import { describe, expect, it } from 'vitest';

import {
  resolveInstanceId,
  resolveRuntimePaths,
  resolveViewerPortSetting,
} from '../src/runtime';

describe('runtime helpers', () => {
  it('sanitizes instance ids for filesystem-safe paths', () => {
    expect(resolveInstanceId(' codex / board:a ')).toBe('codex-board-a');
  });

  it('builds per-instance runtime paths', () => {
    const paths = resolveRuntimePaths('agent-a');

    expect(paths.instanceId).toBe('agent-a');
    expect(paths.instanceDir).toContain('instances');
    expect(paths.instanceDir).toContain('agent-a');
    expect(paths.serverInfoFile).toContain('server-info.json');
    expect(paths.viewerStateFile).toContain('.viewer-processes.json');
  });

  it('supports fixed, auto, and disabled viewer ports', () => {
    expect(resolveViewerPortSetting('auto')).toMatchObject({ enabled: true, mode: 'auto' });
    expect(resolveViewerPortSetting('0')).toMatchObject({ enabled: false, mode: 'disabled' });
    expect(resolveViewerPortSetting('8793')).toMatchObject({ enabled: true, mode: 'fixed', port: 8793 });
  });
});
