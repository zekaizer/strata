import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { untrackedInTheWay, untrackedNotRestored } from '../../src/core/git-error.ts';
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

  it('creates a lightweight tag and puts back a deleted tag as it was, whatever tag.gpgSign says', async () => {
    const d = repo();
    run(d, 'config', 'tag.gpgSign', 'true');
    await op(d, { kind: 'createTag', name: 'v1', at: head(d), message: undefined });
    assert.equal(run(d, 'cat-file', '-t', 'v1'), 'commit');
    run(d, '-c', 'tag.gpgSign=false', 'tag', '--annotate', '--message', 'Release 2', 'v2', head(d));
    const object = run(d, 'rev-parse', 'refs/tags/v2');
    run(d, 'tag', '--delete', 'v2');
    await op(d, { kind: 'restoreTag', name: 'v2', object });
    assert.equal(run(d, 'rev-parse', 'refs/tags/v2'), object, 'the same tag object, not a tag of it');
    run(d, 'tag', '--delete', 'v1');
    await op(d, { kind: 'restoreTag', name: 'v1', object: head(d) });
    assert.equal(run(d, 'cat-file', '-t', 'v1'), 'commit');
    run(d, 'update-ref', 'refs/tags/v1', 'topic');
    await assert.rejects(op(d, { kind: 'restoreTag', name: 'v1', object: head(d) }), GitOpError);
    assert.equal(run(d, 'rev-parse', 'v1'), run(d, 'rev-parse', 'topic'), 'a tag that came back meanwhile stays');
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

  it('puts paths back as HEAD has them, staged, unstaged, deleted or added', async () => {
    const d = repo();
    writeFileSync(join(d, 'f.txt'), 'staged\n');
    run(d, 'add', 'f.txt');
    writeFileSync(join(d, 'f.txt'), 'unstaged\n');
    writeFileSync(join(d, 'new [1].txt'), 'added\n');
    run(d, 'add', 'new [1].txt');
    writeFileSync(join(d, 'other.txt'), 'stays\n');
    await op(d, { kind: 'restoreHead', paths: ['f.txt', 'new [1].txt'] });
    assert.equal(run(d, 'status', '--porcelain'), '?? other.txt');
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

  it('cherry-picks and reverts a merge relative to the parent given', async () => {
    const d = repo();
    run(d, 'switch', '--quiet', '--create', 'side', 'main~1');
    writeFileSync(join(d, 'h.txt'), 'h\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'side1');
    run(d, 'switch', '--quiet', 'topic');
    run(d, 'merge', '--quiet', '--no-ff', '--no-edit', 'side');
    const merge = head(d);
    const show = (rev: string) => run(d, 'ls-tree', '--name-only', rev);

    run(d, 'switch', '--quiet', 'main');
    await op(d, { kind: 'cherryPick', commit: merge, mainline: 1 });
    assert.equal(show('HEAD'), 'f.txt\nh.txt', 'side1 only: topic is parent 1');
    assert.equal(run(d, 'cat-file', '-p', 'HEAD:f.txt'), 'main');

    run(d, 'switch', '--quiet', 'topic');
    await op(d, { kind: 'revert', commit: merge, mainline: 1 });
    assert.equal(show('HEAD'), show(`${merge}^1`), "side1's changes undone");

    run(d, 'switch', '--quiet', '--create', 'from-side', 'side');
    await op(d, { kind: 'cherryPick', commit: merge, mainline: 2 });
    assert.equal(show('HEAD'), 'f.txt\ng.txt\nh.txt', "topic's commits, relative to side");
  });

  it('fails a revert of an already reverted commit as nothing to commit, leaving no revert in progress', async () => {
    const d = repo();
    const main1 = head(d);
    await op(d, { kind: 'revert', commit: main1 });
    const reverted = head(d);
    await assert.rejects(op(d, { kind: 'revert', commit: main1 }), { kind: 'nothingToCommit' });
    assert.equal(await readOperationState('git', d), undefined);
    assert.equal(head(d), reverted);
  });

  it('pushes, stashes, applies, pops, drops, branches from and restores a stash', async () => {
    const d = repo();
    appendFileSync(join(d, 'f.txt'), 'one\n');
    await op(d, { kind: 'stashPush', message: 'first', untracked: 'none' });
    writeFileSync(join(d, 'new.txt'), 'u\n');
    await op(d, { kind: 'stashPush', message: 'second', untracked: 'unignored' });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: second\nOn main: first');
    await op(d, { kind: 'stashApply', index: 1, withIndex: false });
    assert.match(run(d, 'diff', '--name-only'), /f\.txt/);
    run(d, 'checkout', '--quiet', '--', 'f.txt');
    const second = run(d, 'rev-parse', 'stash@{0}');
    await op(d, { kind: 'stashDrop', index: 0 });
    await op(d, { kind: 'stashStore', commit: second, message: 'On main: second' });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: second\nOn main: first');
    await op(d, { kind: 'stashPop', index: 0, withIndex: false });
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On main: first');
    run(d, 'stash', 'push', '--quiet', '--include-untracked');
    await op(d, { kind: 'stashBranch', name: 'from-stash', index: 1 });
    assert.equal(branch(d), 'from-stash');
  });

  it('applies and pops a stash with its staged changes staged again', async () => {
    const d = repo();
    appendFileSync(join(d, 'f.txt'), 'staged\n');
    run(d, 'add', 'f.txt');
    await op(d, { kind: 'stashPush', message: 'staged', untracked: 'none' });
    await op(d, { kind: 'stashApply', index: 0, withIndex: true });
    assert.equal(run(d, 'diff', '--cached', '--name-only'), 'f.txt');
    run(d, 'reset', '--hard', '--quiet');
    await op(d, { kind: 'stashPop', index: 0, withIndex: true });
    assert.equal(run(d, 'diff', '--cached', '--name-only'), 'f.txt');
    assert.equal(run(d, 'stash', 'list'), '');
  });

  it('fetches more history into a shallow clone, or all of it', async () => {
    const origin = repo();
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', '--depth', '1', '--branch', 'topic', `file://${origin}`, c);
    assert.equal(run(c, 'rev-list', '--count', 'HEAD'), '1');
    await op(c, { kind: 'fetch', remote: undefined, deepen: 1 });
    assert.equal(run(c, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(run(c, 'rev-parse', '--is-shallow-repository'), 'true');
    await op(c, { kind: 'fetch', remote: 'origin', unshallow: true });
    assert.equal(run(c, 'rev-list', '--count', 'HEAD'), '3');
    assert.equal(run(c, 'rev-parse', '--is-shallow-repository'), 'false');
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

  it('deletes a remote branch, only where the lease still holds, and drops its remote-tracking branch', async () => {
    const origin = repo();
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', origin, c);
    const at = run(c, 'rev-parse', 'origin/topic');
    const del = { kind: 'deleteRemoteRef', remote: 'origin', ref: 'refs/heads/topic' } as const;
    await assert.rejects(op(c, { ...del, lease: run(c, 'rev-parse', 'origin/main') }), { kind: 'rejected' });
    assert.equal(run(origin, 'rev-parse', 'topic'), at, 'a stale lease deletes nothing');
    await op(c, { ...del, lease: at });
    assert.equal(run(origin, 'branch', '--list', 'topic'), '');
    assert.equal(run(c, 'branch', '--remotes', '--list', 'origin/topic'), '');
  });

  it('pushes a tag, refusing to replace a different tag of that name', async () => {
    const origin = repo();
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', origin, c);
    run(c, 'tag', '--annotate', '--message', 'v1', 'v1', 'main');
    await op(c, { kind: 'pushTag', remote: 'origin', tag: 'v1' });
    assert.equal(run(origin, 'rev-parse', 'v1'), run(c, 'rev-parse', 'v1'));
    await op(c, { kind: 'pushTag', remote: 'origin', tag: 'v1' });
    run(c, 'tag', '--force', 'v1', 'main');
    await assert.rejects(op(c, { kind: 'pushTag', remote: 'origin', tag: 'v1' }), { kind: 'tagExists' });
    await op(c, { kind: 'deleteRemoteRef', remote: 'origin', ref: 'refs/tags/v1', lease: undefined });
    assert.equal(run(origin, 'tag', '--list', 'v1'), '');
    assert.equal(run(c, 'tag', '--list', 'v1'), 'v1', 'the local tag stays');
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

describe('operations refused by untracked files in the way', () => {
  const root = tempDir('in-the-way');
  let n = 0;
  /**
   * main: base (f.txt, gone.txt, s.txt), then main1 deleting gone.txt. side from base adds new.txt,
   * "two words.txt" and a file `notes`, and changes s.txt. A clone of it tracks origin/side.
   */
  const repo = () => {
    const d = join(root, `r${n++}`);
    mkdirSync(d);
    run(d, 'init', '--quiet', '-b', 'main');
    for (const f of ['f.txt', 'gone.txt', 's.txt']) writeFileSync(join(d, f), 'base\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'base');
    run(d, 'checkout', '--quiet', '-b', 'side');
    for (const f of ['new.txt', 'two words.txt', 'notes', 's.txt']) writeFileSync(join(d, f), 'side\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'side');
    run(d, 'checkout', '--quiet', 'main');
    run(d, 'rm', '--quiet', 'gone.txt');
    run(d, 'commit', '--quiet', '-m', 'main1');
    return d;
  };
  const mine = (d: string, ...files: string[]) => {
    for (const f of files) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), 'mine\n');
    }
  };
  /** Runs `o`, which git must refuse, and resolves its error once nothing is left in progress. */
  const refused = async (d: string, o: Operation) => {
    const before = run(d, 'rev-parse', 'HEAD');
    const e = await op(d, o).then(
      () => assert.fail(`${o.kind} ran`),
      (e: unknown) => e,
    );
    assert.ok(e instanceof GitOpError);
    assert.equal(await readOperationState('git', d), undefined, 'nothing in progress');
    assert.equal(run(d, 'rev-parse', 'HEAD'), before, 'HEAD did not move');
    return e;
  };
  const blocks = async (d: string, o: Operation, paths: string[]) => {
    const e = await refused(d, o);
    assert.equal(e.kind, 'untrackedOverwrite');
    assert.deepEqual(untrackedInTheWay(e.stderr), paths);
  };
  const side = (d: string) => run(d, 'rev-parse', 'side');
  const both = ['new.txt', 'two words.txt'];

  it('lists them for a switch, a detach and a new branch', async () => {
    const d = repo();
    mine(d, ...both);
    await blocks(d, { kind: 'switch', branch: 'side', migrate: false }, both);
    await blocks(d, { kind: 'detach', commit: side(d), migrate: false }, both);
    await blocks(d, { kind: 'createBranch', name: 'nb', at: side(d), migrate: false }, both);
  });

  it('lists them for a checkout of a remote branch', async () => {
    const c = join(root, `clone${n++}`);
    run(root, 'clone', '--quiet', repo(), c);
    mine(c, ...both);
    await blocks(c, { kind: 'trackRemote', name: 'side', remoteRef: 'refs/remotes/origin/side', migrate: false }, both);
  });

  it('lists them for a merge and a rebase, with or without the autostash', async () => {
    const d = repo();
    mine(d, ...both);
    await blocks(d, { kind: 'merge', ref: 'side', mode: 'ff', autostash: false }, both);
    await blocks(d, { kind: 'rebase', onto: side(d), from: undefined, autostash: false }, both);
    writeFileSync(join(d, 'f.txt'), 'dirty\n');
    await blocks(d, { kind: 'merge', ref: 'side', mode: 'noFastForward', autostash: true }, both);
    await blocks(d, { kind: 'rebase', onto: side(d), from: undefined, autostash: true }, both);
    assert.equal(run(d, 'diff', '--name-only'), 'f.txt', 'git put its autostash back');
  });

  it('lists them for a cherry pick and a revert', async () => {
    const d = repo();
    mine(d, ...both);
    await blocks(d, { kind: 'cherryPick', commit: side(d) }, both);
    mine(d, 'gone.txt');
    await blocks(d, { kind: 'revert', commit: run(d, 'rev-parse', 'main') }, ['gone.txt']);
  });

  it('lists them for a branch from a stash made on another commit', async () => {
    const d = repo();
    run(d, 'checkout', '--quiet', 'side');
    writeFileSync(join(d, 'f.txt'), 'stashed\n');
    run(d, 'stash', 'push', '--quiet');
    const stash = run(d, 'rev-parse', 'refs/stash');
    run(d, 'checkout', '--quiet', 'main');
    mine(d, ...both);
    await blocks(d, { kind: 'stashBranch', name: 'nb', index: 0 }, both);
    assert.equal(run(d, 'rev-parse', 'refs/stash'), stash, 'the stash stays');
    assert.equal(run(d, 'branch', '--list', 'nb'), '', 'no branch was made');
  });

  it('names the untracked files of a stash that a branch from it did not restore', async () => {
    const d = repo();
    mine(d, ...both);
    run(d, 'stash', 'push', '--quiet', '--include-untracked');
    mine(d, ...both);
    const e = await op(d, { kind: 'stashBranch', name: 'nb', index: 0 }).then(
      () => assert.fail('stash branch ran'),
      (e: unknown) => e,
    );
    assert.ok(e instanceof GitOpError);
    assert.deepEqual(untrackedNotRestored(e.stderr), both);
    assert.equal(run(d, 'branch', '--show-current'), 'nb', 'git made the branch all the same');
  });

  it('lists a directory whose untracked files a file would replace', async () => {
    const d = repo();
    mine(d, 'notes/a.txt', 'notes/b/c.txt');
    await blocks(d, { kind: 'switch', branch: 'side', migrate: false }, ['notes']);
    mine(d, 'new.txt');
    await blocks(d, { kind: 'switch', branch: 'side', migrate: false }, ['notes', 'new.txt']);
  });

  it('lists none when local changes are in the way too', async () => {
    const d = repo();
    mine(d, ...both);
    writeFileSync(join(d, 's.txt'), 'dirty\n');
    for (const o of [
      { kind: 'switch', branch: 'side', migrate: false },
      { kind: 'merge', ref: 'side', mode: 'ff', autostash: false },
      { kind: 'cherryPick', commit: side(d) },
    ] satisfies Operation[]) {
      const e = await refused(d, o);
      assert.equal(e.kind, 'localChanges');
    }
  });
});
