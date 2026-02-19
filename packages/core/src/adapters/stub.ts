import { FileSourceAdapter } from './fileAdapter.js';
import type { SourceId } from '../types.js';

const DISPLAY_NAMES: Record<SourceId, string> = {
  claude: 'Claude Code',
  kimi: 'Kimi Code',
  gemini: 'Gemini CLI',
  copilot: 'Copilot CLI',
  codex: 'Codex CLI',
  custom: 'Custom'
};

export class GenericSourceAdapter extends FileSourceAdapter {
  public constructor(sourceId: Exclude<SourceId, 'custom'>, rootPath: string) {
    super(sourceId, DISPLAY_NAMES[sourceId], rootPath);
  }
}
