import type { Commit } from './commit.ts';

const FIELDS = ['%H', '%P', '%aN', '%aE', '%at', '%ct', '%s'] as const;

/**
 * `git log` pretty format consumed by {@link LogParser}; use together with `-z`.
 * Every field is NUL-terminated and `-z` adds one more NUL per record, so a
 * record is exactly FIELDS.length + 1 NUL-terminated tokens, the last empty.
 * Fields never contain NUL: git rejects NUL in names and messages.
 */
export const LOG_FORMAT = FIELDS.map((f) => `${f}%x00`).join('');

const TOKENS_PER_RECORD = FIELDS.length + 1;

/** Incremental parser for `git log -z --format=LOG_FORMAT` output split at arbitrary points. */
export class LogParser {
  /** Text after the last NUL seen. */
  private partial = '';
  /** Completed tokens of the record being assembled. */
  private tokens: string[] = [];

  push(chunk: string): Commit[] {
    const out: Commit[] = [];
    let start = 0;
    for (let nul = chunk.indexOf('\0'); nul >= 0; nul = chunk.indexOf('\0', start)) {
      const token = this.partial + chunk.slice(start, nul);
      this.partial = '';
      start = nul + 1;
      this.tokens.push(token);
      if (this.tokens.length === TOKENS_PER_RECORD) {
        out.push(toCommit(this.tokens));
        this.tokens = [];
      }
    }
    this.partial += chunk.slice(start);
    return out;
  }

  /** Call at end of stream; throws if a partial record is left over. */
  end(): void {
    // tformat ends the last record with a newline, but -z replaces it with NUL; nothing may remain.
    if (this.tokens.length > 0 || this.partial !== '') {
      throw new Error(
        `git log output truncated: ${this.tokens.length} fields and ${this.partial.length} chars pending`,
      );
    }
  }
}

function toCommit(t: string[]): Commit {
  const [hash, parents, author, authorEmail, authorTime, commitTime, subject, terminator] = t as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (terminator !== '' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(hash)) {
    throw new Error(`unexpected git log record for ${JSON.stringify(hash)}`);
  }
  return {
    hash,
    parents: parents === '' ? [] : parents.split(' '),
    author,
    authorEmail,
    authorTime: Number(authorTime),
    commitTime: Number(commitTime),
    subject,
  };
}
