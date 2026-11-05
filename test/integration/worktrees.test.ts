import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeInfo } from '../../src/core/worktrees.ts';
import { flowSuite } from './flow-helpers.ts';
import { git, waitFor } from './helpers.ts';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

/** git in another worktree of the workspace repository. */
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();

describe('other worktrees', () => {
  const { panel } = flowSuite();
  let root: string;
  let made: string[] = [];

  /** A linked worktree, added from outside VS Code and removed after the test. */
  const add = (name: string, ...args: string[]) => {
    const path = join(root, name);
    git('worktree', 'add', '--quiet', path, ...args);
    made.push(path);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'strata-wt-'));
  });
  afterEach(() => {
    for (const path of made) git('worktree', 'remove', '--force', '--force', path);
    made = [];
    git('worktree', 'prune');
    rmSync(root, { recursive: true, force: true });
  });

  /** Waits until the graph's refs list a worktree at `path` that `check` accepts (none: until it is gone). */
  const listed = (what: string, path: string, check?: (w: WorktreeInfo) => boolean) =>
    waitFor(what, () => {
      const w = panel()
        .flowHost()
        .refs.worktrees.find((x) => x.path === path);
      return check ? w !== undefined && check(w) && w : w === undefined;
    });

  it('follows other worktrees as they are added, switched, locked and removed', async () => {
    const other = add('review', 'wip/experiment');
    await listed('the added worktree', other, (w) => w.branch === 'refs/heads/wip/experiment');
    gitIn(other, 'switch', '--quiet', '--detach', 'main');
    await listed('its switch to a detached HEAD', other, (w) => w.branch === undefined);
    git('worktree', 'lock', '--reason', 'on usb disk', other);
    await listed('its lock', other, (w) => w.state.kind === 'locked' && w.state.reason === 'on usb disk');
    git('worktree', 'unlock', other);
    await listed('its unlock', other, (w) => w.state.kind === 'active');
    git('worktree', 'remove', other);
    made = [];
    await listed('its removal', other);
  });

  it('shows the commits made on a detached HEAD in another worktree', async () => {
    const other = add('bisect', '--detach', 'cross/x');
    await listed('the added worktree', other, (w) => w.branch === undefined);
    gitIn(other, 'commit', '--quiet', '--allow-empty', '-m', 'Probe in the bisect worktree');
    const hash = gitIn(other, 'rev-parse', 'HEAD');
    await waitFor('the commit in the graph', async () => {
      const p = await panel().probe();
      return p.done && Object.values(p.rowHashes).includes(hash);
    });
    assert.equal(git('branch', '--contains', hash), '', 'no branch reaches it');
  });
});
