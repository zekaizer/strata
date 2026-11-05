# 2. Repository changes through Strata's own git command layer

Date: 2026-11-04

## Status

Accepted

## Context

Strata was read-only. Users need everyday git workflows from the graph: checkout, branches and tags,
merge, rebase, cherry-pick, revert, reset, stash, fetch, pull and push, plus copying a commit's patch.
ADR 1 reads history with the git CLI and uses the built-in `vscode.git` API only for discovery, state
events and the git path. Writes need a decision of their own: the API covers part of the operations
(no reset modes, no revert, no stash by commit, no explicit autostash control at VS Code 1.90), and the
graph needs exact facts (which commits a reset drops, what an operation stopped on) that the API does
not expose. Target repositories include very large ones over WSL and SSH remotes.

## Decision

- Strata changes repositories by spawning the git CLI through one typed layer: an `Operation` union in
  `src/core` maps to git arguments; one runner executes them one at a time with progress, cancellation
  (remote operations) and a log in the "Strata" output channel. git runs with English messages so
  failures can be classified, and with editors and terminal prompts disabled.
- Write operations require git 2.27 or newer (`merge --autostash`).
- Uncommitted changes are handled by one pure decision (`resolveStashChoices`): git's own
  `--autostash` where git has it (rebase, merge, pull), Strata's stash push/pop around the operation
  where it does not (cherry-pick, revert, switch with overlapping changes), and a never-popped safety
  stash before a hard reset. Strata never drops a stash on its own.
- Confirmations state concrete effects computed from git right before the operation, not from the
  menu's possibly stale context.
- Authentication relies on credential helpers and SSH agents. When git needs a prompt, Strata offers
  to run the same command in an integrated terminal. Strata ships no askpass of its own.
- Conflicts are resolved in VS Code's own Source Control view and merge editor. Strata shows the
  operation in progress and offers Continue, Abort and Skip.
- Command, menu and title-bar contributions are generated from one command table
  (`src/shared/commands.ts`); a unit test keeps `package.json` equal to it.
- Stashes are shown as rows synthesized in the webview above their base commit. They do not enter
  `git log` or the lane layout, which stays a pure function of the commit pages.

## Consequences

- Operation behaviour is tested against real repositories in unit tests, independent of VS Code.
- HTTPS remotes without a credential helper cannot push or fetch from the graph directly; the terminal
  hand-off is one extra step for those users. An askpass needs a separate decision.
- git error classification depends on git's English message texts; new texts fall back to showing
  git's own message.
- Strata and `vscode.git` both run git in the same repository; index lock contention is retried once.
- Users of git older than 2.27 keep the read-only graph.
