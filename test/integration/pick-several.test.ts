import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowSuite, menu, reload, run } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

const write = (file: string, content: string) => {
  writeFileSync(join(workspaceRoot(), file), content);
};
const read = (file: string) => readFileSync(join(workspaceRoot(), file), 'utf8');
/** A commit on HEAD writing `file`; resolves its id. */
const commitFile = (file: string, content: string) => {
  write(file, content);
  git('add', file);
  git('commit', '--quiet', '-m', `${file}: ${content.trim()}`);
  return git('rev-parse', 'HEAD');
};
const selection = (newestFirst: string[]) =>
  menu({ webviewSection: 'selection', strataHash: newestFirst[0], strataSelection: newestFirst.join(' ') });
const subjects = (range: string) => git('log', '--format=%s', range).split('\n');

describe('cherry pick and revert of several commits', () => {
  const { api, panel, ui } = flowSuite();
  const lastNotice = () => ui.of('notify').at(-1);

  /**
   * strata-picks from main~1 with one commit per [file, content], oldest first; HEAD stays on
   * main. Resolves the commits newest first, as a selection lists them.
   */
  const picks = async (...files: [string, string][]) => {
    git('switch', '--quiet', '--create', 'strata-picks', 'main~1');
    const ids = files.map(([file, content]) => commitFile(file, content));
    git('switch', '--quiet', 'main');
    await reload(panel());
    return ids.reverse();
  };
  const apart: [string, string][] = [
    ['first.txt', 'first\n'],
    ['second.txt', 'second\n'],
    ['third.txt', 'third\n'],
  ];
  /** The second of three conflicts with main's main.txt. */
  const clashing: [string, string][] = [apart[0]!, ['main.txt', 'picked\n'], apart[2]!];
  const resolve = (content = 'resolved\n') => {
    write('main.txt', content);
    git('add', 'main.txt');
  };

  it('cherry picks them oldest first in one run, names how many, and undoes them in one step', async () => {
    const start = git('rev-parse', 'HEAD');
    await run('strata.cherryPick', selection(await picks(...apart)));
    assert.deepEqual(subjects(`${start}..HEAD`), ['third.txt: third', 'second.txt: second', 'first.txt: first']);
    assert.deepEqual(ui.of('confirm'), [], 'a clean work tree on a branch asks nothing');
    assert.equal(lastNotice()?.message, "Cherry-picked 3 commits onto 'main'");
    assert.deepEqual(lastNotice()?.actions, ['Undo']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), start);
  });

  it('reverts them newest first, one new commit each, and undoes them in one step', async () => {
    const base = git('rev-parse', 'HEAD');
    const a = commitFile('a.txt', 'a\n');
    const b = commitFile('b.txt', 'b\n');
    await reload(panel());
    await run('strata.revert', selection([b, a]));
    assert.deepEqual(subjects(`${b}..HEAD`), ['Revert "a.txt: a"', 'Revert "b.txt: b"']);
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${base}^{tree}`));
    assert.equal(lastNotice()?.message, 'Reverted 2 commits');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), b);
  });

  it('refuses a set with a merge commit in it, saying which and why', async () => {
    const start = git('rev-parse', 'HEAD');
    git('switch', '--quiet', '--create', 'strata-side', 'main~1');
    commitFile('side.txt', 'side\n');
    git('switch', '--quiet', '--create', 'strata-picks', 'main~1');
    const own = commitFile('own.txt', 'own\n');
    git('merge', '--quiet', '--no-ff', '--no-edit', 'strata-side');
    const merge = git('rev-parse', 'HEAD');
    git('switch', '--quiet', 'main');
    await reload(panel());
    for (const command of ['strata.revert', 'strata.cherryPick']) {
      ui.clear();
      await run(command, selection([merge, own]));
      assert.match(
        lastNotice()?.message ?? '',
        new RegExp(
          `^Can't (cherry pick|revert) these commits together: ${git('rev-parse', '--short', merge)} "Merge branch 'strata-side' into strata-picks" is a merge commit`,
        ),
      );
      assert.deepEqual(ui.of('confirm'), []);
    }
    assert.equal(git('rev-parse', 'HEAD'), start);
    assert.equal(api().contextValue('strata.operation'), '');
  });

  it('leaves out the commits the branch already has, and says so', async () => {
    const start = git('rev-parse', 'HEAD');
    const [, second, first] = await picks(...apart);
    await run('strata.cherryPick', selection([start, git('rev-parse', 'HEAD~1')]));
    assert.equal(lastNotice()?.message, "'main' already contains all 2 commits.");
    assert.equal(git('rev-parse', 'HEAD'), start);
    await run('strata.cherryPick', selection([second!, first!, start]));
    assert.deepEqual(subjects(`${start}..HEAD`), ['second.txt: second', 'first.txt: first']);
    assert.equal(lastNotice()?.message, "Cherry-picked 2 commits onto 'main' (1 more was already there)");
  });

  it('asks once about uncommitted changes to a file any of them changes, and gives them back', async () => {
    const set = await picks(...apart);
    const start = git('rev-parse', 'HEAD');
    write('NOTES.md', 'mine\n');
    git('add', 'NOTES.md');
    ui.press(undefined);
    await run('strata.cherryPick', selection(set));
    const asked = ui.first('confirm');
    assert.equal(ui.of('confirm').length, 1);
    assert.equal(asked.message, "Cherry pick 3 commits onto 'main'?");
    assert.match(asked.detail, /^Applies them oldest first: "first\.txt: first", "second\.txt: second" and 1 more\.\n/);
    assert.deepEqual(asked.buttons, ['Stash & Cherry Pick']);
    assert.equal(git('rev-parse', 'HEAD'), start, 'Cancel changes nothing');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', selection(set));
    assert.equal(subjects(`${start}..HEAD`).length, 3);
    assert.equal(git('diff', '--cached', '--name-only'), 'NOTES.md', 'the staged change is back, staged');
    assert.equal(read('NOTES.md'), 'mine\n');
  });

  it('stops at a conflict in the middle; Continue picks the rest, and Undo goes back before the first', async () => {
    const start = git('rev-parse', 'HEAD');
    await run('strata.cherryPick', selection(await picks(...clashing)));
    assert.equal(api().contextValue('strata.operation'), 'cherryPick');
    assert.deepEqual(subjects(`${start}..HEAD`), ['first.txt: first']);
    assert.match(lastNotice()?.message ?? '', /^Cherry pick stopped \("main\.txt: picked"\) with conflicts in 1 file/);
    resolve();
    await run('strata.operation.continue');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.deepEqual(subjects(`${start}..HEAD`), ['third.txt: third', 'main.txt: picked', 'first.txt: first']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), start);
  });

  it('skips the commit it stopped at and picks the rest; Undo goes back before the first', async () => {
    const start = git('rev-parse', 'HEAD');
    await run('strata.cherryPick', selection(await picks(...clashing)));
    ui.press('Skip Commit');
    await run('strata.operation.skip');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.deepEqual(subjects(`${start}..HEAD`), ['third.txt: third', 'first.txt: first']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), start);
  });

  it('aborts back to before the first commit', async () => {
    const start = git('rev-parse', 'HEAD');
    await run('strata.cherryPick', selection(await picks(...clashing)));
    ui.press('Abort Cherry Pick');
    await run('strata.operation.abort');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('rev-parse', 'HEAD'), start);
    assert.equal(git('status', '--porcelain'), '');
  });

  it('stops a revert at a conflict in the middle; Continue, Skip and Abort each end it', async () => {
    const a = commitFile('a.txt', 'a\n');
    const b = commitFile('b.txt', 'b\n');
    const c = commitFile('c.txt', 'c\n');
    // Reverting b (which deletes b.txt) conflicts with this change to it.
    const top = commitFile('b.txt', 'b again\n');
    await reload(panel());
    const stop = async () => {
      await run('strata.revert', selection([c, b, a]));
      assert.equal(api().contextValue('strata.operation'), 'revert');
      assert.deepEqual(subjects(`${top}..HEAD`), ['Revert "c.txt: c"']);
    };

    await stop();
    git('rm', '--quiet', 'b.txt');
    await run('strata.operation.continue');
    assert.deepEqual(subjects(`${top}..HEAD`), ['Revert "a.txt: a"', 'Revert "b.txt: b"', 'Revert "c.txt: c"']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), top);

    await stop();
    ui.press('Skip Commit');
    await run('strata.operation.skip');
    assert.deepEqual(subjects(`${top}..HEAD`), ['Revert "a.txt: a"', 'Revert "c.txt: c"']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), top);

    await stop();
    ui.press('Abort Revert');
    await run('strata.operation.abort');
    assert.equal(git('rev-parse', 'HEAD'), top);
    assert.equal(api().contextValue('strata.operation'), '');
  });

  it('stops a revert at a commit that is already reverted, and Continue reverts the rest', async () => {
    const a = commitFile('a.txt', 'a\n');
    const b = commitFile('b.txt', 'b\n');
    const c = commitFile('c.txt', 'c\n');
    git('revert', '--no-edit', b);
    const top = git('rev-parse', 'HEAD');
    await reload(panel());
    await run('strata.revert', selection([c, b, a]));
    assert.equal(api().contextValue('strata.operation'), 'revert');
    assert.equal(
      lastNotice()?.message,
      'Revert stopped: one of the commits is already reverted, so there is nothing to undo for it.',
    );
    assert.deepEqual(lastNotice()?.actions, ['Continue', 'Abort Revert...']);
    await run('strata.operation.continue');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.deepEqual(subjects(`${top}..HEAD`), ['Revert "a.txt: a"', 'Revert "c.txt: c"']);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), top);
  });

  it('holds the stashed changes through every stop of the run, and gives them back when it ends', async () => {
    const set = await picks(apart[0]!, ['main.txt', 'picked\n'], ['main.txt', 'picked again\n']);
    write('NOTES.md', 'mine\n');
    git('add', 'NOTES.md');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', selection(set));
    assert.equal(api().contextValue('strata.operation'), 'cherryPick');
    const held = () =>
      waitFor('the banner names the held stash', async () =>
        (await panel().probe()).banner?.text.includes(
          'Your uncommitted changes are in stash "Strata: changes set aside for the cherry pick of 3 commits onto \'main\'"',
        ),
      );
    await held();
    resolve();
    await run('strata.operation.continue');
    assert.equal(api().contextValue('strata.operation'), 'cherryPick', 'stopped again at the third');
    await held();
    assert.match(lastNotice()?.message ?? '', /Your uncommitted changes are in stash "Strata: changes set aside/);
    resolve('resolved again\n');
    await run('strata.operation.continue');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('stash', 'list'), '');
    assert.equal(read('NOTES.md'), 'mine\n', 'the stashed change is back');
  });
});
