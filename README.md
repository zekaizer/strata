# Strata

A fast commit graph for git repositories in VS Code. It reads history page by
page, so it opens quickly even on very large repositories.

## Features

- Commit graph of all local branches, remote-tracking branches, tags and HEAD,
  with branch, remote, tag and stash badges on their commits.
- Commit details: author, committer, full message, parents and changed files.
- Click a changed file to open its diff in the VS Code diff editor.
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
- Click a file in the details to open its diff against the parent commit.
- Use the refresh button after changing the repository outside VS Code.

## Requirements

- VS Code 1.90 or later.
- git installed where the repository is (the built-in Git extension must be
  enabled).

## Feedback

Report problems and requests to the maintainers of this extension.
