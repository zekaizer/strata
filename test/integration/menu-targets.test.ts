import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { MENU_SECTIONS } from '../../src/shared/commands.ts';
import { git, strata, waitFor } from './helpers.ts';
import { gitRetry, snapshotRepo } from './repo-snapshot.ts';

describe('context menu targets', () => {
  let panel: GraphPanel;
  let restore: () => Promise<void>;
  const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
  // A workbench menu closes when focus leaves it.
  const closeMenu = async () => {
    await vscode.commands.executeCommand('workbench.action.quickOpen');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await waitFor('menu closed', async () => !(await panel.probe()).menuShown);
  };

  before(async () => {
    restore = await snapshotRepo();
    await gitRetry('remote', 'add', 'origin', 'https://example.com/origin.git');
    await gitRetry('update-ref', 'refs/remotes/origin/main', 'main');
    await gitRetry('branch', '--quiet', '--set-upstream-to=origin/main', 'main');
    await gitRetry('tag', 'strata-menu-tag', 'feature/login');
    panel = (await strata()).show();
    await panel.whenReady();
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await waitFor('history with the remote', async () => {
      const s = await panel.probe();
      return s.done && s.menuContexts.badges[0]?.length === 2;
    });
  });
  after(async () => {
    await restore();
    panel.dispose();
  });

  it('gives each badge, and each remote name in a merged badge, a menu context of its own', async () => {
    const s = await panel.probe();
    const main = git('rev-parse', 'main');
    assert.deepEqual(s.menuContexts.badges[0], [
      {
        webviewSection: 'branch',
        strataHash: main,
        strataRef: 'refs/heads/main',
        strataIsCurrent: true,
        strataUpstream: true,
      },
      { webviewSection: 'remoteBranch', strataHash: main, strataRef: 'refs/remotes/origin/main' },
    ]);
    const login = git('rev-parse', 'feature/login');
    assert.deepEqual(s.menuContexts.badges[order().indexOf(login)], [
      {
        webviewSection: 'branch',
        strataHash: login,
        strataRef: 'refs/heads/feature/login',
        strataIsCurrent: false,
        strataUpstream: false,
      },
      { webviewSection: 'tag', strataHash: login, strataRef: 'refs/tags/strata-menu-tag' },
    ]);
  });

  it('describes a commit row by whether it is HEAD and which refs it carries', async () => {
    const row = async (index: number) => {
      await panel.simulate({ kind: 'clickRow', index });
      return waitFor('row selected', async () => {
        const s = await panel.probe();
        return s.selected === order()[index] && s.menuContexts.selectedRow;
      });
    };
    const head = await row(0);
    assert.equal(head['strataIsHead'], true);
    assert.equal(head['strataHasRefs'], true);
    assert.equal(head['strataRefs'], 'refs/heads/main refs/remotes/origin/main');
    assert.equal(head['strataBranch'], '', 'the current branch is no other branch to check out');
    const login = await row(order().indexOf(git('rev-parse', 'feature/login')));
    assert.equal(login['strataBranch'], 'refs/heads/feature/login');
    const merge = await row(order().indexOf(git('rev-parse', 'main~1^{/Merge cross}')));
    assert.equal(merge['strataIsHead'], false);
    assert.equal(merge['strataHasRefs'], false);
    assert.equal(merge['strataRefs'], '');
  });

  it('names the one local branch besides the current one that a row could act on, and none of several', async () => {
    await gitRetry('branch', 'strata-sibling', 'main');
    await gitRetry('branch', 'strata-other', 'feature/login');
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    const contextOf = async (rev: string) => {
      const index = order().indexOf(git('rev-parse', rev));
      await panel.simulate({ kind: 'clickRow', index });
      return waitFor('row selected', async () => {
        const s = await panel.probe();
        const ctx = s.menuContexts.selectedRow;
        return s.selected === order()[index] && String(ctx?.['strataRefs']).includes('strata-') && ctx;
      });
    };
    assert.equal((await contextOf('main'))['strataBranch'], 'refs/heads/strata-sibling');
    assert.equal((await contextOf('feature/login'))['strataBranch'], '');
  });

  it('outlines what a right-clicked remote name opens a menu for, until the menu closes', async () => {
    await panel.simulate({ kind: 'contextMenu', selector: '.badge-remote-name' });
    const target = await waitFor('menu open', async () => {
      const s = await panel.probe();
      return s.menuShown && s.menuTarget;
    });
    // The nearest of the remote name, its branch's badge and its row that has menu items.
    const sections = ['remoteBranch', 'branch', 'commit'].filter((s) => MENU_SECTIONS.has(s));
    assert.equal(target.context['webviewSection'], sections[0]);
    assert.equal(target.context['strataHash'], git('rev-parse', 'main'));
    assert.equal(target.outline, 'solid');
    await closeMenu();
    assert.equal((await panel.probe()).menuTarget, undefined, 'no outline left to light up at the next menu');
  });

  it("opens the selected row's menu for Shift+F10 on the list", async () => {
    await panel.simulate({ kind: 'clickRow', index: 3 });
    await waitFor('row selected', async () => (await panel.probe()).selected === order()[3]);
    await panel.simulate({ kind: 'keyboardContextMenu' });
    const target = await waitFor('menu open', async () => {
      const s = await panel.probe();
      return s.menuShown && s.menuTarget;
    });
    assert.equal(target.context['webviewSection'], 'commit');
    assert.equal(target.context['strataHash'], order()[3]);
    await closeMenu();
  });
});
