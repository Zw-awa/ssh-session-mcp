/*
 * SPDX-FileCopyrightText: 2026 Zw-awa
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimePaths {
  instanceId: string;
  rootDir: string;
  instanceDir: string;
  logDir: string;
  serverInfoFile: string;
  viewerAccessFile: string;
  viewerStateFile: string;
}

export interface ViewerPortSetting {
  enabled: boolean;
  mode: 'auto' | 'disabled' | 'fixed';
  port?: number;
  raw: string;
}

function sanitizeLabel(raw: string, fallback: string) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  return trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80) || fallback;
}

export function resolveInstanceId(raw: string | undefined) {
  return sanitizeLabel(raw || '', `proc-${process.pid}`);
}

function windowsConfigRoot() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

function windowsStateRoot() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

function unixConfigRoot() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function unixStateRoot() {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

function normalizeOptionalPath(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }

  return resolvePath(trimmed);
}

export function getUserConfigDir() {
  return process.platform === 'win32'
    ? join(windowsConfigRoot(), 'ssh-session-mcp')
    : join(unixConfigRoot(), 'ssh-session-mcp');
}

export function getUserStateDir() {
  return process.platform === 'win32'
    ? join(windowsStateRoot(), 'ssh-session-mcp')
    : join(unixStateRoot(), 'ssh-session-mcp');
}

export function resolveStateRootDir(override: string | undefined) {
  return normalizeOptionalPath(override) || getUserStateDir();
}

export function resolveRuntimePaths(instanceId: string, stateRootOverride?: string): RuntimePaths {
  const safeInstanceId = resolveInstanceId(instanceId);
  const rootDir = resolveStateRootDir(stateRootOverride);
  const instanceDir = join(rootDir, 'instances', safeInstanceId);
  return {
    instanceId: safeInstanceId,
    rootDir,
    instanceDir,
    logDir: join(instanceDir, 'logs'),
    serverInfoFile: join(instanceDir, 'server-info.json'),
    viewerAccessFile: join(instanceDir, 'viewer-access.json'),
    viewerStateFile: join(instanceDir, '.viewer-processes.json'),
  };
}

export function resolveDefaultConfigPath(cwd: string) {
  return {
    cwdConfigPath: join(cwd, 'ssh-session-mcp.config.json'),
    userConfigPath: join(getUserConfigDir(), 'config.json'),
  };
}

export function resolveRepoRootFromModule(metaUrl: string) {
  return resolvePath(dirname(fileURLToPath(metaUrl)), '..');
}

export function readOptionalSecretFile(pathRaw: string | undefined, envName: string) {
  const resolvedPath = normalizeOptionalPath(pathRaw);
  if (!resolvedPath) {
    return undefined;
  }

  try {
    return readFileSync(resolvedPath, 'utf8').replace(/[\r\n]+$/, '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${envName} from ${resolvedPath}: ${message}`);
  }
}

export function resolveEnvValueOrFile(envName: string) {
  const directValue = process.env[envName]?.trim();
  if (directValue) {
    return directValue;
  }

  return readOptionalSecretFile(process.env[`${envName}_FILE`], `${envName}_FILE`);
}

export function resolveViewerPortSetting(raw: string | undefined): ViewerPortSetting {
  const normalized = (raw || '0').trim().toLowerCase();

  if (normalized === 'auto') {
    return {
      enabled: true,
      mode: 'auto',
      raw: 'auto',
    };
  }

  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric === 0) {
    return {
      enabled: false,
      mode: 'disabled',
      raw: normalized,
    };
  }

  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 65535) {
    return {
      enabled: true,
      mode: 'fixed',
      port: numeric,
      raw: normalized,
    };
  }

  throw new Error('Invalid VIEWER_PORT. Use 0, auto, or an integer between 1 and 65535.');
}
