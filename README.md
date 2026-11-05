# Strata

A fast commit graph for git repositories in VS Code. It reads history page by
page, so it opens quickly even on very large repositories.

## Features

- Commit graph of all local branches, remote-tracking branches, tags and HEAD,
  with branch, remote and tag badges above their commits. A branch and
  its same-named remote-tracking branches on the same commit share one badge
  (`main │ origin`); when they differ, both show, so unpushed work stands out.
  The current branch and its upstream come first; badges that do not fit the
  row collapse into a `+N` badge.
- Stashes are rows of their own, directly above the commit each was made on,
  newest on top, with a square node beside that commit's line. A stash whose
  commit is no longer on its branch (after a rebase or amend) sits above the
  branch's tip and says so; an autostash git left behind shows in the warning
  color. Stashing or dropping updates the rows without reloading the history.
- Commit details: author, committer, full message, parents and changed files.
- Click a changed file to open its diff in the VS Code diff editor; browse
  file after file without losing your place in the graph.
- Filter the graph to selected branches, remotes or tags, and switch to
  first-parent history. By default the graph shows all local and
  remote-tracking branches; tags label their commits, and a tag that is on no
  branch shows when you select it in the filter.
- The graph comes back after restarting VS Code, pinned if you pinned it, at
  the commit you had selected and with the same filters.
- Works in narrow editors: columns collapse as space shrinks, and commit
  details unfold right under the commit instead of taking a side or bottom
  pane.
- Works in local folders, WSL, SSH and other remote workspaces: Strata runs
  where the repository is.
- Follows your color theme, including high contrast themes; graph colors adapt
  to the theme's background so lines stay readable.

## Usage

- Run **Strata: Show Commit Graph** from the Command Palette, or click the
  commit-graph button in the Source Control view title bar.
- Scroll to load more history.
- Click a commit to unfold its details under it; click it again, or press
  <kbd>Esc</kbd> in the list, to fold them. <kbd>Esc</kbd> inside the details
  takes you back to the list. With the list focused, ↑/↓ move the
  selection (open details follow it) and <kbd>Enter</kbd> unfolds or folds.
- Changed files are listed as a folder tree; click a folder (or use ←/→) to
  fold it.
- Click a file in the details to open its diff against the parent commit.
  Hover a file (or focus it) for **Old**, the compare icon and **New**: the
  file as it was before the commit, the diff, and the file as of the
  commit. Added files only have **New** and deleted files only **Old**.
  <kbd>Alt</kbd> opens to the side. With a file focused, ↑/↓ move between
  files, <kbd>Enter</kbd> opens it, and <kbd>O</kbd>, <kbd>D</kbd>,
  <kbd>N</kbd> open the old version, the diff and the new version.
- Right-click a file for open and copy actions: **Copy Relative Path**
  (relative to the repository root), **Copy Path**, and for renamed files
  **Copy Old Relative Path**. <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>
  (<kbd>⌥⇧⌘C</kbd> on macOS) copies the relative path of the focused file.
  Right-click a commit to copy its hash, short hash, subject or patch.
- With the list focused, <kbd>Shift</kbd>+<kbd>F10</kbd> or the Menu key opens
  the selected commit's or stash's menu, <kbd>Ctrl</kbd>+<kbd>C</kbd> copies
  its full hash and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> its patch
  (<kbd>Cmd</kbd> on macOS); a stash's patch includes its untracked files.
  With text selected in the details, <kbd>Ctrl</kbd>+<kbd>C</kbd> copies that
  text.
- The details start with who and when: author, date and the short hash. Click
  the hash to copy the full hash; the arrow after it shows the full hash,
  author, committer and parents (with their subjects) and stays open for other
  commits until you close it.
- Below come the full subject and the message body, in the editor font.
  Wrapped paragraphs flow to the width of the view; code, lists and trailers
  keep their lines. Long bodies show their first lines and **Show more**.
