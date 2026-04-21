import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { z } from 'zod';

import { resolveDefaultConfigPath } from './runtime.js';

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
  defaultDevice: z.string().min(1).optional(),
  devices: z.array(deviceProfileSchema),
}).strict();

export type DeviceDefaults = z.infer<typeof deviceDefaultsSchema>;
export type DeviceAuth = z.infer<typeof deviceAuthSchema>;
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;
export type DeviceConfigFile = z.infer<typeof configSchema>;

export interface LoadedProfiles {
  config: DeviceConfigFile | null;
  path?: string;
  source: 'config' | 'legacy-env';
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function resolveConfigPath(options: {
  argvPath?: string | null;
  cwd: string;
  envPath?: string | undefined;
}) {
  const argvPath = options.argvPath?.trim();
  if (argvPath) {
    return resolvePath(argvPath);
  }

  const envPath = options.envPath?.trim();
  if (envPath) {
    return resolvePath(envPath);
  }

  const defaults = resolveDefaultConfigPath(options.cwd);
  if (existsSync(defaults.cwdConfigPath)) {
    return defaults.cwdConfigPath;
  }

  if (existsSync(defaults.userConfigPath)) {
    return defaults.userConfigPath;
  }

  return undefined;
}

export function loadProfiles(options: {
  argvPath?: string | null;
  cwd: string;
  envPath?: string | undefined;
}): LoadedProfiles {
  const path = resolveConfigPath(options);
  if (!path) {
    return {
      config: null,
      source: 'legacy-env',
    };
  }

  const parsed = configSchema.parse(readJson(path));
  const seenIds = new Set<string>();
  for (const device of parsed.devices) {
    if (seenIds.has(device.id)) {
      throw new Error(`Duplicate device id in config: ${device.id}`);
    }
    seenIds.add(device.id);
  }

  if (parsed.defaultDevice && !parsed.devices.some(device => device.id === parsed.defaultDevice)) {
    throw new Error(`defaultDevice "${parsed.defaultDevice}" does not exist in config`);
  }

  return {
    config: parsed,
    path,
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
