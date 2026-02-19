import type { RedactionProfile, Session } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key\s*[:=]\s*["']?[a-z0-9_\-]{12,}["']?)/gi,
  /(token\s*[:=]\s*["']?[a-z0-9_\-]{12,}["']?)/gi,
  /(sk-[a-z0-9]{16,})/gi,
  /(ghp_[a-z0-9]{20,})/gi
];

const ABS_PATH = /([a-zA-Z]:\\[^\s"']+|\/(Users|home|var|etc)\/[\w./-]+)/g;
const FILE_CONTENT_HINT = /```[\s\S]*?```/g;

function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of input) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redactSecrets(input: string): string {
  let redacted = input;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }

  const tokens = redacted.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.length >= 24 && shannonEntropy(token) >= 3.7) {
      tokens[i] = '[REDACTED_HIGH_ENTROPY]';
    }
  }
  return tokens.join('');
}

export function redactText(input: string, profile: RedactionProfile): string {
  let output = input;
  if (profile.stripSecrets) {
    output = redactSecrets(output);
  }
  if (profile.stripPaths) {
    output = output.replace(ABS_PATH, '[REDACTED_PATH]');
  }
  if (profile.stripFileContents) {
    output = output.replace(FILE_CONTENT_HINT, '[REDACTED_FILE_CONTENT]');
  }
  return output;
}

export function redactSession(session: Session, profile: RedactionProfile): Session {
  return {
    ...session,
    sourceSessionRef: profile.stripPaths ? '[REDACTED_PATH]' : session.sourceSessionRef,
    turns: session.turns.map((turn) => ({
      ...turn,
      userText: redactText(turn.userText, profile),
      assistantText: redactText(turn.assistantText, profile),
      thinkingBlocks: turn.thinkingBlocks.map((block) => redactText(block, profile)),
      toolCalls: turn.toolCalls.map((call) => ({
        ...call,
        args: redactText(call.args, profile)
      })),
      toolResults: turn.toolResults.map((result) => ({
        ...result,
        output: redactText(result.output, profile)
      }))
    })),
    filesReferenced: profile.stripPaths ? [] : session.filesReferenced
  };
}
