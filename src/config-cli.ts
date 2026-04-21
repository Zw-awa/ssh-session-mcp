#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import {
  emptyConfig,
  loadConfigFile,
  loadProfiles,
  resolveConfigFiles,
  saveConfigFile,
  type DeviceConfigFile,
  type DeviceProfile,
  type RuntimeDefaults,
} from './profiles.js';

type Scope = 'workspace' | 'global' | 'merged';
type DeviceViewerMode = NonNullable<DeviceProfile['defaults']>['viewerMode'];

function printUsage() {
  console.log(`Usage:
  ssh-session-mcp config path
  ssh-session-mcp config show [--scope=workspace|global|merged] [--config=path]
  ssh-session-mcp config device list [--scope=workspace|global|merged] [--config=path]
  ssh-session-mcp config device get <id> [--scope=workspace|global|merged] [--config=path]
  ssh-session-mcp config device set <id> --host=<host> --user=<user> [--port=22] [--label=...] [--password-env=ENV] [--key-path=PATH] [--tag=...] [--term=...] [--cols=120] [--rows=40] [--idle-timeout-ms=...] [--closed-retention-ms=...] [--auto-open-viewer=true|false] [--viewer-mode=browser|terminal] [--scope=workspace|global] [--config=path]
  ssh-session-mcp config device remove <id> [--scope=workspace|global] [--config=path]
  ssh-session-mcp config default-device set <id> [--scope=workspace|global] [--config=path]
  ssh-session-mcp config default-device clear [--scope=workspace|global] [--config=path]
  ssh-session-mcp config defaults show [--scope=workspace|global|merged] [--config=path]
  ssh-session-mcp config defaults set <key> <value> [--scope=workspace|global] [--config=path]
  ssh-session-mcp config defaults unset <key> [--scope=workspace|global] [--config=path]
`);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgv(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();

  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }

    const equalIndex = raw.indexOf('=');
    const key = raw.slice(2, equalIndex === -1 ? undefined : equalIndex);
    const value = equalIndex === -1 ? 'true' : raw.slice(equalIndex + 1);
    const values = flags.get(key) || [];
    values.push(value);
    flags.set(key, values);
  }

  return {
    positional,
    getFlag(name: string) {
      return flags.get(name)?.[flags.get(name)!.length - 1];
    },
    getFlags(name: string) {
      return flags.get(name) || [];
    },
    hasFlag(name: string) {
      return flags.has(name);
    },
  };
}

function parseScope(raw: string | undefined, forWrite: boolean): Scope {
  const value = (raw || (forWrite ? 'workspace' : 'merged')).trim().toLowerCase();
  if (value === 'workspace' || value === 'global' || value === 'merged') {
    if (forWrite && value === 'merged') {
      fail('merged scope is read-only; use workspace, global, or --config=<path>');
    }
    return value;
  }

  fail(`Invalid scope: ${raw}`);
}

function parseBoolean(raw: string | undefined, name: string) {
  if (raw === undefined) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  fail(`Invalid ${name}: expected true/false`);
}

function parseOptionalPositiveInt(raw: string | undefined, name: string) {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`Invalid ${name}: expected a positive integer`);
  }

  return parsed;
}

function parseOptionalNonNegativeInt(raw: string | undefined, name: string) {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`Invalid ${name}: expected a non-negative integer`);
  }

  return parsed;
}

function resolveReadConfig(explicitPath: string | undefined, scope: Scope, cwd: string) {
  if (explicitPath) {
    return loadProfiles({ argvPath: explicitPath, cwd }).config || emptyConfig();
  }

  if (scope === 'merged') {
    return loadProfiles({ cwd }).config || emptyConfig();
  }

  const files = resolveConfigFiles({ cwd });
  const path = scope === 'workspace' ? files.workspacePath : files.globalPath;
  return existsSync(path) ? loadConfigFile(path) : emptyConfig();
}

function resolveWritePath(explicitPath: string | undefined, scope: Scope, cwd: string) {
  if (explicitPath) {
    return explicitPath;
  }

  const files = resolveConfigFiles({ cwd });
  return scope === 'global' ? files.globalPath : files.workspacePath;
}