- The changed files follow the message, with the commit they are compared
  with (click it to select that commit). In wide editors the message and the
  files sit side by side, and a tree that fits flows into columns.
- Use the branch button in the toolbar to show only some refs (type to search,
  **Show all** to reset), and **First parent** to follow only the main line of
  merges.
- With stashes in the repository, the toolbar counts them and how many are not
  in the graph (their commit is not loaded yet, filtered out, or on no branch).
  Click it for **Show Stashes**: pick one to select it and open its details,
  loading more history if needed. Click a stash row to see its message, the
  commit it was made on, how many files were staged, its changes (click a file
  for its diff) and its untracked files. **Show stash rows** in the branch
  button's menu hides or shows the rows.
- Use the refresh button after changing the repository outside VS Code.

## Changing the repository

Right-click a commit, a branch, remote branch or tag badge, or a stash row for
what you can do with it; **Branch and Tag Actions...** in a commit's menu
offers the same for its badges from the keyboard. On the row of a commit one
local branch points at (besides the current one), Checkout, Merge and Rebase
act on that branch, so a merge commit names it, and **Checkout (Detached)**
checks out the commit; with several branches there, the row acts on the
commit and you pick a branch from its badge.

The graph tab's title bar has buttons for **Fetch From All Remotes**, and
Pull and Push (or **Publish Branch...** when the current branch has no
upstream); while an operation is stopped, for Continue, Abort and Fetch. Its
**...** menu has the stash commands, **Show Stashes...**, Skip (while
stopped), **Undo Last Operation** and **Show Git Output**. The Command
Palette has them too.

- **Branches and tags:** Checkout (a remote branch checks out its local
  branch, or creates one that tracks it; when the local branch of that name
  tracks something else, you choose between switching to it anyway and
  creating a tracking branch of another name), Create Branch, Create Tag,
  Rename, Delete and Copy Name. Deleting a branch says which commits no other branch
  or tag has. Push Tag pushes a tag to a remote (you pick one when there are
  several), and says so when the remote already has a different tag of that
  name. Delete Remote Tag deletes it there and keeps your local tag;
  that can't be undone.
- **History:** Merge into Current Branch (fast-forward or a merge commit),
  Rebase Current Branch onto This, Cherry Pick, Revert, and Reset Current
  Branch to Here in any of git's modes. Each confirmation says what happens to
  which commits. A merge commit can be cherry picked relative to the parent you
  choose, and reverted, which undoes the commits it brought in from its other
  parents.
- **Stashes:** Stash Changes (optionally with untracked files), Apply, Pop,
  Drop, Create Branch from Stash and Copy Patch. Apply and Pop bring staged
  changes back staged, unless they no longer apply to the index or you have
  staged changes of your own. Apply, Pop and Create Branch
  from Stash change nothing when files the stash's untracked part adds already
  exist in your work tree, and name those files so you can move them away
  first.
- **Remotes:** Fetch From All Remotes (Fetch Remote on a remote branch badge
  fetches just its remote), Pull (fast-forward, merge or rebase, following
  `pull.rebase`), Push and Publish Branch. Pull and Push follow the branch's
  configured upstream, also one given by URL (as a fork's pull request
  checkout sets) or one a single-branch clone doesn't fetch. When the remote
  deleted the upstream, Pull says so and offers to publish the branch again
  or unset its upstream. A rejected push
  says how many commits the remote has that your branch doesn't, and offers a
  force push with lease when `git.allowForcePush` is on. Delete Remote Branch, on a
  remote branch badge, says which commits no other branch or tag has and which
  local branches track it (they stay). It deletes nothing when someone pushed
  to the branch since your last fetch, and asks again with what they pushed.
  Deleting a remote branch can't be undone.
