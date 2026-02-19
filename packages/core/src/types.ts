export type SourceId = 'claude' | 'kimi' | 'gemini' | 'copilot' | 'codex' | 'custom';

export interface Source {
  id: SourceId;
  displayName: string;
  rootPath: string;
  enabled: boolean;
}

export interface Project {
  id: string;
  sourceId: SourceId;
  path: string;
  displayPath: string;
  name: string;
  lastActivityAt: string | null;
}

export interface ToolCall {
  name: string;
  args: string;
  time?: string;
}

export interface ToolResult {
  output: string;
  status?: string;
}

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  thinking?: number;
}

export interface Turn {
  index: number;
  timestamp: string | null;
  userText: string;
  assistantText: string;
  thinkingBlocks: string[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  tokenUsage?: TokenUsage;
}

export interface ParseError {
  scope: 'project' | 'session' | 'turn';
  message: string;
  context?: string;
}

export interface Session {
  id: string;
  sourceId: SourceId;
  projectId: string;
  sourceSessionRef: string;
  startedAt: string | null;
  updatedAt: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
  turns: Turn[];
  errors: ParseError[];
  filesReferenced: string[];
}

export interface SourceConfig {
  enabled: boolean;
  path: string;
}

export interface RedactionProfile {
  stripPaths: boolean;
  stripSecrets: boolean;
  stripFileContents: boolean;
}

export interface TraceVaultConfig {
  sources: Record<Exclude<SourceId, 'custom'>, SourceConfig>;
  security: {
    allowedBaseDirs: string[];
    resolveSymlinks: boolean;
  };
  server: {
    host: string;
    port: number;
    openBrowser: boolean;
  };
  index: {
    enabled: boolean;
    path: string;
    watch: boolean;
  };
  redaction: {
    defaultProfile: string;
    profiles: Record<string, RedactionProfile>;
  };
  remote: {
    enabled: boolean;
    workspaceName: string;
    ingestUrl: string;
    token: string;
  };
  auth: {
    token: string;
  };
}

export interface RuntimeService {
  name: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
}

export interface RuntimeState {
  services: Record<string, RuntimeService>;
}

export interface SessionRef {
  id: string;
  projectId: string;
  sourceSessionRef: string;
  updatedAt: string | null;
}

export interface AdapterProjectRef {
  id: string;
  path: string;
  name: string;
  displayPath: string;
  lastActivityAt: string | null;
}
