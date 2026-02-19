import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expandHomePath, TraceVaultService, type Session, type TraceVaultConfig } from '@tracevault/core';

type DriverMode = 'duckdb' | 'memory';

interface SearchHit {
  sessionId: string;
  turnIndex: number;
  text: string;
}

interface IndexedTurn {
  sessionId: string;
  turnIndex: number;
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface IndexStats {
  totalSessions: number;
  totalTurns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  toolFrequency: Record<string, number>;
  activityByDay: Record<string, number>;
}

export interface IndexerHealth {
  ready: boolean;
  mode: DriverMode;
  dbPath: string;
  sessionCount: number;
  turnCount: number;
  message?: string;
}

export class TraceIndexer {
  private readonly dbPath: string;
  private mode: DriverMode = 'memory';
  private db: any;
  private conn: any;

  private readonly memory = {
    sessions: new Set<string>(),
    turns: [] as IndexedTurn[],
    tools: [] as string[],
    daily: new Map<string, number>()
  };

  public constructor(dbPath: string) {
    this.dbPath = expandHomePath(dbPath);
  }

  public async init(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    try {
      const duckdbImport = await import('duckdb');
      const DuckDatabase = (duckdbImport as any).Database;
      if (!DuckDatabase) {
        throw new Error('DuckDB Database constructor unavailable');
      }
      this.db = new DuckDatabase(this.dbPath);
      this.conn = await new Promise<any>((resolve, reject) => {
        this.db.connect((err: Error | null, conn: any) => {
          if (err) reject(err);
          else resolve(conn);
        });
      });
      this.mode = 'duckdb';
      await this.setupSchema();
    } catch (error) {
      this.mode = 'memory';
      this.db = null;
      this.conn = null;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[tracevault-indexer] DuckDB unavailable, using memory fallback: ${message}\n`);
    }
  }

  public getMode(): DriverMode {
    return this.mode;
  }

  public async sync(service: TraceVaultService): Promise<IndexerHealth> {
    if (this.mode === 'duckdb') {
      await this.clearTables();
    } else {
      this.memory.sessions.clear();
      this.memory.turns = [];
      this.memory.tools = [];
      this.memory.daily.clear();
    }

    const projects = await service.listProjects();

    if (this.mode === 'duckdb') {
      await this.run('BEGIN TRANSACTION');
    }

    try {
      for (const project of projects) {
        if (this.mode === 'duckdb') {
          await this.run(
            `INSERT INTO projects (id, source_id, path, display_path, name, last_activity_at)
             VALUES (${quote(project.id)}, ${quote(project.sourceId)}, ${quote(project.path)}, ${quote(project.displayPath)}, ${quote(project.name)}, ${sqlTime(project.lastActivityAt)})`
          );
        }

        const sessions = await service.listSessions(project.id);
        for (const ref of sessions) {
          const session = await service.getSession(ref.id);
          if (!session) continue;
          await this.indexSession(session);
        }
      }

      if (this.mode === 'duckdb') {
        await this.refreshDailyStats();
        await this.run('COMMIT');
      }
    } catch (error) {
      if (this.mode === 'duckdb') {
        await this.run('ROLLBACK');
      }
      throw error;
    }

    return this.health();
  }

  public async watch(service: TraceVaultService, intervalMs = 15000): Promise<void> {
    while (true) {
      await this.sync(service);
      await sleep(intervalMs);
    }
  }

  public async search(query: string, limit = 30): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    if (this.mode === 'duckdb') {
      const pattern = `%${query.toLowerCase().replace(/'/g, "''")}%`;
      const rows = await this.all(
        `SELECT session_id as sessionId, turn_index as turnIndex, substr(text, 1, 500) as text
         FROM turns
         WHERE lower(text) LIKE ${quote(pattern)}
         ORDER BY rowid DESC
         LIMIT ${Math.max(1, Math.min(limit, 200))}`
      );
      return rows as SearchHit[];
    }

    const needle = query.toLowerCase();
    return this.memory.turns
      .filter((row) => row.text.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((row) => ({ sessionId: row.sessionId, turnIndex: row.turnIndex, text: row.text.slice(0, 500) }));
  }

  public async stats(): Promise<IndexStats> {
    if (this.mode === 'duckdb') {
      const totals = (await this.all(
        `SELECT
           count(distinct session_id) as totalSessions,
           count(*) as totalTurns,
           coalesce(sum(prompt_tokens), 0) as totalPromptTokens,
           coalesce(sum(completion_tokens), 0) as totalCompletionTokens
         FROM turns`
      ))[0] as Record<string, number>;

      const tools = await this.all(`SELECT tool_name, count(*) as count FROM tools GROUP BY tool_name ORDER BY count DESC`);
      const daily = await this.all(`SELECT day, session_count FROM stats_daily ORDER BY day`);

      const toolFrequency: Record<string, number> = {};
      for (const row of tools as Array<{ tool_name: string; count: number }>) {
        toolFrequency[row.tool_name] = Number(row.count);
      }

      const activityByDay: Record<string, number> = {};
      for (const row of daily as Array<{ day: string; session_count: number }>) {
        activityByDay[String(row.day)] = Number(row.session_count);
      }

      return {
        totalSessions: Number(totals.totalSessions ?? 0),
        totalTurns: Number(totals.totalTurns ?? 0),
        totalPromptTokens: Number(totals.totalPromptTokens ?? 0),
        totalCompletionTokens: Number(totals.totalCompletionTokens ?? 0),
        toolFrequency,
        activityByDay
      };
    }

    const toolFrequency: Record<string, number> = {};
    for (const toolName of this.memory.tools) {
      toolFrequency[toolName] = (toolFrequency[toolName] ?? 0) + 1;
    }

    const activityByDay: Record<string, number> = {};
    for (const [day, count] of this.memory.daily.entries()) {
      activityByDay[day] = count;
    }

    return {
      totalSessions: this.memory.sessions.size,
      totalTurns: this.memory.turns.length,
      totalPromptTokens: this.memory.turns.reduce((sum, row) => sum + row.promptTokens, 0),
      totalCompletionTokens: this.memory.turns.reduce((sum, row) => sum + row.completionTokens, 0),
      toolFrequency,
      activityByDay
    };
  }

  public async health(): Promise<IndexerHealth> {
    if (this.mode === 'duckdb') {
      const row = (await this.all(
        `SELECT
           (SELECT count(*) FROM sessions) as sessionCount,
           (SELECT count(*) FROM turns) as turnCount`
      ))[0] as { sessionCount: number; turnCount: number };

      return {
        ready: true,
        mode: 'duckdb',
        dbPath: this.dbPath,
        sessionCount: Number(row?.sessionCount ?? 0),
        turnCount: Number(row?.turnCount ?? 0)
      };
    }

    return {
      ready: true,
      mode: 'memory',
      dbPath: this.dbPath,
      sessionCount: this.memory.sessions.size,
      turnCount: this.memory.turns.length,
      message: 'DuckDB not available; using in-memory index'
    };
  }

  private async indexSession(session: Session): Promise<void> {
    if (this.mode === 'duckdb') {
      await this.run(
        `INSERT INTO sessions (id, source_id, project_id, source_ref, started_at, updated_at, model, metadata_json)
         VALUES (
           ${quote(session.id)},
           ${quote(session.sourceId)},
           ${quote(session.projectId)},
           ${quote(session.sourceSessionRef)},
           ${sqlTime(session.startedAt)},
           ${sqlTime(session.updatedAt)},
           ${sqlNullable(session.model)},
           ${quote(JSON.stringify(session.metadata))}
         )`
      );
    } else {
      this.memory.sessions.add(session.id);
      const day = (session.updatedAt ?? session.startedAt ?? new Date().toISOString()).slice(0, 10);
      this.memory.daily.set(day, (this.memory.daily.get(day) ?? 0) + 1);
    }

    for (const turn of session.turns) {
      const combined = `${turn.userText}\n${turn.assistantText}\n${turn.thinkingBlocks.join('\n')}`;
      const promptTokens = turn.tokenUsage?.prompt ?? 0;
      const completionTokens = turn.tokenUsage?.completion ?? 0;
      const thinkingTokens = turn.tokenUsage?.thinking ?? 0;

      if (this.mode === 'duckdb') {
        await this.run(
          `INSERT INTO turns (
             session_id, turn_index, timestamp, user_text, assistant_text, thinking_text, text,
             prompt_tokens, completion_tokens, thinking_tokens
           ) VALUES (
             ${quote(session.id)}, ${turn.index}, ${sqlTime(turn.timestamp)}, ${quote(turn.userText)},
             ${quote(turn.assistantText)}, ${quote(turn.thinkingBlocks.join('\n'))}, ${quote(combined)},
             ${promptTokens}, ${completionTokens}, ${thinkingTokens}
           )`
        );

        for (const [i, block] of turn.thinkingBlocks.entries()) {
          await this.run(
            `INSERT INTO thinking_blocks (session_id, turn_index, block_index, text)
             VALUES (${quote(session.id)}, ${turn.index}, ${i}, ${quote(block)})`
          );
        }

        for (const call of turn.toolCalls) {
          await this.run(
            `INSERT INTO tools (session_id, turn_index, tool_name, args_json, status)
             VALUES (${quote(session.id)}, ${turn.index}, ${quote(call.name)}, ${quote(call.args)}, NULL)`
          );
        }

        for (const result of turn.toolResults) {
          await this.run(
            `INSERT INTO tools (session_id, turn_index, tool_name, args_json, status)
             VALUES (${quote(session.id)}, ${turn.index}, ${quote('tool_result')}, ${quote(result.output)}, ${sqlNullable(result.status ?? null)})`
          );
        }
      } else {
        this.memory.turns.push({
          sessionId: session.id,
          turnIndex: turn.index,
          text: combined,
          promptTokens,
          completionTokens
        });
        for (const call of turn.toolCalls) {
          this.memory.tools.push(call.name);
        }
      }
    }

    if (this.mode === 'duckdb') {
      for (const error of session.errors) {
        await this.run(
          `INSERT INTO parse_errors (session_id, scope, message, context)
           VALUES (${quote(session.id)}, ${quote(error.scope)}, ${quote(error.message)}, ${sqlNullable(error.context ?? null)})`
        );
      }
    }
  }

  private async setupSchema(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS projects (
         id TEXT PRIMARY KEY,
         source_id TEXT,
         path TEXT,
         display_path TEXT,
         name TEXT,
         last_activity_at TIMESTAMP
       )`,
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         source_id TEXT,
         project_id TEXT,
         source_ref TEXT,
         started_at TIMESTAMP,
         updated_at TIMESTAMP,
         model TEXT,
         metadata_json TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS turns (
         session_id TEXT,
         turn_index INTEGER,
         timestamp TIMESTAMP,
         user_text TEXT,
         assistant_text TEXT,
         thinking_text TEXT,
         text TEXT,
         prompt_tokens INTEGER,
         completion_tokens INTEGER,
         thinking_tokens INTEGER
       )`,
      `CREATE TABLE IF NOT EXISTS tools (
         session_id TEXT,
         turn_index INTEGER,
         tool_name TEXT,
         args_json TEXT,
         status TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS thinking_blocks (
         session_id TEXT,
         turn_index INTEGER,
         block_index INTEGER,
         text TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS stats_daily (
         day DATE,
         session_count INTEGER,
         turn_count INTEGER,
         prompt_tokens BIGINT,
         completion_tokens BIGINT
       )`,
      `CREATE TABLE IF NOT EXISTS parse_errors (
         session_id TEXT,
         scope TEXT,
         message TEXT,
         context TEXT
       )`
    ];

    for (const sql of statements) {
      await this.run(sql);
    }

    try {
      await this.run('INSTALL fts');
    } catch {
      // Already installed or unavailable.
    }

    try {
      await this.run('LOAD fts');
      await this.run("PRAGMA create_fts_index('turns', 'text')");
    } catch {
      // Keep operating even if FTS extension is unavailable.
    }
  }

  private async clearTables(): Promise<void> {
    const deletes = [
      'DELETE FROM projects',
      'DELETE FROM sessions',
      'DELETE FROM turns',
      'DELETE FROM tools',
      'DELETE FROM thinking_blocks',
      'DELETE FROM stats_daily',
      'DELETE FROM parse_errors'
    ];
    for (const sql of deletes) {
      await this.run(sql);
    }
  }

  private async refreshDailyStats(): Promise<void> {
    await this.run('DELETE FROM stats_daily');
    await this.run(`
      INSERT INTO stats_daily (day, session_count, turn_count, prompt_tokens, completion_tokens)
      SELECT
        CAST(date_trunc('day', coalesce(updated_at, started_at, current_timestamp)) AS DATE) as day,
        count(*) as session_count,
        coalesce(sum(turn_count), 0) as turn_count,
        coalesce(sum(prompt_sum), 0) as prompt_tokens,
        coalesce(sum(completion_sum), 0) as completion_tokens
      FROM (
        SELECT
          s.id,
          s.updated_at,
          s.started_at,
          count(t.turn_index) as turn_count,
          coalesce(sum(t.prompt_tokens), 0) as prompt_sum,
          coalesce(sum(t.completion_tokens), 0) as completion_sum
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        GROUP BY s.id, s.updated_at, s.started_at
      ) grouped
      GROUP BY day
      ORDER BY day
    `);
  }

  private async run(sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.conn.run(sql, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async all(sql: string): Promise<unknown[]> {
    return await new Promise<unknown[]>((resolve, reject) => {
      this.conn.all(sql, (err: Error | null, rows: unknown[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullable(value: string | null): string {
  if (value === null) return 'NULL';
  return quote(value);
}

function sqlTime(value: string | null): string {
  if (!value) return 'NULL';
  return `TIMESTAMP ${quote(value)}`;
}

export async function createIndexerFromConfig(config: TraceVaultConfig): Promise<TraceIndexer> {
  const indexer = new TraceIndexer(config.index.path);
  await indexer.init();
  return indexer;
}
