import { accessSync, constants, existsSync } from 'node:fs';
import { prompt } from 'enquirer';
import {
  defaultConfig,
  expandHomePath,
  loadConfig,
  saveConfig,
  type TraceVaultConfig
} from '@tracevault/core';

function canRead(pathValue: string): boolean {
  try {
    accessSync(pathValue, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function askBoolean(message: string, initial: boolean): Promise<boolean> {
  const result = await prompt<{ value: boolean }>({
    type: 'confirm',
    name: 'value',
    message,
    initial
  });
  return result.value;
}

async function askInput(message: string, initial: string): Promise<string> {
  const result = await prompt<{ value: string }>({
    type: 'input',
    name: 'value',
    message,
    initial
  });
  return result.value;
}

export async function runSetupWizard(): Promise<TraceVaultConfig> {
  const config = loadConfig();
  const defaults = defaultConfig();

  process.stdout.write('TraceVault setup\n');
  process.stdout.write('Detecting sources...\n');

  for (const [sourceId, sourceConfig] of Object.entries(config.sources)) {
    const expanded = expandHomePath(sourceConfig.path);
    const detected = existsSync(expanded) && canRead(expanded);
    const shouldEnable = await askBoolean(
      `${sourceId} (${sourceConfig.path}) detected=${detected}. Enable?`,
      detected ? sourceConfig.enabled : false
    );
    config.sources[sourceId as keyof TraceVaultConfig['sources']].enabled = shouldEnable;

    const configuredPath = await askInput(`Path for ${sourceId}`, sourceConfig.path || defaults.sources[sourceId as keyof TraceVaultConfig['sources']].path);
    config.sources[sourceId as keyof TraceVaultConfig['sources']].path = configuredPath;
  }

  const allowlist = await askInput(
    'Allowed base dirs (comma-separated)',
    config.security.allowedBaseDirs.join(', ')
  );

  config.security.allowedBaseDirs = allowlist
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  config.security.resolveSymlinks = await askBoolean('Resolve symlinks during allowlist checks?', config.security.resolveSymlinks);
  config.server.openBrowser = await askBoolean('Open browser on `serve`?', config.server.openBrowser);
  config.index.watch = await askBoolean('Enable continuous indexing watch by default?', config.index.watch);

  saveConfig(config);
  process.stdout.write('Saved config to ~/.tracevault/config.json\n');
  return config;
}
