import { FileSourceAdapter } from './fileAdapter.js';

export class CodexAdapter extends FileSourceAdapter {
  public constructor(rootPath: string) {
    super('codex', 'Codex CLI', rootPath);
  }
}
