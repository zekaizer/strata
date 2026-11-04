import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { graphCommitCount } from '../fixtures/graph-files.ts';
import { delay, git, strata, waitFor, workspaceRoot } from './helpers.ts';

describe('keeping the commit-graph updated', () => {
  let panel: GraphPanel;
  const branch = 'strata-graph-update-test';
  const config = () => vscode.workspace.getConfiguration('strata');

  /** Commits a new empty commit on the test branch and reloads the history. */
  async function newCommit(message: string): Promise<void> {
    let parent: string;
    try {
      parent = git('rev-parse', '--verify', '--quiet', branch);
    } catch {
      parent = git('rev-parse', 'HEAD');
    }
    git('update-ref', `refs/heads/${branch}`, git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message));
    const before = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await waitFor('reloaded', async () => (await panel.probe()).generation > before);
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await vscode.commands.executeCommand('strata.writeCommitGraph');
  });
  after(async () => {
    await config().update('keepCommitGraphUpdated', undefined, vscode.ConfigurationTarget.Global);
    try {
      git('update-ref', '-d', `refs/heads/${branch}`);
    } catch {
      // Not created.
    }
    panel.dispose();
  });

  it('leaves the commit-graph alone by default', async () => {
    const count = graphCommitCount(workspaceRoot());
    assert.ok(count > 0);
    await newCommit('not added');
    await delay(4500);
    assert.equal(graphCommitCount(workspaceRoot()), count);
  });

  it('adds new commits to the commit-graph when enabled', async () => {
    await config().update('keepCommitGraphUpdated', true, vscode.ConfigurationTarget.Global);
    const count = graphCommitCount(workspaceRoot());
    await newCommit('added');
    // Both commits of the test branch are new to the graph.
    await waitFor('graph updated', () => graphCommitCount(workspaceRoot()) === count + 2, 15_000);
    git('commit-graph', 'verify');
  });
});
