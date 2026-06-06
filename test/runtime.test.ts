import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveEnvValueOrFile,
  resolveInstanceId,
  resolveRuntimePaths,
  resolveStateRootDir,
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

  it('supports overriding the runtime state root', () => {
    const paths = resolveRuntimePaths('agent-a', './tmp/state-root');

    expect(resolveStateRootDir('./tmp/state-root')).toContain('tmp');
    expect(paths.rootDir).toContain('tmp');
    expect(paths.instanceDir).toContain('state-root');
  });

  it('supports fixed, auto, and disabled viewer ports', () => {
    expect(resolveViewerPortSetting('auto')).toMatchObject({ enabled: true, mode: 'auto' });
    expect(resolveViewerPortSetting('0')).toMatchObject({ enabled: false, mode: 'disabled' });
    expect(resolveViewerPortSetting('8793')).toMatchObject({ enabled: true, mode: 'fixed', port: 8793 });
  });

  it('resolves secrets from direct env vars or *_FILE companions', () => {
    const previousPassword = process.env.SSH_PASSWORD;
    const previousPasswordFile = process.env.SSH_PASSWORD_FILE;

    const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-runtime-'));
    const secretFile = join(dir, 'password.txt');
    writeFileSync(secretFile, 'secret-from-file\n', 'utf8');

    try {
      delete process.env.SSH_PASSWORD;
      process.env.SSH_PASSWORD_FILE = secretFile;

      expect(resolveEnvValueOrFile('SSH_PASSWORD')).toBe('secret-from-file');
    } finally {
      if (previousPassword === undefined) delete process.env.SSH_PASSWORD; else process.env.SSH_PASSWORD = previousPassword;
      if (previousPasswordFile === undefined) delete process.env.SSH_PASSWORD_FILE; else process.env.SSH_PASSWORD_FILE = previousPasswordFile;
    }
  });
});
