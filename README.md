# Strata

A fast commit graph for git repositories in VS Code. It reads history page by
page, so it opens quickly even on very large repositories.

## Features

- Commit graph of all local branches, remote-tracking branches, tags and HEAD,
  with branch, remote and tag badges above their commits. A branch and
  its same-named remote-tracking branches on the same commit share one badge
  (`main │ origin`); when they differ, both show, so unpushed work stands out.
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
  Right-click a commit to copy its hash, short hash or subject.
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
- Use the refresh button after changing the repository outside VS Code.

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
  enabled).

## Feedback

Report problems and requests at https://github.com/zekaizer/strata/issues.

## License

MIT. See `LICENSE`.
