# 5. Tags as history start points

Date: 2026-11-17

## Status

Accepted

Supersedes the history's start points of [ADR 1](0001-architecture-and-toolchain.md).

## Context

ADR 1 left tags out of the default history's start points: on the Linux kernel (952 tags) starting
`git log --topo-order` from every tag made git walk nearly all history before the first commit.
Tags only labelled commits a branch reaches. A commit that only a tag reaches, such as a release
made from a branch that was deleted afterwards, did not show unless the tag was picked in the ref
filter, although tags are refs the user keeps on purpose.

Measured with git 2.56 on a `--filter=tree:0` clone of torvalds/linux (1.5M commits, 954 tags),
first 300 commits:

| Command                                                                     | Commit-graph |   None |
| --------------------------------------------------------------------------- | -----------: | -----: |
| `git log --topo-order` from branches, remotes and HEAD                      |        10 ms |  7.5 s |
| the same, also from `--tags`                                                |       710 ms |      – |
| `git rev-list --tags --not --branches --remotes HEAD`                       |       650 ms |  6.5 s |
| `git for-each-ref refs/tags --no-merged=<each branch and remote tip, HEAD>` |        50 ms | 450 ms |

Most tags are on a branch and add nothing to the history; only the others need to be start points.

## Decision

The default history is that of every branch, remote-tracking branch, tag, HEAD and the other
worktrees' detached HEADs. Before reading it, Strata asks `git for-each-ref --no-merged` for the
tags that none of the branch, remote-tracking branch and HEAD commits reach, and starts the log from
their commits too. `--no-merged` takes one commit per option, so a repository with more tips than
fit a command line is asked in several runs and the tags every run keeps are used.

A ref change compares start points that include every tag's commit: a tag created or deleted on a
branch keeps the history; one off every branch reloads it.

## Consequences

- Reading the history costs one `for-each-ref` more than before: 50 ms on the kernel with a
  commit-graph, 450 ms without one, where the first page already takes seconds.
- A commit only a tag reaches is in the graph and found by search; **Not in view** no longer names
  tags as the reason.
- A path or first-parent history also starts from those tags.
