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
- Works in narrow editors: columns collapse as space shrinks and the details
  move below the list.
- Works in local folders, WSL, SSH and other remote workspaces: Strata runs
  where the repository is.
- Follows your color theme, including high contrast themes; graph colors adapt
  to the theme's background so lines stay readable.

## Usage

- Run **Strata: Show Commit Graph** from the Command Palette, or click the
  commit-graph button in the Source Control view title bar.
- Scroll to load more history.
- Select a commit (click, or ↑/↓ with the list focused) to show its details;
  <kbd>Esc</kbd> closes them.
- Click a file in the details to open its diff against the parent commit
  (<kbd>Alt</kbd>+click opens it to the side). With a file focused, ↑/↓ move
  between files and <kbd>Enter</kbd> opens one.
- Use the branch button in the toolbar to show only some refs (type to search,
  **Show all** to reset), and **First parent** to follow only the main line of
  merges.
- Drag the edge of the details pane to resize it. The pane sits beside the
  list in wide editors and below it in narrow ones.
- Use the refresh button after changing the repository outside VS Code.

## Requirements

- VS Code 1.90 or later.
- git installed where the repository is (the built-in Git extension must be
  enabled).

## Feedback

Report problems and requests to the maintainers of this extension.
