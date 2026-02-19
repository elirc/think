import type { AdapterProjectRef, Session, SessionRef, Source, SourceId } from '../types.js';

export interface SourceAdapter {
  readonly sourceId: SourceId;
  readonly displayName: string;
  readonly rootPath: string;

  detect(): Promise<boolean>;
  listProjects(): Promise<AdapterProjectRef[]>;
  listSessions(project: AdapterProjectRef): Promise<SessionRef[]>;
  readSession(sessionRef: SessionRef): Promise<Session>;
  watch?(): AsyncGenerator<SessionRef, void, unknown>;

  asSource(enabled: boolean): Source;
}
