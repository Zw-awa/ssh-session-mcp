import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  loadConfigFile,
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
      defaultDevice: 'DEVICE_A_ID',
      devices: [
        {
          id: 'DEVICE_A_ID',
          host: 'DEVICE_A_HOST',
          port: 22,
          user: 'remote-user',
          auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
          defaults: { viewerMode: 'browser', autoOpenViewer: true },
        },
        {
          id: 'DEVICE_B_ID',
          host: 'DEVICE_B_HOST',
          user: 'remote-user',
          auth: { keyPath: '/tmp/id_rsa' },
        },
      ],
      policyRules: [
        {
          id: 'block-kubectl-delete',
          pattern: '\\bkubectl\\s+delete\\b',
          mode: 'safe',
          category: 'dangerous',
          action: 'block',
          message: 'kubectl delete is blocked in safe mode',
        },
      ],
    }, null, 2), 'utf8');

    const loaded = loadProfiles({
      argvPath: configPath,
      cwd: dir,
    });

    expect(loaded.source).toBe('config');
    expect(loaded.path).toBe(configPath);
    expect(resolveDefaultDeviceId(loaded)).toBe('DEVICE_A_ID');
    expect(resolveDeviceProfile(loaded, 'DEVICE_B_ID')?.host).toBe('DEVICE_B_HOST');
    expect(summarizeAuth(resolveDeviceProfile(loaded, 'DEVICE_A_ID')!)).toBe('passwordEnv');
    expect(summarizeAuth(resolveDeviceProfile(loaded, 'DEVICE_B_ID')!)).toBe('keyPath');
    expect(loaded.config?.policyRules).toHaveLength(1);
    expect(loaded.config?.policyRules[0].id).toBe('block-kubectl-delete');
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

      mkdirSync(dirname(paths.globalPath), { recursive: true });
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
        defaultDevice: 'DEVICE_B_ID',
        devices: [
          {
            id: 'DEVICE_A_ID',
            label: 'DEVICE_A_LABEL',
            host: 'DEVICE_A_HOST',
            user: 'remote-user',
            auth: { passwordEnv: 'DEVICE_A_PASSWORD' },
            tags: ['global'],
          },
          {
            id: 'DEVICE_B_ID',
            host: 'DEVICE_B_HOST',
            user: 'remote-user',
          },
        ],
      }, null, 2), 'utf8');

      writeFileSync(paths.workspacePath, JSON.stringify({
        defaults: {
          viewerMode: 'terminal',
          viewerSingletonScope: 'session',
        },
        defaultDevice: 'DEVICE_A_ID',
        devices: [
          {
            id: 'DEVICE_A_ID',
            host: 'DEVICE_A_OVERRIDE_HOST',
            user: 'root',
            tags: ['workspace'],
          },
        ],
        policyRules: [
          {
            id: 'block-global-rule',
            pattern: '\\brm\\s+-rf\\b',
            mode: 'safe',
            category: 'dangerous',
            action: 'warn',
            message: 'workspace override',
          },
          {
            id: 'block-workspace-only',
            pattern: '\\bsystemctl\\s+restart\\b',
            mode: 'safe',
            category: 'dangerous',
            action: 'block',
            message: 'systemctl restart blocked',
          },
        ],
      }, null, 2), 'utf8');

      const globalWithPolicies = JSON.parse(readFileSync(paths.globalPath, 'utf8'));
      globalWithPolicies.policyRules = [
        {
          id: 'block-global-rule',
          pattern: '\\brm\\s+-rf\\b',
          mode: 'safe',
          category: 'dangerous',
          action: 'block',
          message: 'global rule',
        },
      ];
      writeFileSync(paths.globalPath, JSON.stringify(globalWithPolicies, null, 2), 'utf8');

      const loaded = loadProfiles({ cwd: dir });

      expect(loaded.source).toBe('config');
      expect(loaded.resolution).toBe('merged');
      expect(loaded.loadedFiles).toEqual([paths.globalPath, paths.workspacePath]);
      expect(loaded.config?.defaults?.viewerMode).toBe('terminal');
      expect(loaded.config?.defaults?.viewerHost).toBe('127.0.0.1');
      expect(loaded.config?.defaults?.viewerSingletonScope).toBe('session');
      expect(resolveDefaultDeviceId(loaded)).toBe('DEVICE_A_ID');
      expect(resolveDeviceProfile(loaded, 'DEVICE_A_ID')).toEqual({
        id: 'DEVICE_A_ID',
        host: 'DEVICE_A_OVERRIDE_HOST',
        port: 22,
        user: 'root',
        tags: ['workspace'],
      });
      expect(resolveDeviceProfile(loaded, 'DEVICE_B_ID')?.host).toBe('DEVICE_B_HOST');
      expect(loaded.config?.policyRules.map(rule => rule.id).sort()).toEqual([
        'block-global-rule',
        'block-workspace-only',
      ]);
      expect(loaded.config?.policyRules.find(rule => rule.id === 'block-global-rule')?.action).toBe('warn');
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

      mkdirSync(dirname(paths.globalPath), { recursive: true });
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

  it('rejects duplicate policy rule ids in config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-duplicate-policy-'));
    const configPath = join(dir, 'ssh-session-mcp.config.json');
    writeFileSync(configPath, JSON.stringify({
      policyRules: [
        {
          id: 'duplicate',
          pattern: '\\bkubectl\\s+delete\\b',
          mode: 'safe',
          category: 'dangerous',
          action: 'block',
          message: 'first',
        },
        {
          id: 'duplicate',
          pattern: '\\bterraform\\s+apply\\b',
          mode: 'safe',
          category: 'dangerous',
          action: 'warn',
          message: 'second',
        },
      ],
    }, null, 2), 'utf8');

    expect(() => loadProfiles({ argvPath: configPath, cwd: dir })).toThrow(/Duplicate policy rule id/);
  });

  it('rejects invalid policy regex in config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-invalid-policy-'));
    const configPath = join(dir, 'ssh-session-mcp.config.json');
    writeFileSync(configPath, JSON.stringify({
      policyRules: [
        {
          id: 'bad-regex',
          pattern: '(',
          mode: 'safe',
          category: 'dangerous',
          action: 'block',
          message: 'broken regex',
        },
      ],
    }, null, 2), 'utf8');

    expect(() => loadProfiles({ argvPath: configPath, cwd: dir })).toThrow(/Invalid policy regex/);
  });
});
