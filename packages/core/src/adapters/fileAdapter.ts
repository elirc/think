import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { AdapterProjectRef, ParseError, Session, SessionRef, Source, SourceId, Turn } from '../types.js';
import { collapseHomePath, expandHomePath } from '../config.js';
import { stableHash } from '../hash.js';
import type { SourceAdapter } from './types.js';

const SUPPORTED_EXTENSIONS = new Set(['.json', '.jsonl', '.log', '.md', '.txt']);

interface UnknownTurnLike {
  timestamp?: string;
  role?: string;
  user?: string;
  assistant?: string;
  content?: unknown;
  text?: string;
  thinking?: string | string[];
  tool_calls?: Array<{ name?: string; args?: unknown; time?: string }>;
  tool_results?: Array<{ output?: unknown; status?: string }>;
  token_usage?: { prompt?: number; completion?: number; thinking?: number };
}

export class FileSourceAdapter implements SourceAdapter {
  public readonly sourceId: SourceId;
  public readonly displayName: string;
  public readonly rootPath: string;

  public constructor(sourceId: SourceId, displayName: string, rootPath: string) {
    this.sourceId = sourceId;
    this.displayName = displayName;
    this.rootPath = expandHomePath(rootPath);
  }

  public asSource(enabled: boolean): Source {
    return {
      id: this.sourceId,
      displayName: this.displayName,
      rootPath: this.rootPath,
      enabled
    };
  }

  public async detect(): Promise<boolean> {
    return existsSync(this.rootPath);
  }

  public async listProjects(): Promise<AdapterProjectRef[]> {
    if (!(await this.detect())) return [];

    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const projects: AdapterProjectRef[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = resolve(join(this.rootPath, entry.name));
      const latest = await this.findLatestActivity(projectPath);
      projects.push(this.makeProject(projectPath, latest));
    }

    if (projects.length === 0) {
      const latest = await this.findLatestActivity(this.rootPath);
      projects.push(this.makeProject(this.rootPath, latest));
    }

    return projects;
  }

