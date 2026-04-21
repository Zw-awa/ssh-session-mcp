import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadProfiles,
  resolveDefaultDeviceId,
  resolveDeviceProfile,
  summarizeAuth,
} from '../src/profiles';

describe('profile config helpers', () => {
  it('loads devices from an explicit config path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-'));
    const configPath = join(dir, 'ssh-session-mcp.config.json');
    writeFileSync(configPath, JSON.stringify({
      defaultDevice: 'board-a',
      devices: [
        {
          id: 'board-a',
          host: '192.168.10.58',
          port: 22,
          user: 'orangepi',
          auth: { passwordEnv: 'BOARD_A_PASSWORD' },
          defaults: { viewerMode: 'browser', autoOpenViewer: true },
        },
        {
          id: 'board-b',
          host: '192.168.10.59',
          user: 'orangepi',
          auth: { keyPath: '/tmp/id_rsa' },
        },
      ],
    }, null, 2), 'utf8');

    const loaded = loadProfiles({
      argvPath: configPath,
      cwd: dir,
    });

    expect(loaded.source).toBe('config');
    expect(loaded.path).toBe(configPath);
    expect(resolveDefaultDeviceId(loaded)).toBe('board-a');
    expect(resolveDeviceProfile(loaded, 'board-b')?.host).toBe('192.168.10.59');
    expect(summarizeAuth(resolveDeviceProfile(loaded, 'board-a')!)).toBe('passwordEnv');
    expect(summarizeAuth(resolveDeviceProfile(loaded, 'board-b')!)).toBe('keyPath');
  });

  it('falls back to legacy-env mode when no config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-empty-'));
    const loaded = loadProfiles({ cwd: dir });

    expect(loaded.source).toBe('legacy-env');
    expect(loaded.config).toBeNull();
    expect(resolveDefaultDeviceId(loaded)).toBeUndefined();
  });
});
