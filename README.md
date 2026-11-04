# Strata

A fast commit graph for git repositories in VS Code. It reads history page by
page, so it opens quickly even on very large repositories.

## Features

- Commit graph of all local branches, remote-tracking branches, tags and HEAD,
  with branch, remote, tag and stash badges on their commits.
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
  <kbd>Esc</kbd>, to fold them. With the list focused, ↑/↓ move the
  selection (open details follow it) and <kbd>Enter</kbd> unfolds or folds.
- Click a file in the details to open its diff against the parent commit.
  Hover a file (or focus it) for three buttons: before (clock icon), the
  change (compare icon) and after (file icon) — the whole file as it was
  before the commit, the diff, or the whole file as of the commit. Added
  files only have the after button and deleted files only the before
  button.
  <kbd>Alt</kbd> opens to the side. With a file focused, ↑/↓ move between
  files, <kbd>Enter</kbd> opens it, and <kbd>D</kbd>, <kbd>B</kbd>,
  <kbd>A</kbd> open the diff, before and after.
- The details show the commit message body (and trailers such as
  `Signed-off-by`) below the files; the subject is the row itself.
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

## Requirements

- VS Code 1.90 or later.
- git installed where the repository is (the built-in Git extension must be
  enabled).

## Feedback

Report problems and requests to the maintainers of this extension.
