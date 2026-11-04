import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { argv, type Operation } from '../../src/core/operations.ts';
import { readOperationState } from '../../src/git/state.ts';
import { GitOpError, runGitOp } from '../../src/git/op.ts';
import { tempDir } from './helpers.ts';

const ids = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@e', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@e' };
const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...ids }, encoding: 'utf8' }).trim();
const op = (cwd: string, o: Operation) => runGitOp('git', cwd, argv(o), { env: ids });

describe('operations', () => {
  const root = tempDir('ops');
  let n = 0;
  /** main: base, main1 (f.txt); topic from base: topic1 (f.txt conflicts with main1), topic2 (g.txt); origin clone. */
  const repo = () => {
    const d = join(root, `r${n++}`);
    mkdirSync(d);
    run(d, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(d, 'f.txt'), 'base\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'base');
    run(d, 'checkout', '--quiet', '-b', 'topic');
    writeFileSync(join(d, 'f.txt'), 'topic\n');
    run(d, 'commit', '--quiet', '-am', 'topic1');
    writeFileSync(join(d, 'g.txt'), 'g\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'topic2');
    run(d, 'checkout', '--quiet', 'main');
    writeFileSync(join(d, 'f.txt'), 'main\n');
    run(d, 'commit', '--quiet', '-am', 'main1');
    return d;
  };
  const head = (d: string) => run(d, 'rev-parse', 'HEAD');
  const branch = (d: string) => run(d, 'branch', '--show-current');

  it('switches, detaches, creates and tracks branches', async () => {
    const d = repo();
    await op(d, { kind: 'switch', branch: 'topic', migrate: false });
    assert.equal(branch(d), 'topic');
    await op(d, { kind: 'detach', commit: run(d, 'rev-parse', 'main'), migrate: false });
    assert.equal(branch(d), '');
    await op(d, { kind: 'createBranch', name: 'new/one', at: run(d, 'rev-parse', 'topic~1'), migrate: false });
    assert.equal(branch(d), 'new/one');
    assert.equal(head(d), run(d, 'rev-parse', 'topic~1'));
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', d, c);
    await op(c, { kind: 'trackRemote', name: 'topic', remoteRef: 'refs/remotes/origin/topic', migrate: false });
    assert.equal(branch(c), 'topic');
    assert.equal(run(c, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
  });

  it('carries uncommitted changes with migrate', async () => {
    const d = repo();
    writeFileSync(join(d, 'f.txt'), 'dirty\n');
    await assert.rejects(op(d, { kind: 'switch', branch: 'topic', migrate: false }), (e: unknown) => {
      return e instanceof GitOpError && e.kind === 'localChanges';
    });
    await op(d, { kind: 'switch', branch: 'topic', migrate: true });
    assert.equal(branch(d), 'topic');
    assert.equal(
      run(d, 'diff', '--name-only', '--diff-filter=U'),
      'f.txt',
      'switch --merge succeeds even when it leaves a conflict: callers must look for one',
    );
  });

  it('creates lightweight and annotated tags, renames and deletes', async () => {
    const d = repo();
    await op(d, { kind: 'createTag', name: 'v1', at: head(d), message: undefined });
    await op(d, { kind: 'createTag', name: 'v2', at: head(d), message: 'Release 2' });
    assert.equal(run(d, 'cat-file', '-t', 'v1'), 'commit');
    assert.equal(run(d, 'cat-file', '-t', 'v2'), 'tag');
    await op(d, { kind: 'renameBranch', from: 'topic', to: 'renamed' });
    assert.equal(run(d, 'branch', '--list', 'renamed'), 'renamed');
    await op(d, { kind: 'deleteBranch', name: 'renamed' });
    assert.equal(
      run(d, 'branch', '--list', 'renamed'),
      '',
      'unmerged branches are deleted too (Strata confirms first)',
    );
    await op(d, { kind: 'deleteTag', name: 'v2' });
    assert.equal(run(d, 'tag', '--list'), 'v1');
  });

  it('stashes only the paths named, untracked ones included', async () => {
    const d = repo();
    writeFileSync(join(d, 'f.txt'), 'dirty\n');
    writeFileSync(join(d, 'new [1].txt'), 'mine\n');
    writeFileSync(join(d, 'other.txt'), 'stays\n');
    await op(d, { kind: 'stashPush', message: 'some', untracked: 'unignored', paths: ['f.txt', 'new [1].txt'] });
    assert.equal(run(d, 'status', '--porcelain'), '?? other.txt');
    assert.equal(run(d, 'show', '--format=', '--name-only', 'stash@{0}^3'), 'new [1].txt');
  });

  it('puts a deleted branch back without switching to it, with its configuration', async () => {
    const d = repo();
    const tip = run(d, 'rev-parse', 'topic');
    run(d, 'config', 'branch.topic.description', 'first');
    run(d, 'branch', '--delete', '--force', '--quiet', 'topic');
    assert.throws(() => run(d, 'config', 'branch.topic.description'), 'git drops the branch section');
    await op(d, { kind: 'branchAt', name: 'topic', at: tip });
    await op(d, { kind: 'configAdd', key: 'branch.topic.description', value: 'first' });
    assert.equal(run(d, 'rev-parse', 'topic'), tip);
    assert.equal(run(d, 'config', 'branch.topic.description'), 'first');
    assert.equal(branch(d), 'main');
  });

  it('merges with and without fast-forward, with autostash', async () => {
    const d = repo();
    run(d, 'checkout', '--quiet', '-b', 'ahead', 'main');
    writeFileSync(join(d, 'h.txt'), 'h\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'ahead1');
    run(d, 'checkout', '--quiet', 'main');
    appendFileSync(join(d, 'f.txt'), 'dirty\n');
    await op(d, { kind: 'merge', ref: 'refs/heads/ahead', mode: 'ff', autostash: true });
    assert.equal(head(d), run(d, 'rev-parse', 'ahead'), 'fast-forwarded');
    assert.match(run(d, 'diff', '--name-only'), /f\.txt/, 'changes came back');
    run(d, 'reset', '--quiet', '--hard', 'main~1');
    await op(d, { kind: 'merge', ref: 'refs/heads/ahead', mode: 'noFastForward', autostash: false });
    assert.equal(run(d, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3, 'merge commit');
  });

  it("merges as the button says, whatever the branch's merge options", async () => {
    const d = repo();
    run(d, 'checkout', '--quiet', '-b', 'ahead', 'main');
    writeFileSync(join(d, 'h.txt'), 'h\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'ahead1');
    run(d, 'checkout', '--quiet', 'main');
    run(d, 'config', 'branch.main.mergeoptions', '--squash --no-commit');
    run(d, 'config', 'merge.ff', 'false');
    await op(d, { kind: 'merge', ref: 'ahead', mode: 'ff', autostash: false });
    assert.equal(head(d), run(d, 'rev-parse', 'ahead'), 'fast-forwarded, not squashed or left uncommitted');
  });

  it('rebases only the current branch, replaying merged commits one by one, whatever the config', async () => {
    const d = repo();
    const commitOn = (branch: string, from: string, file: string) => {
      run(d, 'checkout', '--quiet', '-b', branch, from);
      writeFileSync(join(d, file), `${file}\n`);
      run(d, 'add', '.');
      run(d, 'commit', '--quiet', '-m', file);
    };
    commitOn('side', 'main~1', 's.txt');
    commitOn('onto', 'main~1', 'o.txt');
    run(d, 'checkout', '--quiet', 'topic');
    run(d, 'merge', '--quiet', '--no-ff', '--no-edit', 'side');
    run(d, 'branch', 'stacked', 'topic^1~1');
    const stacked = run(d, 'rev-parse', 'stacked');
    run(d, 'config', 'rebase.updateRefs', 'true');
    run(d, 'config', 'rebase.rebaseMerges', 'true');
    await op(d, { kind: 'rebase', onto: run(d, 'rev-parse', 'onto'), from: undefined, autostash: false });
    assert.equal(run(d, 'rev-parse', 'stacked'), stacked, 'no other branch moved');
    assert.equal(run(d, 'rev-list', '--count', '--merges', 'onto..topic'), '0', 'the merge is dropped');
    assert.equal(run(d, 'rev-list', '--count', 'onto..topic'), '3', "its side's commit is replayed");
  });

  it('stops a rebase at a conflict, then continues after resolving', async () => {
    const d = repo();
    run(d, 'checkout', '--quiet', 'topic');
    await assert.rejects(
      op(d, { kind: 'rebase', onto: run(d, 'rev-parse', 'main'), from: undefined, autostash: false }),
      {
        kind: 'conflict',
      },
    );
    assert.equal((await readOperationState('git', d))?.kind, 'rebase');
    writeFileSync(join(d, 'f.txt'), 'resolved\n');
    run(d, 'add', 'f.txt');
    await op(d, { kind: 'continue', operation: 'rebase' });
    assert.equal(await readOperationState('git', d), undefined);
    assert.equal(run(d, 'log', '--format=%s', '-3'), 'topic2\ntopic1\nmain1');
  });

  it('concludes a merge after resolving with the message git prepared, without its conflict notes', async () => {
    const d = repo();
    await assert.rejects(op(d, { kind: 'merge', ref: 'topic', mode: 'ff', autostash: false }), {
      kind: 'conflict',
    });
    writeFileSync(join(d, 'f.txt'), 'resolved\n');
    run(d, 'add', 'f.txt');
    await op(d, { kind: 'continue', operation: 'merge' });
    assert.equal(await readOperationState('git', d), undefined);
    assert.equal(run(d, 'log', '-1', '--format=%B'), "Merge branch 'topic'");
  });

  it('aborts and skips', async () => {
    const d = repo();
    const before = head(d);
    await assert.rejects(op(d, { kind: 'merge', ref: 'refs/heads/topic', mode: 'ff', autostash: false }), {
      kind: 'conflict',
    });
    await op(d, { kind: 'abort', operation: 'merge' });
    assert.equal(head(d), before);
    await assert.rejects(op(d, { kind: 'cherryPick', commit: run(d, 'rev-parse', 'topic~1') }));
    await op(d, { kind: 'skip', operation: 'cherryPick' });
    assert.equal(await readOperationState('git', d), undefined);
    assert.equal(head(d), before);
  });

  it('cherry-picks, reverts and resets in every mode', async () => {
    const d = repo();
    await op(d, { kind: 'cherryPick', commit: run(d, 'rev-parse', 'topic') });
    assert.equal(run(d, 'log', '-1', '--format=%s'), 'topic2');
    await op(d, { kind: 'revert', commit: head(d) });
    assert.equal(run(d, 'log', '-1', '--format=%s'), 'Revert "topic2"');
    const base = run(d, 'rev-parse', 'main~3');
    await op(d, { kind: 'reset', commit: run(d, 'rev-parse', 'HEAD~1'), mode: 'soft' });
    assert.notEqual(run(d, 'diff', '--cached', '--name-only'), '');
    await op(d, { kind: 'reset', commit: head(d), mode: 'mixed' });
    assert.equal(run(d, 'diff', '--cached', '--name-only'), '');
    await op(d, { kind: 'reset', commit: base, mode: 'hard' });
    assert.equal(head(d), base);
    assert.equal(run(d, 'status', '--porcelain', '--untracked-files=no'), '');
  });

  it('pushes, stashes, applies, pops, drops, branches from and restores a stash', async () => {
    const d = repo();
    appendFileSync(join(d, 'f.txt'), 'one\n');
    await op(d, { kind: 'stashPush', message: 'first', untracked: 'none' });
    writeFileSync(join(d, 'new.txt'), 'u\n');
    await op(d, { kind: 'stashPush', message: 'second', untracked: 'unignored' });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: second\nOn main: first');
    await op(d, { kind: 'stashApply', index: 1 });
    assert.match(run(d, 'diff', '--name-only'), /f\.txt/);
    run(d, 'checkout', '--quiet', '--', 'f.txt');
    const second = run(d, 'rev-parse', 'stash@{0}');
    await op(d, { kind: 'stashDrop', index: 0 });
    await op(d, { kind: 'stashStore', commit: second, message: 'On main: second' });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: second\nOn main: first');
    await op(d, { kind: 'stashPop', index: 0 });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: first');
    run(d, 'stash', 'push', '--quiet', '--include-untracked');
    await op(d, { kind: 'stashBranch', name: 'from-stash', index: 1 });
    assert.equal(branch(d), 'from-stash');
  });

  it('fetches, and pushes, setting the upstream and forcing with a lease', async () => {
    const origin = repo();
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', origin, c);
    writeFileSync(join(origin, 'o.txt'), 'o\n');
    run(origin, 'add', '.');
    run(origin, 'commit', '--quiet', '-m', 'upstream');
    await op(c, { kind: 'fetch', remote: undefined });
    assert.equal(run(c, 'rev-parse', 'origin/main'), head(origin));
    run(origin, 'checkout', '--quiet', 'topic');
    run(c, 'checkout', '--quiet', '-b', 'published');
    const publish = { kind: 'push', branch: 'published', remote: 'origin', dest: 'refs/heads/published' } as const;
    await op(c, { ...publish, setUpstream: true, forceWithLease: undefined });
    assert.equal(run(c, 'rev-parse', '--abbrev-ref', 'published@{upstream}'), 'origin/published');
    const pushed = head(c);
    run(c, 'reset', '--quiet', '--hard', 'HEAD~1');
    await assert.rejects(op(c, { ...publish, setUpstream: false, forceWithLease: undefined }), { kind: 'rejected' });
    await assert.rejects(op(c, { ...publish, setUpstream: false, forceWithLease: head(c) }), 'a stale lease fails');
    await op(c, { ...publish, setUpstream: false, forceWithLease: pushed });
    assert.equal(run(origin, 'rev-parse', 'published'), head(c));
  });

  it('pushes to an upstream branch of another name', async () => {
    const origin = repo();
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', origin, c);
    run(origin, 'checkout', '--quiet', 'topic');
    run(c, 'checkout', '--quiet', '-b', 'fix', '--track', 'origin/main');
    writeFileSync(join(c, 'fix.txt'), 'fix\n');
    run(c, 'add', '.');
    run(c, 'commit', '--quiet', '-m', 'fix');
    await op(c, {
      kind: 'push',
      branch: 'fix',
      remote: 'origin',
      dest: 'refs/heads/main',
      setUpstream: false,
      forceWithLease: undefined,
    });
    assert.equal(run(origin, 'rev-parse', 'main'), head(c));
    assert.equal(run(origin, 'branch', '--list', 'fix'), '');
  });
});
