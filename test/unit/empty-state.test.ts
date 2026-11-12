import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyState, type EmptyView } from '../../src/core/empty-state.ts';

const view = (over: Partial<EmptyView> = {}): EmptyView => ({
  rows: 0,
  noRepository: false,
  done: true,
  path: undefined,
  refs: false,
  ...over,
});

describe('emptyState', () => {
  it('says nothing while there are rows', () => {
    assert.equal(emptyState(view({ rows: 3 })), undefined);
    assert.equal(emptyState(view({ rows: 1, path: 'src/a.ts', refs: true })), undefined);
  });
  it('says nothing while the history is still read', () => {
    assert.equal(emptyState(view({ done: false })), undefined);
    assert.equal(emptyState(view({ done: false, path: 'src/a.ts', refs: true })), undefined);
  });
  it('offers to open a folder when the workspace has no repository', () => {
    assert.deepEqual(emptyState(view({ noRepository: true, done: false })), {
      kind: 'noRepository',
      text: 'No git repository in this workspace. Open a folder that contains one.',
      action: 'Open Folder...',
    });
  });
  it('offers to show all files when no commit changes the filtered path', () => {
    assert.deepEqual(emptyState(view({ path: 'src/a.ts' })), {
      kind: 'pathFilter',
      text: 'No commit changes src/a.ts.',
      action: 'Show All Files',
    });
  });
  it('offers to show all refs when the selected refs have no commits', () => {
    assert.deepEqual(emptyState(view({ refs: true })), {
      kind: 'refFilter',
      text: 'No commits on the selected refs.',
      action: 'Show All',
    });
  });
  it('clears the path filter when both filters are set: the text names the path', () => {
    assert.equal(emptyState(view({ path: 'docs/', refs: true }))?.kind, 'pathFilter');
  });
  it('has no action for a repository without commits', () => {
    assert.deepEqual(emptyState(view()), { kind: 'noCommits', text: 'No commits yet.', action: undefined });
  });
});
