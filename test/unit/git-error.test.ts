import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyGitError, parseProgress } from '../../src/core/git-error.ts';

describe('classifyGitError', () => {
  const cases: [string, ReturnType<typeof classifyGitError>][] = [
    ["fatal: could not read Username for 'https://example.com': terminal prompts disabled", 'auth'],
    ["remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/x.git/'", 'auth'],
    ['git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'hostKey'],
    [
      "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
      'lock',
    ],
    [" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'origin'", 'rejected'],
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    [
      " ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to 'origin'",
      'remoteRejected',
    ],
    ['fatal: refusing to merge unrelated histories', 'unrelated'],
    [
      'CONFLICT (content): Merge conflict in f.txt\nAutomatic merge failed; fix conflicts and then commit the result.',
      'conflict',
    ],
    ['error: could not apply 1a2b3c4... topic 1\nhint: Resolve all conflicts manually', 'conflict'],
    [
      'error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt\nPlease commit your changes or stash them before you switch branches.',
      'localChanges',
    ],
    ['error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.', 'localChanges'],
    [
      'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.',
      'untrackedOverwrite',
    ],
    ["fatal: 'topic' is already checked out at '/r/wt'", 'checkedOutElsewhere'],
    ["error: cannot delete branch 'topic' used by worktree at '/r/wt'", 'checkedOutElsewhere'],
    [
      "error: The branch 'topic' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D topic'.",
      'notMerged',
    ],
    [
      'fatal: The current branch topic has no upstream branch.\nTo push the current branch and set the remote as upstream, use',
      'noUpstream',
    ],
    [
      'There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.',
      'noUpstream',
    ],
    ['fatal: something else', 'other'],
  ];
  for (const [stderr, kind] of cases) {
    it(`${kind}: ${stderr.split('\n')[0]!.slice(0, 50)}`, () => {
      assert.equal(classifyGitError(stderr), kind);
    });
  }
});

describe('parseProgress', () => {
  it('reads the last phase and percentage of a chunk', () => {
    assert.deepEqual(parseProgress('Counting objects: 100% (5/5), done.\rReceiving objects:  45% (450/1000)\r'), {
      phase: 'Receiving objects',
      percent: 45,
    });
    assert.deepEqual(parseProgress('remote: Compressing objects:  12% (1/8)\r'), {
      phase: 'Compressing objects',
      percent: 12,
    });
  });

  it('ignores lines without a percentage', () => {
    assert.equal(parseProgress('From https://example.com/r\n * branch main -> FETCH_HEAD\n'), undefined);
  });
});
