import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import { z } from 'zod';

import { resolveDefaultConfigPath } from './runtime.js';

const runtimeDefaultsSchema = z.object({
  autoOpenTerminal: z.boolean().optional(),
  logDir: z.string().min(1).optional(),
  logMode: z.enum(['off', 'meta']).optional(),
  mode: z.enum(['safe', 'full']).optional(),
  viewerHost: z.string().min(1).optional(),
  viewerMode: z.enum(['browser', 'terminal']).optional(),
  viewerPort: z.union([
    z.literal('auto'),
    z.number().int().min(0).max(65535),
  ]).optional(),
  viewerSingletonScope: z.enum(['connection', 'session']).optional(),
}).strict();

const deviceDefaultsSchema = z.object({
  term: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().nonnegative().optional(),
  closedRetentionMs: z.number().int().nonnegative().optional(),
  autoOpenViewer: z.boolean().optional(),
  viewerMode: z.enum(['browser', 'terminal']).optional(),
}).strict();

const deviceAuthSchema = z.object({
  passwordEnv: z.string().min(1).optional(),
  keyPath: z.string().min(1).optional(),
}).strict();

const deviceProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().positive().optional().default(22),
  user: z.string().min(1),
  auth: deviceAuthSchema.optional(),
  defaults: deviceDefaultsSchema.optional(),
  tags: z.array(z.string().min(1)).optional().default([]),
}).strict();

const configSchema = z.object({
  defaults: runtimeDefaultsSchema.optional(),
  defaultDevice: z.string().min(1).optional(),
  devices: z.array(deviceProfileSchema).optional().default([]),
}).strict();

export type RuntimeDefaults = z.infer<typeof runtimeDefaultsSchema>;
export type DeviceDefaults = z.infer<typeof deviceDefaultsSchema>;
export type DeviceAuth = z.infer<typeof deviceAuthSchema>;
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;
export type DeviceConfigFile = z.infer<typeof configSchema>;

export interface ResolvedConfigFiles {
  explicitPath?: string;
  globalPath: string;
  workspacePath: string;
}

export interface LoadedProfiles {
  config: DeviceConfigFile | null;
  path?: string;
  paths: ResolvedConfigFiles;
  loadedFiles: string[];
  resolution: 'explicit' | 'merged' | 'legacy-env';
  source: 'config' | 'legacy-env';
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function normalizeConfig(config: DeviceConfigFile): DeviceConfigFile {
  return {
    defaults: config.defaults,
    defaultDevice: config.defaultDevice,
    devices: [...config.devices],
  };
}

function validateConfig(config: DeviceConfigFile) {
  const seenIds = new Set<string>();
  for (const device of config.devices) {
    if (seenIds.has(device.id)) {
      throw new Error(`Duplicate device id in config: ${device.id}`);
    }
    seenIds.add(device.id);
  }

  if (config.defaultDevice && !config.devices.some(device => device.id === config.defaultDevice)) {
    throw new Error(`defaultDevice "${config.defaultDevice}" does not exist in config`);
  }
}

function parseConfig(raw: unknown) {
  return normalizeConfig(configSchema.parse(raw));
}

function mergeConfigs(base: DeviceConfigFile, override: DeviceConfigFile): DeviceConfigFile {
  const deviceMap = new Map<string, DeviceProfile>();

  for (const device of base.devices) {
    deviceMap.set(device.id, device);
  }

  for (const device of override.devices) {
    deviceMap.set(device.id, device);
  }

  return normalizeConfig({
    defaults: {
      ...(base.defaults || {}),
      ...(override.defaults || {}),
    },
    defaultDevice: override.defaultDevice ?? base.defaultDevice,
    devices: [...deviceMap.values()],
  });
}

export function emptyConfig(): DeviceConfigFile {
  return {
    devices: [],
  };
}

export function loadConfigFile(path: string) {
  return parseConfig(readJson(path));
}

export function saveConfigFile(path: string, config: DeviceConfigFile) {
  const normalized = parseConfig(config);
  validateConfig(normalized);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}`, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

export function resolveConfigFiles(options: {
  argvPath?: string | null;
  cwd: string;
  envPath?: string | undefined;
}): ResolvedConfigFiles {
  const defaults = resolveDefaultConfigPath(options.cwd);
  const argvPath = options.argvPath?.trim();
  if (argvPath) {
    return {
      explicitPath: resolvePath(argvPath),
      globalPath: defaults.userConfigPath,
      workspacePath: defaults.cwdConfigPath,
    };
  }

  const envPath = options.envPath?.trim();
  if (envPath) {
    return {
      explicitPath: resolvePath(envPath),
      globalPath: defaults.userConfigPath,
      workspacePath: defaults.cwdConfigPath,
    };
  }

  return {
    globalPath: defaults.userConfigPath,
    workspacePath: defaults.cwdConfigPath,
  };
}

export function resolveConfigPath(options: {
  argvPath?: string | null;
  cwd: string;
  envPath?: string | undefined;
}) {
  const files = resolveConfigFiles(options);
  if (files.explicitPath) {
    return files.explicitPath;
  }

  if (existsSync(files.workspacePath)) {
    return files.workspacePath;
  }

  if (existsSync(files.globalPath)) {
    return files.globalPath;
  }

  return undefined;
}

export function loadProfiles(options: {
  argvPath?: string | null;
  cwd: string;
  envPath?: string | undefined;
}): LoadedProfiles {
  const paths = resolveConfigFiles(options);

  if (paths.explicitPath) {
    const config = loadConfigFile(paths.explicitPath);
    validateConfig(config);
    return {
      config,
      path: paths.explicitPath,
      paths,
      loadedFiles: [paths.explicitPath],
      resolution: 'explicit',
      source: 'config',
    };
  }

  const configs: DeviceConfigFile[] = [];
  const loadedFiles: string[] = [];

  if (existsSync(paths.globalPath)) {
    configs.push(loadConfigFile(paths.globalPath));
    loadedFiles.push(paths.globalPath);
  }

  if (existsSync(paths.workspacePath)) {
    configs.push(loadConfigFile(paths.workspacePath));
    loadedFiles.push(paths.workspacePath);
  }

  if (configs.length === 0) {
    return {
      config: null,
      paths,
      loadedFiles: [],
      resolution: 'legacy-env',
      source: 'legacy-env',
    };
  }

  const merged = configs.reduce((current, next) => mergeConfigs(current, next), emptyConfig());
  validateConfig(merged);

  return {
    config: merged,
    path: loadedFiles[loadedFiles.length - 1],
    paths,
    loadedFiles,
    resolution: 'merged',
    source: 'config',
  };
}

export function resolveDeviceProfile(profiles: LoadedProfiles, deviceId: string) {
  if (!profiles.config) {
    return undefined;
  }

  return profiles.config.devices.find(device => device.id === deviceId);
}

export function resolveDefaultDeviceId(profiles: LoadedProfiles) {
  if (!profiles.config) {
    return undefined;
  }

  if (profiles.config.defaultDevice) {
    return profiles.config.defaultDevice;
  }

  if (profiles.config.devices.length === 1) {
    return profiles.config.devices[0].id;
  }

  return undefined;
}

export function summarizeAuth(device: DeviceProfile) {
  if (device.auth?.passwordEnv) {
    return 'passwordEnv';
  }

  if (device.auth?.keyPath) {
    return 'keyPath';
  }

  return 'none';
}