function resolveWriteConfig(explicitPath: string | undefined, scope: Scope, cwd: string) {
  const path = resolveWritePath(explicitPath, scope, cwd);
  const config = existsSync(path) ? loadConfigFile(path) : emptyConfig();
  return { config, path };
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function sortConfig(config: DeviceConfigFile): DeviceConfigFile {
  return {
    defaults: config.defaults,
    defaultDevice: config.defaultDevice,
    devices: [...config.devices].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function upsertDevice(config: DeviceConfigFile, device: DeviceProfile) {
  const devices = [...config.devices];
  const index = devices.findIndex(candidate => candidate.id === device.id);
  if (index >= 0) {
    devices[index] = device;
  } else {
    devices.push(device);
  }
  config.devices = devices;
}

function removeDevice(config: DeviceConfigFile, id: string) {
  config.devices = config.devices.filter(device => device.id !== id);
  if (config.defaultDevice === id) {
    delete config.defaultDevice;
  }
}

function parseRuntimeDefaultValue(key: string, raw: string): RuntimeDefaults[keyof RuntimeDefaults] {
  switch (key) {
    case 'autoOpenTerminal':
      return parseBoolean(raw, key);
    case 'logDir':
    case 'viewerHost':
      return raw;
    case 'logMode':
      if (raw === 'off' || raw === 'meta') return raw;
      break;
    case 'mode':
      if (raw === 'safe' || raw === 'full') return raw;
      break;
    case 'viewerMode':
      if (raw === 'browser' || raw === 'terminal') return raw;
      break;
    case 'viewerPort':
      if (raw === 'auto') return raw;
      return parseOptionalNonNegativeInt(raw, key);
    case 'viewerSingletonScope':
      if (raw === 'connection' || raw === 'session') return raw;
      break;
    default:
      fail(`Unknown defaults key: ${key}`);
  }

  fail(`Invalid value for ${key}: ${raw}`);
}

function parseDeviceViewerMode(raw: string | undefined, name: string): DeviceViewerMode | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === 'browser' || raw === 'terminal') {
    return raw;
  }

  fail(`Invalid ${name}: expected browser or terminal`);
}

function ensureDefaults(config: DeviceConfigFile) {
  if (!config.defaults) {
    config.defaults = {};
  }
  return config.defaults;
}

function setRuntimeDefaultValue(defaults: RuntimeDefaults, key: string, raw: string) {
  const value = parseRuntimeDefaultValue(key, raw);
  (defaults as Record<string, RuntimeDefaults[keyof RuntimeDefaults] | undefined>)[key] = value;
}

function buildDeviceFromFlags(existing: DeviceProfile | undefined, id: string, args: ReturnType<typeof parseArgv>) {
  const host = args.getFlag('host') || existing?.host;
  const user = args.getFlag('user') || existing?.user;
  if (!host) fail(`Missing --host for device ${id}`);
  if (!user) fail(`Missing --user for device ${id}`);

  const device: DeviceProfile = {
    id,
    host,
    port: parseOptionalPositiveInt(args.getFlag('port'), 'port') ?? existing?.port ?? 22,
    user,
    tags: existing?.tags || [],
  };

  const label = args.getFlag('label');
  if (label !== undefined) {
    device.label = label;
  } else if (existing?.label) {
    device.label = existing.label;
  }

  const tags = args.getFlags('tag');
  if (tags.length > 0) {
    device.tags = [...new Set(tags)];
  } else if (existing?.tags) {
    device.tags = existing.tags;
  }

  const passwordEnv = args.getFlag('password-env');
  const keyPath = args.getFlag('key-path');
  if (passwordEnv || keyPath || existing?.auth) {
    device.auth = {};
    if (passwordEnv !== undefined) device.auth.passwordEnv = passwordEnv;
    else if (existing?.auth?.passwordEnv) device.auth.passwordEnv = existing.auth.passwordEnv;

    if (keyPath !== undefined) device.auth.keyPath = keyPath;
    else if (existing?.auth?.keyPath) device.auth.keyPath = existing.auth.keyPath;

    if (!device.auth.passwordEnv && !device.auth.keyPath) {
      delete device.auth;
    }
  }

  const defaults = {
    term: args.getFlag('term') ?? existing?.defaults?.term,
    cols: parseOptionalPositiveInt(args.getFlag('cols'), 'cols') ?? existing?.defaults?.cols,
    rows: parseOptionalPositiveInt(args.getFlag('rows'), 'rows') ?? existing?.defaults?.rows,
    idleTimeoutMs: parseOptionalNonNegativeInt(args.getFlag('idle-timeout-ms'), 'idle-timeout-ms') ?? existing?.defaults?.idleTimeoutMs,
    closedRetentionMs: parseOptionalNonNegativeInt(args.getFlag('closed-retention-ms'), 'closed-retention-ms') ?? existing?.defaults?.closedRetentionMs,
    autoOpenViewer: args.hasFlag('auto-open-viewer')
      ? parseBoolean(args.getFlag('auto-open-viewer'), 'auto-open-viewer')
      : existing?.defaults?.autoOpenViewer,
    viewerMode: parseDeviceViewerMode(args.getFlag('viewer-mode'), 'viewer-mode') ?? existing?.defaults?.viewerMode,
  };

  if (Object.values(defaults).some(value => value !== undefined)) {
    device.defaults = defaults;
  }

  return device;
}

function runPath(cwd: string, explicitPath: string | undefined) {
  const files = resolveConfigFiles({ argvPath: explicitPath, cwd });
  const effective = explicitPath || loadProfiles({ cwd }).path;
  printJson({
    explicitPath: files.explicitPath,
    workspacePath: files.workspacePath,
    globalPath: files.globalPath,
    effectivePath: effective,
  });
}

function runShow(cwd: string, explicitPath: string | undefined, scope: Scope) {
  printJson(sortConfig(resolveReadConfig(explicitPath, scope, cwd)));
}

function runDevice(args: ReturnType<typeof parseArgv>, cwd: string, explicitPath: string | undefined) {
  const subcommand = args.positional[1];
  if (!subcommand) fail('Missing device subcommand');

  if (subcommand === 'list') {
    const scope = parseScope(args.getFlag('scope'), false);
    const config = resolveReadConfig(explicitPath, scope, cwd);
    printJson(config.devices.map(device => ({
      id: device.id,
      label: device.label,
      host: device.host,
      port: device.port,
      user: device.user,
      tags: device.tags || [],
    })));
    return;
  }

  const id = args.positional[2];
  if (!id) fail('Missing device id');

  if (subcommand === 'get') {
    const scope = parseScope(args.getFlag('scope'), false);
    const config = resolveReadConfig(explicitPath, scope, cwd);
    const device = config.devices.find(candidate => candidate.id === id);
    if (!device) fail(`Unknown device: ${id}`);
    printJson(device);
    return;
  }

  if (subcommand === 'set') {
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    const existing = config.devices.find(candidate => candidate.id === id);
    const device = buildDeviceFromFlags(existing, id, args);
    upsertDevice(config, device);
    saveConfigFile(path, sortConfig(config));
    console.log(`Saved device ${id} -> ${path}`);
    return;
  }

  if (subcommand === 'remove') {
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    removeDevice(config, id);
    saveConfigFile(path, sortConfig(config));
    console.log(`Removed device ${id} from ${path}`);
    return;
  }

  fail(`Unknown device subcommand: ${subcommand}`);
}

function runDefaultDevice(args: ReturnType<typeof parseArgv>, cwd: string, explicitPath: string | undefined) {
  const subcommand = args.positional[1];
  if (subcommand === 'set') {
    const id = args.positional[2];
    if (!id) fail('Missing default device id');
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    config.defaultDevice = id;
    saveConfigFile(path, sortConfig(config));
    console.log(`Set defaultDevice=${id} in ${path}`);
    return;
  }

  if (subcommand === 'clear') {
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    delete config.defaultDevice;
    saveConfigFile(path, sortConfig(config));
    console.log(`Cleared defaultDevice in ${path}`);
    return;
  }

  fail(`Unknown default-device subcommand: ${subcommand}`);
}

function runDefaults(args: ReturnType<typeof parseArgv>, cwd: string, explicitPath: string | undefined) {
  const subcommand = args.positional[1];
  if (subcommand === 'show') {
    const scope = parseScope(args.getFlag('scope'), false);
    const config = resolveReadConfig(explicitPath, scope, cwd);
    printJson(config.defaults || {});
    return;
  }

  const key = args.positional[2];
  if (!key) fail('Missing defaults key');

  if (subcommand === 'set') {
    const value = args.positional[3];
    if (value === undefined) fail('Missing defaults value');
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    const defaults = ensureDefaults(config);
    setRuntimeDefaultValue(defaults, key, value);
    saveConfigFile(path, sortConfig(config));
    console.log(`Set defaults.${key} in ${path}`);
    return;
  }

  if (subcommand === 'unset') {
    const scope = parseScope(args.getFlag('scope'), true);
    const { config, path } = resolveWriteConfig(explicitPath, scope, cwd);
    if (config.defaults) {
      delete config.defaults[key as keyof RuntimeDefaults];
      if (Object.keys(config.defaults).length === 0) {
        delete config.defaults;
      }
    }
    saveConfigFile(path, sortConfig(config));
    console.log(`Unset defaults.${key} in ${path}`);
    return;
  }

  fail(`Unknown defaults subcommand: ${subcommand}`);
}

function main() {
  const cwd = process.cwd();
  const args = parseArgv(process.argv.slice(2));
  const explicitPath = args.getFlag('config');
  const command = args.positional[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case 'path':
      runPath(cwd, explicitPath);
      return;
    case 'show':
      runShow(cwd, explicitPath, parseScope(args.getFlag('scope'), false));
      return;
    case 'device':
      runDevice(args, cwd, explicitPath);
      return;
    case 'default-device':
      runDefaultDevice(args, cwd, explicitPath);
      return;
    case 'defaults':
      runDefaults(args, cwd, explicitPath);
      return;
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`${basename(process.argv[1] || 'config-cli')}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