- **Uncommitted changes** are named in the confirmation, with the choice to
  stash them around the operation (and bring them back after it) or keep them
  in place. `strata.autoStash` decides which comes first: `gitConfig` (the
  default) follows `merge.autoStash` for merge and pull with merge (stashing
  first while it is not set) and keeps changes in place first for cherry pick
  and revert; `always` puts stashing first, `never` keeping them in place. A
  rebase always needs the stash, and so does a merge commit over staged
  changes. A hard reset keeps your changes in a stash it
  never pops, unless you discard them. A keep reset over changes to files it
  changes moves just those changes into such a stash and keeps the rest in
  place.
- **Untracked files** in the way stop a checkout, merge, rebase, pull, cherry
  pick, revert or Create Branch from Stash that would put files of its own
  there. Strata names them and offers **Stash Them & Retry**, which moves just
  those files into a stash and runs the operation again. That stash stays in the
  list. Strata does not bring your files back, because the operation puts its
  own versions in their place.
- Merge says so when the two lines have no commit in common. In a **shallow
  clone**, which may only lack that commit, Merge and Rebase offer **Fetch
  More History** (100 commits further back) or **Fetch Full History**
  instead. Cherry Pick, Revert and Copy Patch (of a commit or of one of its
  files) offer the same for the clone's oldest commits, whose parents are not
  there to tell their changes from the whole tree. Run the operation again once the history is there.
- **Undo Last Operation** puts back what the last operation changed: a reset,
  merge, rebase, cherry pick or revert (also one that stopped and that
  Continue or Skip finished), a created, renamed or deleted branch or tag, or a
  dropped stash. It only moves the branch the operation moved,
  and asks first if that branch moved since.
- When an operation stops at conflicts, Strata says where and in which files;
  **Resolve...** opens them, **Skip...** (rebase, cherry pick and revert)
  leaves the stopped commit out, and other changes (except Fetch) are
  disabled until you continue or abort. A Continue that stops again (at the next conflict, or at an `edit`
  or `break` of a rebase you started with `git rebase -i`) says so. A cherry
  pick or revert of several commits that you ended with `git commit` instead
  of `git cherry-pick --continue` still shows as in progress, with Continue
  for the remaining commits and Abort. Strata never opens an editor for a
  commit message: before continuing a rebase whose remaining steps would
  (`reword`, `squash`, `fixup -c`, `merge` without `-C`), it offers to type
  `git rebase --continue` into a terminal for you, or to continue with the
  messages git prepares, unedited. If bringing back stashed changes conflicts, the stash is kept and
  Strata says where it is. Abort and Skip name the changes you made while the
  operation was stopped that git would throw away (any change during a rebase;
  staged ones during a merge, cherry pick or revert), and keep them in a stash
  it never pops, unless you discard them.
- Every git command Strata runs is logged in the **Strata** output channel
  (**Show Git Output**). Sign-in problems offer to type the same command into
  a terminal for you to run there.

## Large repositories

On the Linux kernel (1.5 million commits) the graph opens in about 0.2
seconds once the repository has a commit-graph.

Strata asks git for history in topological order, which is fast when the
repository has a commit-graph file. Without one, git reads the whole history
before showing the first commit (about 20 seconds on the Linux kernel). When
that happens Strata offers to write a commit-graph; you can also run
**Strata: Write Commit-Graph for Faster History** at any time. It runs
`git commit-graph write --reachable`, the same thing `git maintenance` does,
and only adds a cache file to the repository. Turn the offer off with the
`strata.suggestCommitGraph` setting.

New commits (your own, fetched or rebased) are not in the commit-graph until
it is written again. With `strata.keepCommitGraphUpdated` turned on (or
**Write and keep updated** in the offer), Strata adds them in the background a
few seconds after the history changes, which takes milliseconds even on the
Linux kernel. It only updates repositories that already have a commit-graph.

## Requirements

- VS Code 1.90 or later.
- git installed where the repository is (the built-in Git extension must be
  enabled). Changing the repository needs git 2.27 or later.

## Feedback

Report problems and requests at https://github.com/zekaizer/strata/issues.

## License

MIT. See `LICENSE`.
