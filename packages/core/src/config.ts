import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import type { TraceVaultConfig } from './types.js';

const TRACEVAULT_HOME = '.tracevault';

export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

export function collapseHomePath(input: string): string {
  const home = homedir();
  if (input === home) return '~';
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `~/${input.slice(home.length + 1).replace(/\\/g, '/')}`;
  }
  return input;
}

export function getTraceVaultDir(): string {
  const dir = join(homedir(), TRACEVAULT_HOME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return join(getTraceVaultDir(), 'config.json');
}

export function getRuntimePath(): string {
  return join(getTraceVaultDir(), 'runtime.json');
}

export function defaultConfig(): TraceVaultConfig {
  return {
    sources: {
      claude: { enabled: true, path: '~/.claude' },
      kimi: { enabled: true, path: '~/.kimi' },
      gemini: { enabled: false, path: '~/.gemini' },
      copilot: { enabled: true, path: '~/.copilot' },
      codex: { enabled: true, path: '~/.codex' }
    },
    security: {
      allowedBaseDirs: ['~/dev', '~/work'],
      resolveSymlinks: true
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      openBrowser: true
    },
    index: {
      enabled: true,
      path: '~/.tracevault/index.duckdb',
      watch: true
    },
    redaction: {
      defaultProfile: 'safe',
      profiles: {
        safe: { stripPaths: true, stripSecrets: true, stripFileContents: true },
        internal: { stripPaths: false, stripSecrets: true, stripFileContents: false }
      }
    },
    remote: {
      enabled: false,
      workspaceName: 'local-workspace',
      ingestUrl: 'http://127.0.0.1:8784/api/v1/ingest',
      token: ''
    },
    auth: {
      token: ''
    }
  };
}

function mergeConfig(base: TraceVaultConfig, incoming: Partial<TraceVaultConfig>): TraceVaultConfig {
  return {
    ...base,
    ...incoming,
    sources: {
      ...base.sources,
      ...(incoming.sources ?? {})
    },
    security: {
      ...base.security,
      ...(incoming.security ?? {})
    },
    server: {
      ...base.server,
      ...(incoming.server ?? {})
    },
    index: {
      ...base.index,
      ...(incoming.index ?? {})
    },
    redaction: {
      ...base.redaction,
      ...(incoming.redaction ?? {}),
      profiles: {
        ...base.redaction.profiles,
        ...(incoming.redaction?.profiles ?? {})
      }
    },
    remote: {
      ...base.remote,
      ...(incoming.remote ?? {})
    },
    auth: {
      ...base.auth,
      ...(incoming.auth ?? {})
    }
  };
}

export function loadConfig(): TraceVaultConfig {
  const configPath = getConfigPath();
  const base = defaultConfig();
  if (!existsSync(configPath)) {
    saveConfig(base);
    return applyEnvOverrides(base);
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<TraceVaultConfig>;
  const merged = mergeConfig(base, parsed);
  return applyEnvOverrides(merged);
}

export function saveConfig(config: TraceVaultConfig): void {
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
}

export function applyEnvOverrides(config: TraceVaultConfig): TraceVaultConfig {
  const out = structuredClone(config);
  if (process.env.TRACEVAULT_SERVER_HOST) out.server.host = process.env.TRACEVAULT_SERVER_HOST;
  if (process.env.TRACEVAULT_SERVER_PORT) out.server.port = Number(process.env.TRACEVAULT_SERVER_PORT);
  if (process.env.TRACEVAULT_API_TOKEN) out.auth.token = process.env.TRACEVAULT_API_TOKEN;
  if (process.env.TRACEVAULT_INDEX_PATH) out.index.path = process.env.TRACEVAULT_INDEX_PATH;
  return out;
}
