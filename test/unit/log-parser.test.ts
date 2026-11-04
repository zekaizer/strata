import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Commit } from '../../src/core/commit.ts';
import { LOG_FORMAT, LogParser } from '../../src/core/log-parser.ts';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const rawLog = (dir: string) => git(dir, 'log', '--all', '--date-order', '-z', `--format=${LOG_FORMAT}`);

/** Reference values computed with a different, newline-separated git invocation. */
function expected(dir: string): Commit[] {
  return git(dir, 'log', '--all', '--date-order', '--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%ct%x1f%s')
    .split('\n')
    .map((l) => {
      const [hash, p, author, authorEmail, at, ct, subject] = l.split('\x1f') as [string, ...string[]];
      return {
        hash,
        parents: p ? p.split(' ') : [],
        author: author!,
        authorEmail: authorEmail!,
        authorTime: Number(at),
        commitTime: Number(ct),
        subject: subject!,
      };
    });
}

function parseAll(chunks: string[]): Commit[] {
  const p = new LogParser();
  const out = chunks.flatMap((c) => p.push(c));
  p.end();
  return out;
}

describe('LogParser', () => {
  const root = tempDir('parser');
  before(() => {
    scenarios.octopus().write(join(root, 'octopus'));
    scenarios['multi-root']().write(join(root, 'multi-root'));
    const b = new RepoBuilder();
    b.commit('main', '한글 커밋 메시지 🎉 with "quotes" and \ttab', { author: 'Zoë Ünïcode <zoe@example.com>' });
    b.commit('main', '');
    b.commit('main', 'subject line\n\nbody paragraph that must not leak into the subject');
    b.write(join(root, 'unicode'));
  });

  for (const name of ['octopus', 'multi-root', 'unicode']) {
    it(`matches git's own field values (${name})`, () => {
      const dir = join(root, name);
      assert.deepEqual(parseAll([rawLog(dir)]), expected(dir));
    });
  }

  it('handles every possible chunk boundary', () => {
    const raw = rawLog(join(root, 'unicode'));
    const whole = parseAll([raw]);
    for (let i = 0; i <= raw.length; i++) {
      assert.deepEqual(parseAll([raw.slice(0, i), raw.slice(i)]), whole, `split at ${i}`);
    }
  });

  it('handles one-character chunks', () => {
    const raw = rawLog(join(root, 'octopus'));
    // Code points: the stream decoder never splits a character.
    assert.deepEqual(parseAll(Array.from(raw)), parseAll([raw]));
  });

  it('emits commits as soon as their record is complete', () => {
    const raw = rawLog(join(root, 'octopus'));
    const p = new LogParser();
    const firstEnd = raw.indexOf('\0\0') + 2;
    assert.equal(p.push(raw.slice(0, firstEnd - 1)).length, 0);
    assert.equal(p.push(raw.slice(firstEnd - 1, firstEnd)).length, 1);
  });

  it('rejects a truncated stream', () => {
    const raw = rawLog(join(root, 'octopus'));
    const p = new LogParser();
    p.push(raw.slice(0, raw.length - 5));
    assert.throws(() => {
      p.end();
    }, /truncated/);
  });
});
