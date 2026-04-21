import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadProfiles,
  resolveConfigFiles,
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

  it('merges global and workspace configs, with workspace replacing matching devices by id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-merged-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'ssh-mcp-config-root-'));
    const originalAppData = process.env.APPDATA;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.APPDATA = configRoot;
    process.env.XDG_CONFIG_HOME = configRoot;

    try {
      const paths = resolveConfigFiles({ cwd: dir });

      writeFileSync(paths.globalPath, JSON.stringify({
        defaults: {
          viewerHost: '127.0.0.1',
          viewerPort: 'auto',
          viewerMode: 'browser',
          viewerSingletonScope: 'connection',
          autoOpenTerminal: false,
          mode: 'safe',
          logMode: 'meta',
        },
        defaultDevice: 'board-b',
        devices: [
          {
            id: 'board-a',
            label: 'Global Board A',
            host: '192.168.10.58',
            user: 'orangepi',
            auth: { passwordEnv: 'BOARD_A_PASSWORD' },
            tags: ['global'],
          },
          {
            id: 'board-b',
            host: '192.168.10.59',
            user: 'orangepi',
          },
        ],
      }, null, 2), 'utf8');

      writeFileSync(paths.workspacePath, JSON.stringify({
        defaults: {
          viewerMode: 'terminal',
          viewerSingletonScope: 'session',
        },
        defaultDevice: 'board-a',
        devices: [
          {
            id: 'board-a',
            host: '192.168.10.60',
            user: 'root',
            tags: ['workspace'],
          },
        ],
      }, null, 2), 'utf8');

      const loaded = loadProfiles({ cwd: dir });

      expect(loaded.source).toBe('config');
      expect(loaded.resolution).toBe('merged');
      expect(loaded.loadedFiles).toEqual([paths.globalPath, paths.workspacePath]);
      expect(loaded.config?.defaults?.viewerMode).toBe('terminal');
      expect(loaded.config?.defaults?.viewerHost).toBe('127.0.0.1');
      expect(loaded.config?.defaults?.viewerSingletonScope).toBe('session');
      expect(resolveDefaultDeviceId(loaded)).toBe('board-a');
      expect(resolveDeviceProfile(loaded, 'board-a')).toEqual({
        id: 'board-a',
        host: '192.168.10.60',
        port: 22,
        user: 'root',
        tags: ['workspace'],
      });
      expect(resolveDeviceProfile(loaded, 'board-b')?.host).toBe('192.168.10.59');
    } finally {
      process.env.APPDATA = originalAppData;
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it('uses explicit config instead of merged global and workspace files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-explicit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'ssh-mcp-config-root-'));
    const explicitPath = join(dir, 'explicit.json');
    const originalAppData = process.env.APPDATA;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

    process.env.APPDATA = configRoot;
    process.env.XDG_CONFIG_HOME = configRoot;

    try {
      const paths = resolveConfigFiles({ cwd: dir });

      writeFileSync(paths.globalPath, JSON.stringify({
        defaultDevice: 'ignored-global',
        devices: [{ id: 'ignored-global', host: '10.0.0.1', user: 'global' }],
      }, null, 2), 'utf8');

      writeFileSync(paths.workspacePath, JSON.stringify({
        defaultDevice: 'ignored-workspace',
        devices: [{ id: 'ignored-workspace', host: '10.0.0.2', user: 'workspace' }],
      }, null, 2), 'utf8');

      writeFileSync(explicitPath, JSON.stringify({
        defaultDevice: 'explicit-board',
        devices: [{ id: 'explicit-board', host: '10.0.0.3', user: 'explicit' }],
      }, null, 2), 'utf8');

      const loaded = loadProfiles({ cwd: dir, argvPath: explicitPath });

      expect(loaded.resolution).toBe('explicit');
      expect(loaded.loadedFiles).toEqual([explicitPath]);
      expect(resolveDefaultDeviceId(loaded)).toBe('explicit-board');
      expect(resolveDeviceProfile(loaded, 'ignored-global')).toBeUndefined();
      expect(resolveDeviceProfile(loaded, 'explicit-board')?.host).toBe('10.0.0.3');
    } finally {
      process.env.APPDATA = originalAppData;
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });
});
