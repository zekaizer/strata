import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';

describe('commit order', () => {
  let panel: GraphPanel;
  const config = () => vscode.workspace.getConfiguration('strata');
  const subjects = (flag: string) => git('log', flag, '--format=%s', '--branches', '--remotes', 'HEAD').split('\n');

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
  });
  after(async () => {
    await config().update('commitOrder', undefined, vscode.ConfigurationTarget.Global);
    panel.dispose();
  });

  it('lists the rows by commit date once the setting asks for it, without a refresh', async () => {
    const topo = subjects('--topo-order');
    const date = subjects('--date-order');
    const row = topo.findIndex((subject, i) => subject !== date[i]);
    assert.notEqual(row, -1, 'the fixture has the same rows in both orders');
    // The two that swap places where the orders first differ.
    const [first, second] = [date[row]!, topo[row]!];
    const inOrder = async (above: string, below: string) => {
      const shown = (await panel.probe()).visibleSubjects;
      return shown.includes(above) && shown.includes(below) && shown.indexOf(above) < shown.indexOf(below);
    };

    await waitFor('topological order', () => inOrder(second, first));
    await config().update('commitOrder', 'date', vscode.ConfigurationTarget.Global);
    await waitFor('date order', () => inOrder(first, second));
  });
});
