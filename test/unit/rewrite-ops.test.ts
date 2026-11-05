import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { argv, env, type Operation } from '../../src/core/operations.ts';
import { GitOpError, runOperation } from '../../src/git/op.ts';
import { readOperationState } from '../../src/git/state.ts';
import { tempDir } from './helpers.ts';

const ids = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@e', GIT_COMMITTER_NAME: 'c', GIT_COMMITTER_EMAIL: 'c@e' };
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...ids }, encoding: 'utf8' }).trim();
const op = (cwd: string, o: Operation) => runOperation('git', cwd, o, { env: ids });

const author = { name: 'Ada Writer', email: 'ada@example.com', date: '1700000000 +0900' };

describe('history rewriting operations', () => {
  it('builds commit-tree, update-ref and rebase -i command lines', () => {
    assert.deepEqual(argv({ kind: 'commitTree', tree: 't', parents: ['p1'], message: 'm\n', author, sign: false }), [
      'commit-tree',
      '-p',
      'p1',
      '-m',
      'm\n',
      't',
    ]);
    assert.deepEqual(argv({ kind: 'commitTree', tree: 't', parents: [], message: 'm', author, sign: true }), [
      'commit-tree',
      '-S',
      '-m',
      'm',
      't',
    ]);
    assert.deepEqual(argv({ kind: 'updateRef', ref: 'refs/heads/main', to: 'n', from: 'o', reason: 'strata: x' }), [
      'update-ref',
      '-m',
      'strata: x',
      'refs/heads/main',
      'n',
      'o',
    ]);
    assert.deepEqual(argv({ kind: 'updateRef', ref: 'HEAD', to: 'n', from: 'o', reason: 'r' }), [
      'update-ref',
      '--no-deref',
      '-m',
      'r',
      'HEAD',
      'n',
      'o',
    ]);
    const rebase = (base: string | undefined, autostash: boolean) =>
      argv({ kind: 'rebaseTodo', base, todoPath: '/x', autostash });
    assert.deepEqual(rebase('b', false).slice(-4), ['rebase', '--interactive', '--no-autostash', 'b']);
    assert.deepEqual(rebase(undefined, true).slice(-4), ['rebase', '--interactive', '--autostash', '--root']);
    assert.ok(rebase('b', false).includes('rebase.updateRefs=false'), 'no other branch moves');
    assert.ok(rebase('b', false).includes('rebase.autoSquash=false'), 'only the todo Strata wrote runs');
  });

  it('keeps the author and the date, and hands git the todo through the sequence editor', () => {
    assert.deepEqual(env({ kind: 'commitTree', tree: 't', parents: [], message: 'm', author, sign: false }), {
      GIT_AUTHOR_NAME: 'Ada Writer',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '@1700000000 +0900',
    });
    assert.deepEqual(env({ kind: 'rebaseTodo', base: 'b', todoPath: "/a dir/it's todo", autostash: false }), {
      GIT_SEQUENCE_EDITOR: `cp '/a dir/it'\\''s todo'`,
    });
    assert.deepEqual(env({ kind: 'reset', commit: 'c', mode: 'keep' }), {});
  });

  const root = tempDir('rewrite-ops');
  let n = 0;
  /** main: c1..c4, each adding its own file. */
  const repo = () => {
    const d = join(root, `r${n++}`);
    mkdirSync(d);
    run(d, 'init', '--quiet', '-b', 'main');
    for (const i of [1, 2, 3, 4]) {
      writeFileSync(join(d, `f${i}.txt`), `${i}\n`);
      run(d, 'add', '.');
      run(d, 'commit', '--quiet', '-m', `c${i}`);
    }
    return d;
  };

  it('writes a commit with the original author and moves the branch only from where it was', async () => {
    const d = repo();
    const old = run(d, 'rev-parse', 'HEAD');
    const { stdout } = await op(d, {
      kind: 'commitTree',
      tree: run(d, 'rev-parse', 'HEAD^{tree}'),
      parents: [run(d, 'rev-parse', 'HEAD~1')],
      message: 'c4 reworded\n\n# kept\n',
      author,
      sign: false,
    });
    const made = stdout.trim();
    assert.equal(
      run(d, 'log', '-1', '--format=%an <%ae> %ad|%cn|%B', '--date=raw', made),
      'Ada Writer <ada@example.com> 1700000000 +0900|c|c4 reworded\n\n# kept',
    );
    await assert.rejects(
      op(d, { kind: 'updateRef', ref: 'refs/heads/main', to: made, from: made, reason: 'strata: test' }),
      GitOpError,
    );
    assert.equal(run(d, 'rev-parse', 'main'), old, 'a stale old value moves nothing');
    await op(d, { kind: 'updateRef', ref: 'refs/heads/main', to: made, from: old, reason: 'strata: reword c4' });
    assert.equal(run(d, 'rev-parse', 'HEAD'), made);
    assert.equal(run(d, 'reflog', '-1', '--format=%gs', 'main'), 'strata: reword c4');
  });

  it('signs only when asked, and a failed signature fails the operation', async () => {
    const d = repo();
    run(d, 'config', 'gpg.program', 'false');
    run(d, 'config', 'commit.gpgSign', 'true');
    const commit = (sign: boolean) =>
      op(d, { kind: 'commitTree', tree: run(d, 'rev-parse', 'HEAD^{tree}'), parents: [], message: 'x', author, sign });
    await commit(false);
    await assert.rejects(commit(true), GitOpError);
  });

  it('runs the todo Strata wrote: drops, fixups out of order, and a todo of nothing', async () => {
    const d = repo();
    const [c1, c2, c3, c4] = [4, 3, 2, 1].map((k) => run(d, 'rev-parse', `HEAD~${k - 1}`));
    const todoPath = join(d, '.git', 'strata todo');
    writeFileSync(todoPath, `pick ${c2}\nfixup ${c4}\ndrop ${c3}\n`);
    await op(d, { kind: 'rebaseTodo', base: c1, todoPath, autostash: false });
    assert.equal(run(d, 'log', '--format=%s').split('\n').join(' '), 'c2 c1');
    assert.equal(run(d, 'ls-tree', '--name-only', 'HEAD').split('\n').join(' '), 'f1.txt f2.txt f4.txt');
    writeFileSync(todoPath, 'noop\n');
    await op(d, { kind: 'rebaseTodo', base: c1, todoPath, autostash: false });
    assert.equal(run(d, 'rev-parse', 'HEAD'), c1);
  });

  it('stops at a conflicting fixup with git keeping the rebase in progress', async () => {
    const d = repo();
    for (const t of ['a', 'b', 'c']) {
      writeFileSync(join(d, 'f1.txt'), `${t}\n`);
      run(d, 'commit', '--quiet', '-am', `f1 ${t}`);
    }
    const [a, b, c] = [2, 1, 0].map((k) => run(d, 'rev-parse', `HEAD~${k}`));
    const todoPath = join(d, '.git', 'strata-todo');
    writeFileSync(todoPath, `pick ${a}\nfixup ${c}\npick ${b}\n`);
    const mtime = statSync(join(d, 'f2.txt')).mtimeMs;
    await assert.rejects(
      op(d, { kind: 'rebaseTodo', base: run(d, 'rev-parse', `${a}~1`), todoPath, autostash: false }),
    );
    const state = await readOperationState('git', d);
    assert.equal(state?.kind, 'rebase');
    assert.equal(statSync(join(d, 'f2.txt')).mtimeMs, mtime);
  });
});
