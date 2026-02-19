import type { AdapterProjectRef, Project, Session, SessionRef, Source, SourceId, TraceVaultConfig } from './types.js';
import { buildAdapters } from './adapters/index.js';
import type { SourceAdapter } from './adapters/types.js';

interface ProjectCacheEntry {
  adapter: SourceAdapter;
  project: AdapterProjectRef;
}

export class TraceVaultService {
  private readonly config: TraceVaultConfig;
  private readonly adapters: SourceAdapter[];

  public constructor(config: TraceVaultConfig, adapters: SourceAdapter[] = buildAdapters(config)) {
    this.config = config;
    this.adapters = adapters;
  }

  public getConfig(): TraceVaultConfig {
    return this.config;
  }

  public async listSources(): Promise<Source[]> {
    const out: Source[] = [];
    for (const adapter of this.adapters) {
      const enabled = this.config.sources[adapter.sourceId as keyof TraceVaultConfig['sources']]?.enabled ?? false;
      out.push(adapter.asSource(enabled));
    }
    return out;
  }

  public async sourceStatus(): Promise<Array<Source & { detected: boolean }>> {
    const statuses: Array<Source & { detected: boolean }> = [];
    for (const adapter of this.adapters) {
      const enabled = this.config.sources[adapter.sourceId as keyof TraceVaultConfig['sources']]?.enabled ?? false;
      const detected = await adapter.detect();
      statuses.push({ ...adapter.asSource(enabled), detected });
    }
    return statuses;
  }

  public async listProjects(filterSourceId?: SourceId): Promise<Project[]> {
    const projects: Project[] = [];
    for (const adapter of this.adapters) {
      if (filterSourceId && adapter.sourceId !== filterSourceId) continue;
      const enabled = this.config.sources[adapter.sourceId as keyof TraceVaultConfig['sources']]?.enabled ?? false;
      if (!enabled) continue;
      if (!(await adapter.detect())) continue;

      const adapterProjects = await adapter.listProjects();
      for (const project of adapterProjects) {
        projects.push({
          id: project.id,
          sourceId: adapter.sourceId,
          path: project.path,
          displayPath: project.displayPath,
          name: project.name,
          lastActivityAt: project.lastActivityAt
        });
      }
    }

    return projects.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  public async listSessions(projectId: string): Promise<SessionRef[]> {
    const projectEntry = await this.findProjectEntry(projectId);
    if (!projectEntry) return [];
    return projectEntry.adapter.listSessions(projectEntry.project);
  }

  public async listAllSessions(): Promise<SessionRef[]> {
    const projects = await this.resolveProjectCache();
    const refs: SessionRef[] = [];
    for (const entry of projects.values()) {
      refs.push(...(await entry.adapter.listSessions(entry.project)));
    }
    return refs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  public async getSession(sessionId: string): Promise<Session | null> {
    const projects = await this.resolveProjectCache();
    for (const entry of projects.values()) {
      const sessions = await entry.adapter.listSessions(entry.project);
      const match = sessions.find((session) => session.id === sessionId);
      if (match) {
        return entry.adapter.readSession(match);
      }
    }
    return null;
  }

  public async resolveSession(sessionId: string): Promise<SessionRef | null> {
    const projects = await this.resolveProjectCache();
    for (const entry of projects.values()) {
      const sessions = await entry.adapter.listSessions(entry.project);
      const match = sessions.find((session) => session.id === sessionId);
      if (match) return match;
    }
    return null;
  }

  public async searchFallback(query: string, limit = 30): Promise<Array<{ sessionId: string; turnIndex: number; text: string }>> {
    const needle = query.toLowerCase();
    const refs = await this.listAllSessions();
    const results: Array<{ sessionId: string; turnIndex: number; text: string }> = [];

    for (const ref of refs) {
      const session = await this.getSession(ref.id);
      if (!session) continue;
      for (const turn of session.turns) {
        const combined = `${turn.userText}\n${turn.assistantText}\n${turn.thinkingBlocks.join('\n')}`;
        if (combined.toLowerCase().includes(needle)) {
          results.push({
            sessionId: session.id,
            turnIndex: turn.index,
            text: combined.slice(0, 400)
          });
          if (results.length >= limit) return results;
        }
      }
    }

    return results;
  }

  public async usageStats(): Promise<{
    totalSessions: number;
    totalTurns: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    toolFrequency: Record<string, number>;
    activityByDay: Record<string, number>;
  }> {
    const refs = await this.listAllSessions();
    let totalTurns = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const toolFrequency: Record<string, number> = {};
    const activityByDay: Record<string, number> = {};

    for (const ref of refs) {
      const session = await this.getSession(ref.id);
      if (!session) continue;
      const day = (session.updatedAt ?? session.startedAt ?? new Date().toISOString()).slice(0, 10);
      activityByDay[day] = (activityByDay[day] ?? 0) + 1;

      for (const turn of session.turns) {
        totalTurns += 1;
        totalPromptTokens += turn.tokenUsage?.prompt ?? 0;
        totalCompletionTokens += turn.tokenUsage?.completion ?? 0;
        for (const call of turn.toolCalls) {
          toolFrequency[call.name] = (toolFrequency[call.name] ?? 0) + 1;
        }
      }
    }

    return {
      totalSessions: refs.length,
      totalTurns,
      totalPromptTokens,
      totalCompletionTokens,
      toolFrequency,
      activityByDay
    };
  }

  private async resolveProjectCache(): Promise<Map<string, ProjectCacheEntry>> {
    const map = new Map<string, ProjectCacheEntry>();
    for (const adapter of this.adapters) {
      const enabled = this.config.sources[adapter.sourceId as keyof TraceVaultConfig['sources']]?.enabled ?? false;
      if (!enabled) continue;
      if (!(await adapter.detect())) continue;
      const projects = await adapter.listProjects();
      for (const project of projects) {
        map.set(project.id, { adapter, project });
      }
    }
    return map;
  }

  private async findProjectEntry(projectId: string): Promise<ProjectCacheEntry | null> {
    const map = await this.resolveProjectCache();
    return map.get(projectId) ?? null;
  }
}
