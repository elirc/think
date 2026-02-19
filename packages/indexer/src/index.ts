#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, TraceVaultService } from '@tracevault/core';
import { createIndexerFromConfig } from './lib.js';

const program = new Command();
program.name('tracevault-indexer').description('TraceVault DuckDB indexer');

program
  .command('sync')
  .description('one-shot sync into index DB')
  .action(async () => {
    const config = loadConfig();
    const service = new TraceVaultService(config);
    const indexer = await createIndexerFromConfig(config);
    const health = await indexer.sync(service);
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  });

program
  .command('watch')
  .description('continuous sync loop')
  .option('--interval <ms>', 'sync interval ms', '15000')
  .action(async (opts: { interval: string }) => {
    const config = loadConfig();
    const service = new TraceVaultService(config);
    const indexer = await createIndexerFromConfig(config);
    const interval = Number(opts.interval);
    process.stdout.write(`[tracevault-indexer] watching with interval=${interval}ms\n`);
    await indexer.watch(service, interval);
  });

program
  .command('search <query>')
  .description('query indexed text')
  .option('--limit <n>', 'max rows', '30')
  .action(async (query: string, opts: { limit: string }) => {
    const config = loadConfig();
    const indexer = await createIndexerFromConfig(config);
    const rows = await indexer.search(query, Number(opts.limit));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });

program
  .command('stats')
  .description('show usage and activity aggregates')
  .action(async () => {
    const config = loadConfig();
    const indexer = await createIndexerFromConfig(config);
    const stats = await indexer.stats();
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  });

program.parseAsync(process.argv);
