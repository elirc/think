import { FileSourceAdapter } from './fileAdapter.js';

export class ClaudeAdapter extends FileSourceAdapter {
  public constructor(rootPath: string) {
    super('claude', 'Claude Code', rootPath);
  }
}
