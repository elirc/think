#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { generateSecureToken, loadConfig, saveConfig, TraceVaultService, upsertRuntimeService } from '@tracevault/core';
import { createIndexerFromConfig, type TraceIndexer } from '@tracevault/indexer';
import { createTraceVaultServer } from './app.js';

export interface StartServerOptions {
  mode?: 'full' | 'lite';
  host?: string;
  port?: number;
  openBrowser?: boolean;
}

function maybeOpenBrowser(url: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function startServer(options: StartServerOptions = {}) {
  const config = loadConfig();
  if (!config.auth.token) {
    config.auth.token = generateSecureToken();
    saveConfig(config);
    process.stdout.write(`[tracevault] generated API token: ${config.auth.token}\n`);
  }
  const mode = options.mode ?? 'full';
  const host = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const openBrowser = options.openBrowser ?? config.server.openBrowser;

  const service = new TraceVaultService(config);
  let indexer: TraceIndexer | null = null;

  if (config.index.enabled) {
    indexer = await createIndexerFromConfig(config);
    await indexer.sync(service);
  }

  const app = await createTraceVaultServer({
    config,
    service,
    indexer,
    mode
  });

  await app.listen({ host, port });

  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }

  const serviceName = mode === 'lite' ? 'serve-lite' : 'serve';
  const url = `http://${host}:${address.port}`;

  upsertRuntimeService({
    name: serviceName,
    pid: process.pid,
    host,
    port: address.port,
    url,
    startedAt: new Date().toISOString()
  });

  process.stdout.write(`[tracevault] ${serviceName} running at ${url}\n`);
  if (openBrowser) maybeOpenBrowser(url);

  return { app, url, port: address.port };
}

const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  const modeArg = process.argv.includes('--lite') ? 'lite' : 'full';
  const portFlagIndex = process.argv.findIndex((arg) => arg === '--port');
  const port = portFlagIndex >= 0 ? Number(process.argv[portFlagIndex + 1]) : undefined;
  const noOpen = process.argv.includes('--no-open');

  startServer({ mode: modeArg, port, openBrowser: !noOpen }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
