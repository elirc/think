#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  generateSecureToken,
  loadConfig,
  loadRuntimeState,
  redactSession,
  saveConfig,
  TraceVaultService,
  type Session
} from '@tracevault/core';
import { createIndexerFromConfig } from '@tracevault/indexer';
import { startMcpServer } from '@tracevault/mcp';
import { startServer } from '@tracevault/server';
import { runSetupWizard } from './setup.js';
import { launchTui } from './tui.js';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id}`);
  lines.push('');
  lines.push(`- Source: ${session.sourceId}`);
  lines.push(`- Model: ${session.model ?? 'unknown'}`);
  lines.push(`- Started: ${session.startedAt ?? 'unknown'}`);
  lines.push(`- Updated: ${session.updatedAt ?? 'unknown'}`);
  lines.push('');

  for (const turn of session.turns) {
    lines.push(`## Turn ${turn.index}`);
    lines.push(`- Timestamp: ${turn.timestamp ?? 'unknown'}`);
    lines.push('');
    lines.push('### User');
    lines.push(turn.userText || '_empty_');
    lines.push('');
    lines.push('### Assistant');
    lines.push(turn.assistantText || '_empty_');
    lines.push('');
    if (turn.thinkingBlocks.length > 0) {
      lines.push('### Thinking');
      for (const block of turn.thinkingBlocks) {
        lines.push('```text');
        lines.push(block);
        lines.push('```');
      }
    }
    if (turn.toolCalls.length > 0) {
      lines.push('### Tool Calls');
      for (const call of turn.toolCalls) {
        lines.push(`- ${call.name}: ${call.args}`);
      }
    }
    if (turn.toolResults.length > 0) {
      lines.push('### Tool Results');
      for (const result of turn.toolResults) {
        lines.push(`- (${result.status ?? 'ok'}) ${result.output}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new TraceVaultService(config);
  const program = new Command();

  program.name('tracevault').description('TraceVault CLI').version('0.1.0');

  program
    .command('setup')
    .description('interactive first-run setup wizard')
    .action(async () => {
      await runSetupWizard();
    });

  const sources = program.command('sources').description('source management');
  sources
    .command('list')
    .description('list configured sources')
    .action(async () => {
      printJson(await service.listSources());
    });

  sources
    .command('status')
    .description('show source detection and enabled status')
    .action(async () => {
      printJson(await service.sourceStatus());
    });

  const projects = program.command('projects').description('project views');
  projects
    .command('list')
    .description('list merged projects')
    .action(async () => {
      printJson(await service.listProjects());
    });

  projects
    .command('tree')
    .description('tree-like project summary')
    .action(async () => {
      const rows = await service.listProjects();
      const grouped: Record<string, string[]> = {};
      for (const project of rows) {
        if (!grouped[project.sourceId]) grouped[project.sourceId] = [];
        grouped[project.sourceId].push(project.displayPath);
      }
      printJson(grouped);
    });

  projects
    .command('summary')
    .description('project counts by source')
    .action(async () => {
      const rows = await service.listProjects();
      const out: Record<string, number> = {};
      for (const project of rows) {
        out[project.sourceId] = (out[project.sourceId] ?? 0) + 1;
      }
      printJson(out);
    });

  const sessions = program.command('sessions').description('session operations');
  sessions
    .command('list')
    .description('list sessions across all projects')
    .option('--project <id>', 'project id')
    .action(async (opts: { project?: string }) => {
      if (opts.project) {
        printJson(await service.listSessions(opts.project));
      } else {
        printJson(await service.listAllSessions());
      }
    });

  sessions
    .command('view <id>')
    .description('view normalized session')
    .action(async (id: string) => {
      const session = await service.getSession(id);
      if (!session) {
        process.stderr.write(`Session not found: ${id}\n`);
        process.exitCode = 1;
        return;
      }
      printJson(session);
    });

  sessions
    .command('resolve <id>')
    .description('resolve session id to underlying source reference')
    .action(async (id: string) => {
      const resolved = await service.resolveSession(id);
      if (!resolved) {
        process.stderr.write(`Session not found: ${id}\n`);
        process.exitCode = 1;
        return;
      }
      printJson(resolved);
    });

  const exportCmd = program.command('export').description('export sessions');
  exportCmd
    .command('session <id>')
    .description('export one session')
    .option('--format <format>', 'md|json', 'md')
    .option('--profile <profile>', 'redaction profile', config.redaction.defaultProfile)
    .option('--out <dir>', 'output directory', process.cwd())
    .action(async (id: string, opts: { format: string; profile: string; out: string }) => {
      const session = await service.getSession(id);
      if (!session) {
        process.stderr.write(`Session not found: ${id}\n`);
        process.exitCode = 1;
        return;
      }

      const profile = config.redaction.profiles[opts.profile] ?? config.redaction.profiles.safe;
      const redacted = redactSession(session, profile);
      mkdirSync(opts.out, { recursive: true });

      if (opts.format === 'json') {
        const filePath = join(opts.out, `tracevault-${redacted.id}.json`);
        writeFileSync(filePath, JSON.stringify(redacted, null, 2), 'utf8');
        process.stdout.write(`${filePath}\n`);
        return;
      }

      const filePath = join(opts.out, `tracevault-${redacted.id}.md`);
      writeFileSync(filePath, sessionToMarkdown(redacted), 'utf8');
      process.stdout.write(`${filePath}\n`);
    });

  const serve = program.command('serve').description('start API, web, lite, or MCP services');

  serve
    .option('--port <port>', 'port (0 means auto)', String(config.server.port))
    .option('--host <host>', 'host', config.server.host)
    .option('--no-open', 'disable browser auto-open')
    .action(async (opts: { port: string; host: string; open: boolean }) => {
      await startServer({
        mode: 'full',
        port: Number(opts.port),
        host: opts.host,
        openBrowser: opts.open
      });
    });

  serve
    .command('lite')
    .description('start lightweight debug web UI')
    .option('--port <port>', 'port (0 means auto)', '0')
    .option('--host <host>', 'host', config.server.host)
    .option('--no-open', 'disable browser auto-open')
    .action(async (opts: { port: string; host: string; open: boolean }) => {
      await startServer({
        mode: 'lite',
        port: Number(opts.port),
        host: opts.host,
        openBrowser: opts.open
      });
    });

  serve
    .command('mcp')
    .description('start MCP server')
    .option('--transport <transport>', 'stdio|http', 'stdio')
    .option('--port <port>', 'http port (0 means auto)', '0')
    .action(async (opts: { transport: 'stdio' | 'http'; port: string }) => {
      await startMcpServer({ transport: opts.transport, port: Number(opts.port) });
    });

  program
    .command('serve-lite')
    .description('alias for `tracevault serve lite`')
    .option('--port <port>', 'port (0 means auto)', '0')
    .option('--host <host>', 'host', config.server.host)
    .option('--no-open', 'disable browser auto-open')
    .action(async (opts: { port: string; host: string; open: boolean }) => {
      await startServer({
        mode: 'lite',
        port: Number(opts.port),
        host: opts.host,
        openBrowser: opts.open
      });
    });

  program
    .command('serve-mcp')
    .description('alias for `tracevault serve mcp`')
    .option('--transport <transport>', 'stdio|http', 'stdio')
    .option('--port <port>', 'http port (0 means auto)', '0')
    .action(async (opts: { transport: 'stdio' | 'http'; port: string }) => {
      await startMcpServer({ transport: opts.transport, port: Number(opts.port) });
    });

  program
    .command('token')
    .description('generate and persist a bearer token')
    .action(() => {
      const nextToken = generateSecureToken();
      config.auth.token = nextToken;
      saveConfig(config);
      process.stdout.write(`${nextToken}\n`);
    });

  program
    .command('status')
    .description('show runtime urls and pids')
    .action(() => {
      printJson(loadRuntimeState());
    });

  program
    .command('doctor')
    .description('run diagnostics')
    .action(async () => {
      const sourceStatus = await service.sourceStatus();
      const runtime = loadRuntimeState();
      printJson({
        configPath: '~/.tracevault/config.json',
        runtimePath: '~/.tracevault/runtime.json',
        sources: sourceStatus,
        runtime
      });
    });

  const configCmd = program.command('config').description('configuration helpers');
  const securityCmd = configCmd.command('security.allowedBaseDirs').description('manage path allowlist');
  securityCmd
    .command('add <dir>')
    .description('add an allowed base directory')
    .action((dir: string) => {
      if (!config.security.allowedBaseDirs.includes(dir)) {
        config.security.allowedBaseDirs.push(dir);
        saveConfig(config);
      }
      printJson({ allowedBaseDirs: config.security.allowedBaseDirs });
    });

  program
    .command('index-sync')
    .description('run indexer sync once')
    .action(async () => {
      const indexer = await createIndexerFromConfig(config);
      const result = await indexer.sync(service);
      printJson(result);
    });

  const agent = program.command('agent').description('remote collector helpers');
  agent
    .command('watch')
    .description('watch local sessions and push snapshots to central ingest URL')
    .requiredOption('--push <url>', 'ingest endpoint URL')
    .requiredOption('--token <token>', 'bearer token')
    .option('--interval <ms>', 'poll interval', '20000')
    .action(async (opts: { push: string; token: string; interval: string }) => {
      const seen = new Set<string>();
      const interval = Number(opts.interval);
      process.stdout.write(`[tracevault-agent] watching, push=${opts.push}, interval=${interval}ms\n`);

      while (true) {
        const refs = await service.listAllSessions();
        const fresh = refs.filter((ref) => !seen.has(ref.id));
        if (fresh.length > 0) {
          const sessionsPayload: unknown[] = [];
          for (const ref of fresh) {
            const session = await service.getSession(ref.id);
            if (session) sessionsPayload.push(session);
            seen.add(ref.id);
          }

          if (sessionsPayload.length > 0) {
            await fetch(opts.push, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${opts.token}`
              },
              body: JSON.stringify({
                workspaceFingerprint: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown',
                workspaceName: config.remote.workspaceName,
                sessions: sessionsPayload
              })
            });
          }
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    });

  if (process.argv.length <= 2) {
    await launchTui(service);
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
