import type { TraceVaultConfig } from '../types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GenericSourceAdapter } from './stub.js';
import type { SourceAdapter } from './types.js';

export function buildAdapters(config: TraceVaultConfig): SourceAdapter[] {
  return [
    new ClaudeAdapter(config.sources.claude.path),
    new GenericSourceAdapter('kimi', config.sources.kimi.path),
    new GenericSourceAdapter('gemini', config.sources.gemini.path),
    new GenericSourceAdapter('copilot', config.sources.copilot.path),
    new CodexAdapter(config.sources.codex.path)
  ];
}
