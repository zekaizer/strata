import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { WebviewToHost } from '../../src/shared/protocol.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry, setIdentity, snapshotRepo } from './repo-snapshot.ts';

describe('operation banner', () => {
  let panel: GraphPanel;
  let restore: () => Promise<void>;
  const sent: WebviewToHost[] = [];
  const write = (content: string) => {
    writeFileSync(join(workspaceRoot(), 'conflict.txt'), content);
  };
  const banner = (state: string) =>
    waitFor(`banner ${state}`, async () => {
      const s = await panel.probe();
      return s.banner?.state === state && s;
    });

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    panel = (await strata()).show();
    await panel.whenReady();
    panel.onDidReceiveMessage((m) => sent.push(m));
    await waitFor('history', async () => (await panel.probe()).done);
    // strata-topic's first commit conflicts with strata-onto.
    await gitRetry('switch', '--quiet', '--create', 'strata-onto', 'main');
    write('onto\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Onto');
    await gitRetry('switch', '--quiet', '--create', 'strata-topic', 'main');
    write('topic\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic one');
    writeFileSync(join(workspaceRoot(), 'other.txt'), 'other\n');
    await gitRetry('add', 'other.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic two');
    await assert.rejects(gitRetry('rebase', 'strata-onto'));
  });
  after(async () => {
    await restore();
    panel.dispose();
  });

  it('names a rebase stopped at a conflict, says it politely, and offers what to do next', async () => {
    const short = git('rev-parse', '--short=7', 'strata-topic~1');
    const text =
      `Rebasing 'strata-topic' onto 'strata-onto' stopped at 1 of 2, "Topic one" (${short}): 1 conflicted file. ` +
      "'strata-topic' keeps its old commits until the rebase finishes.";
    await banner('rebase');
    // The subject shows once the history that has the commit is loaded.
    const s = await waitFor('banner with the subject', async () => {
      const p = await panel.probe();
      return p.banner?.text === text && p;
    });
    assert.equal(s.banner?.label, 'Rebase in progress');
    assert.equal(s.banner.warning, true);
    assert.deepEqual(s.banner.buttons, ['Resolve...', 'Continue', 'Abort...']);
    assert.match(s.announced, /^Rebasing 'strata-topic' onto 'strata-onto' stopped at 1 of 2/);
    assert.equal(s.alerted, '', 'VS Code already says the toast the host shows for a stop');
  });

  it('runs the command of a button, and selects the commit a link names', async () => {
    await panel.simulate({ kind: 'click', selector: '.banner-button.primary' });
    await waitFor('Resolve... sent', () =>
      sent.some((m) => m.type === 'menuCommand' && m.command === 'strata.resolveConflicts'),
    );
    await panel.simulate({ kind: 'click', selector: '.banner-link' });
    await waitFor('commit selected', async () => (await panel.probe()).selected === git('rev-parse', 'strata-topic~1'));
  });

  it('says what Continue does once the conflict is resolved, and keeps focus on the button that had it', async () => {
    await panel.simulate({ kind: 'focus', selector: '.banner-button:last-child' });
    write('resolved\n');
    await gitRetry('add', 'conflict.txt');
    const s = await banner('rebaseResolved');
    assert.equal(
      s.banner?.text,
      'Conflicts resolved. Continue finishes "Topic one" and replays the remaining 1 commit.',
    );
    assert.deepEqual(s.banner.buttons, ['Continue', 'Abort...']);
    assert.equal(s.focused, 'banner-button', 'Abort..., not the primary Continue');
  });

  it('goes away when the rebase is aborted, handing focus to the list', async () => {
    await panel.simulate({ kind: 'focus', selector: '.banner-button.primary' });
    await gitRetry('rebase', '--abort');
    const s = await waitFor('no banner', async () => {
      const p = await panel.probe();
      return p.banner === undefined && p;
    });
    assert.equal(s.focused, 'scroller');
  });
});
