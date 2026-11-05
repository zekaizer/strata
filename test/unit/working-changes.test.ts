import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeCounts, changesSummary, describeChanges, listChanges, parseStatus } from '../../src/core/repo-state.ts';

/** `git status --porcelain=v2 -z` records, each NUL-terminated. */
const status = (...records: string[]) => records.map((r) => `${r}\0`).join('');
const Z = '0000000000000000000000000000000000000000';
const H = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const ordinary = (xy: string, path: string, sub = 'N...') => `1 ${xy} ${sub} 100644 100644 100644 ${H} ${H} ${path}`;
const renamed = (xy: string, path: string, from: string) => [
  `2 ${xy} N... 100644 100644 100644 ${H} ${H} R100 ${path}`,
  from,
];
const unmerged = (xy: string, path: string) => `u ${xy} N... 100644 100644 100644 100644 ${H} ${H} ${H} ${path}`;

describe('working changes', () => {
  const out = status(
    ordinary('M.', 'src/staged.ts'),
    ordinary('MM', 'src/both.ts'),
    ordinary('.D', 'gone.md'),
    ordinary('A.', 'new file.ts'),
    ...renamed('R.', 'docs/new.md', 'docs/old.md'),
    unmerged('UU', 'conflict.txt'),
    '? notes/todo.txt',
    '? scratch/',
  );

  it('counts staged, changed, conflicted and untracked paths apart', () => {
    const w = parseStatus(out, true);
    assert.deepEqual(
      { staged: w.staged, unstaged: w.unstaged, conflicted: w.conflicted, untracked: w.untracked },
      { staged: 4, unstaged: 2, conflicted: 1, untracked: 2 },
    );
    assert.deepEqual(w.paths, [
      'src/staged.ts',
      'src/both.ts',
      'gone.md',
      'new file.ts',
      'docs/new.md',
      'conflict.txt',
    ]);
  });

  it('leaves untracked unknown when git did not look for them', () => {
    assert.equal(parseStatus(status(ordinary('M.', 'a')), false).untracked, undefined);
    assert.equal(parseStatus('', true).untracked, 0);
  });

  it('counts a submodule with changes inside it', () => {
    const w = parseStatus(status(ordinary('.M', 'lib', 'S.M.'), ordinary('.M', 'ext', 'SC..')), true);
    assert.equal(w.submodules, 1);
    assert.equal(w.unstaged, 2);
  });

  it('lists each path in its groups, a rename with its source', () => {
    assert.deepEqual(listChanges(out, 100), {
      files: [
        { group: 'staged', status: 'M', path: 'src/staged.ts' },
        { group: 'staged', status: 'M', path: 'src/both.ts' },
        { group: 'unstaged', status: 'M', path: 'src/both.ts' },
        { group: 'unstaged', status: 'D', path: 'gone.md' },
        { group: 'staged', status: 'A', path: 'new file.ts' },
        { group: 'staged', status: 'R', path: 'docs/new.md', oldPath: 'docs/old.md' },
        { group: 'conflicted', status: 'M', path: 'conflict.txt' },
        { group: 'untracked', status: 'A', path: 'notes/todo.txt' },
        { group: 'untracked', status: 'A', path: 'scratch/' },
      ],
      truncated: 0,
    });
  });

  it('keeps at most `limit` paths per group and counts the rest', () => {
    const many = status(...['a', 'b', 'c'].map((p) => `? ${p}`), ordinary('M.', 'x'));
    const { files, truncated } = listChanges(many, 2);
    assert.deepEqual(
      files.map((f) => f.path),
      ['a', 'b', 'x'],
    );
    assert.equal(truncated, 1);
  });

  it('reads an intent-to-add file as added in the work tree', () => {
    assert.deepEqual(listChanges(status(`1 .A N... 000000 000000 100644 ${Z} ${Z} ita.txt`), 10).files, [
      { group: 'unstaged', status: 'A', path: 'ita.txt' },
    ]);
  });

  it('has nothing to show for a clean work tree, or one with only untracked files left uncounted', () => {
    assert.equal(changesSummary(parseStatus('', true)), undefined);
    assert.equal(changesSummary(parseStatus(status('? a'), false)), undefined);
    assert.deepEqual(changesSummary(parseStatus(status('? a'), true)), {
      staged: 0,
      unstaged: 0,
      conflicted: 0,
      untracked: 1,
      submodules: 0,
    });
  });

  it('says conflicts first and leaves out what is zero', () => {
    const s = { staged: 2, unstaged: 0, conflicted: 1, untracked: 3, submodules: 0 };
    assert.deepEqual(
      changeCounts(s).map((c) => c.text),
      ['1 conflict', '2 staged', '3 untracked'],
    );
    assert.equal(describeChanges(s, 'main'), 'Uncommitted changes on main: 1 conflict, 2 staged, 3 untracked.');
    assert.equal(
      describeChanges(s, 'main', 'src/'),
      'Uncommitted changes to src/ on main: 1 conflict, 2 staged, 3 untracked.',
    );
  });

  it('says when untracked files were not counted and that stashes skip submodules', () => {
    const s = { staged: 0, unstaged: 1, conflicted: 0, untracked: undefined, submodules: 1 };
    assert.equal(
      describeChanges(s, undefined),
      'Uncommitted changes: 1 changed. Untracked files are not counted. git stash never records changes inside submodules.',
    );
  });
});
