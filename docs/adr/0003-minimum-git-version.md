# 3. Minimum git version for repository changes

Date: 2026-11-05

## Status

Accepted

Supersedes the minimum git version of [ADR 2](0002-repository-changes.md).

## Context

ADR 2 set git 2.27 as the minimum for write operations, the first release with `merge --autostash`.
No build tested that version: CI runs the git of its runner image only, and git behaviour differs
between releases in ways the tests catch only on the release that has it.

One such difference loses work. git 2.27 to 2.37 exit a `merge --autostash` that the merge strategy
refuses (an untracked file in the way, for example) without applying the autostash: the working tree
comes back clean, `git stash list` is empty and the changes wait in `MERGE_AUTOSTASH` for the next
merge. git 2.38.0 and later apply them. This was measured against git 2.34.1, 2.37.3, 2.37.4, 2.38.0,
2.39.0, 2.39.5, 2.43.0 and 2.56.0.

Ubuntu 22.04 ships git 2.34.1; the other maintained desktop and server platforms ship 2.38 or later.

## Decision

- Write operations require git 2.34.0 or newer. An older git keeps the read-only graph.
- CI runs the unit and integration tests against the minimum version as well as against the runner's
  git. Raising or lowering the minimum is a change to this record.
- When a `merge --autostash` fails and leaves `MERGE_AUTOSTASH` without a merge in progress, Strata
  applies it as git 2.38 does: `stash apply`, or `stash store` when the apply fails.

## Consequences

- Users of git 2.27 to 2.33 lose write operations until they update git.
- A git difference between the minimum and current releases fails in CI instead of on a user's
  repository. Each one found is either handled in Strata or a reason to raise the minimum.
- The `MERGE_AUTOSTASH` recovery is dead code once the minimum reaches 2.38.