  public async listSessions(project: AdapterProjectRef): Promise<SessionRef[]> {
    const files = await this.scanSessionFiles(project.path);
    const refs: SessionRef[] = [];
    for (const filePath of files) {
      const info = await stat(filePath);
      refs.push({
        id: stableHash(`${this.sourceId}:${project.id}:${filePath}`),
        projectId: project.id,
        sourceSessionRef: filePath,
        updatedAt: info.mtime.toISOString()
      });
    }
    return refs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  public async readSession(sessionRef: SessionRef): Promise<Session> {
    const raw = await readFile(sessionRef.sourceSessionRef, 'utf8');
    const parseErrors: ParseError[] = [];
    const turns: Turn[] = [];
    let model: string | null = null;
    let startedAt: string | null = null;
    let updatedAt = sessionRef.updatedAt;
    let metadata: Record<string, unknown> = {};

    const fromJson = this.tryParseAsJson(raw);
    if (fromJson.ok) {
      const normalized = this.normalizeFromJson(fromJson.value);
      turns.push(...normalized.turns);
      parseErrors.push(...normalized.errors);
      model = normalized.model;
      startedAt = normalized.startedAt;
      metadata = normalized.metadata;
    } else {
      const fromJsonl = this.tryParseAsJsonLines(raw);
      if (fromJsonl.ok) {
        turns.push(...fromJsonl.turns);
        parseErrors.push(...fromJsonl.errors);
      } else {
        turns.push({
          index: 0,
          timestamp: null,
          userText: raw,
          assistantText: '',
          thinkingBlocks: [],
          toolCalls: [],
          toolResults: []
        });
        parseErrors.push({
          scope: 'session',
          message: 'Session parsed as raw text fallback',
          context: sessionRef.sourceSessionRef
        });
      }
    }

    const filesReferenced = this.extractFileRefs(raw);
    if (!startedAt && turns.length > 0) startedAt = turns[0]?.timestamp ?? null;
    if (!updatedAt && turns.length > 0) updatedAt = turns.at(-1)?.timestamp ?? null;

    return {
      id: sessionRef.id,
      sourceId: this.sourceId,
      projectId: sessionRef.projectId,
      sourceSessionRef: sessionRef.sourceSessionRef,
      startedAt,
      updatedAt,
      model,
      metadata,
      turns,
      errors: parseErrors,
      filesReferenced
    };
  }

  private makeProject(projectPath: string, lastActivityAt: string | null): AdapterProjectRef {
    return {
      id: stableHash(`${this.sourceId}:${projectPath}`),
      path: projectPath,
      name: basename(projectPath),
      displayPath: collapseHomePath(projectPath),
      lastActivityAt
    };
  }

  private async scanSessionFiles(root: string): Promise<string[]> {
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = resolve(join(dir, entry.name));
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) out.push(full);
      }
    };

    await walk(root);
    return out;
  }

  private async findLatestActivity(projectPath: string): Promise<string | null> {
    const files = await this.scanSessionFiles(projectPath);
    if (files.length === 0) return null;
    let latest = 0;
    for (const file of files) {
      try {
        const info = await stat(file);
        latest = Math.max(latest, info.mtimeMs);
      } catch {
        // Ignore inaccessible files.
      }
    }
    return latest ? new Date(latest).toISOString() : null;
  }

  private tryParseAsJson(raw: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }

  private tryParseAsJsonLines(raw: string): { ok: true; turns: Turn[]; errors: ParseError[] } | { ok: false } {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return { ok: false };

    const turns: Turn[] = [];
    const errors: ParseError[] = [];

    for (const [index, line] of lines.entries()) {
      try {
        const parsed = JSON.parse(line) as UnknownTurnLike;
        turns.push(this.normalizeTurn(index, parsed));
      } catch {
        errors.push({
          scope: 'turn',
          message: 'Invalid JSONL line; stored as plain text',
          context: line.slice(0, 120)
        });
        turns.push({
          index,
          timestamp: null,
          userText: line,
          assistantText: '',
          thinkingBlocks: [],
          toolCalls: [],
          toolResults: []
        });
      }
    }

    return { ok: true, turns, errors };
  }

  private normalizeFromJson(parsed: unknown): {
    turns: Turn[];
    errors: ParseError[];
    model: string | null;
    startedAt: string | null;
    metadata: Record<string, unknown>;
  } {
    const turns: Turn[] = [];
    const errors: ParseError[] = [];
    let model: string | null = null;
    let startedAt: string | null = null;
    let metadata: Record<string, unknown> = {};

    if (Array.isArray(parsed)) {
      for (const [index, item] of parsed.entries()) {
        turns.push(this.normalizeTurn(index, item as UnknownTurnLike));
      }
      return { turns, errors, model, startedAt, metadata };
    }

    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      model = typeof obj.model === 'string' ? obj.model : null;
      startedAt = typeof obj.startedAt === 'string' ? obj.startedAt : null;
      metadata = obj;

      if (Array.isArray(obj.turns)) {
        for (const [index, item] of obj.turns.entries()) {
          turns.push(this.normalizeTurn(index, item as UnknownTurnLike));
        }
      } else if (Array.isArray(obj.messages)) {
        for (const [index, item] of obj.messages.entries()) {
          turns.push(this.normalizeTurn(index, item as UnknownTurnLike));
        }
      } else {
        errors.push({
          scope: 'session',
          message: 'JSON object has no turns/messages array; using serialized fallback'
        });
        turns.push({
          index: 0,
          timestamp: null,
          userText: JSON.stringify(obj, null, 2),
          assistantText: '',
          thinkingBlocks: [],
          toolCalls: [],
          toolResults: []
        });
      }
    } else {
      errors.push({
        scope: 'session',
        message: 'Unsupported JSON structure; using fallback serialization'
      });
      turns.push({
        index: 0,
        timestamp: null,
        userText: String(parsed),
        assistantText: '',
        thinkingBlocks: [],
        toolCalls: [],
        toolResults: []
      });
    }

    return { turns, errors, model, startedAt, metadata };
  }

  private normalizeTurn(index: number, value: UnknownTurnLike): Turn {
    const role = typeof value.role === 'string' ? value.role.toLowerCase() : '';
    const contentText = this.coerceText(value.content ?? value.text ?? '');
    const userText = this.coerceText(value.user ?? (role === 'user' ? contentText : ''));
    const assistantText = this.coerceText(value.assistant ?? (role === 'assistant' ? contentText : ''));
    const thinkingRaw = value.thinking;

    const thinkingBlocks = Array.isArray(thinkingRaw)
      ? thinkingRaw.map((item) => this.coerceText(item)).filter(Boolean)
      : thinkingRaw
        ? [this.coerceText(thinkingRaw)]
        : [];

    const toolCalls = Array.isArray(value.tool_calls)
      ? value.tool_calls.map((call) => ({
          name: typeof call.name === 'string' ? call.name : 'unknown',
          args: this.coerceText(call.args),
          time: typeof call.time === 'string' ? call.time : undefined
        }))
      : [];

    const toolResults = Array.isArray(value.tool_results)
      ? value.tool_results.map((result) => ({
          output: this.coerceText(result.output),
          status: typeof result.status === 'string' ? result.status : undefined
        }))
      : [];

    return {
      index,
      timestamp: typeof value.timestamp === 'string' ? value.timestamp : null,
      userText,
      assistantText,
      thinkingBlocks,
      toolCalls,
      toolResults,
      tokenUsage: value.token_usage
    };
  }

  private coerceText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private extractFileRefs(raw: string): string[] {
    const refs = new Set<string>();
    const regex = /(?:[a-zA-Z]:\\[^\s"']+|\/(?:Users|home|var|etc)\/[\w./-]+)/g;
    for (const match of raw.matchAll(regex)) {
      refs.add(match[0]);
    }
    return [...refs];
  }
}
