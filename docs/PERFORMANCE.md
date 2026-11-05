# Performance

Measurements of the first page of history and of graph layout on the Linux
kernel. Reproduce with `npm run perf -- <repo>` (git and layout) and
`STRATA_PERF_REPO=<repo> npm run perf:e2e` (VS Code end to end).

## Setup

| Item       | Value                                                                     |
| ---------- | ------------------------------------------------------------------------- |
| Repository | torvalds/linux from GitHub, `git clone --filter=tree:0 --no-checkout`     |
| History    | 1,505,332 commits, 955 refs (952 tags), 830 MB `.git`                     |
| Machine    | 4 × Intel Xeon @ 2.10 GHz, cloud container                                |
| Software   | git 2.43.0, Node 22.23, VS Code 1.144.1 (stable), Xvfb                    |
| Page       | First page = 300 commits; median of 3 runs after one warm-up (git/layout) |

Page cache was warm for all numbers. kernel.org does not support partial
clone filters (`filtering not recognized by server`), so the tree:0 clone
comes from the GitHub mirror. A full clone from kernel.org took 19.2 s for
the first page without a commit-graph, against 17.7 s here.

## First page of history

| Path                                                           | No commit-graph | With commit-graph |
| -------------------------------------------------------------- | --------------: | ----------------: |
| `LogReader` first page (topo order, branches + remotes + HEAD) |       17,725 ms |         **59 ms** |
| VS Code: command to first page laid out, first open            |       22,194 ms |          1,108 ms |
| VS Code: same, later opens (median of 3)                       |       19,452 ms |        **195 ms** |

Writing the commit-graph (`git commit-graph write --reachable`) took 20.6 s
once. The first VS Code open includes extension activation and the built-in
git extension's start-up.

Without a commit-graph, git's topological walk reads all 1.5M commits before
it prints the first one; that cost is git's and the same for every ordering
that keeps children above parents. Strata therefore offers to write a
commit-graph when the first page takes longer than 2 s.

### Choices these numbers drove

| Variant (with commit-graph), `git log -n300`   |   Time |
| ---------------------------------------------- | -----: |
| `--topo-order` from branches, remotes, HEAD    | ~0.1 s |
| `--topo-order` also starting from all 952 tags |  3.3 s |
| `--date-order` also starting from all tags     |  3.3 s |
| No ordering (children may follow parents)      |  29 ms |

- Tags are not start points: old release tags widen git's walk to nearly
  all history. They still label commits.
- `--topo-order` instead of `--date-order`: same cost, but the kernel's first
  page is 14 lanes wide instead of 58.
- Unordered output is not used: the layout needs children before parents.

## Commit details

Clicking a commit reads its message (`git log -1 --no-walk`) and changed
files (`git diff-tree`). `git show -s` was used first and took 0.5-1.5 s on
the kernel's merge commits (show prepares the combined diff even when told
not to print it), which made opening a merge — usually the first commits on
screen — feel slow. With `log`: 8-16 ms per merge commit; click to details
in VS Code 37-56 ms (`test/perf/details-latency.test.ts`).

## Keeping the commit-graph current

`strata.keepCommitGraphUpdated` runs `git commit-graph write --reachable --split`
3 s after each history reload, never two at once, and only where a commit-graph
already exists. Measured on the Linux kernel clone (1.5M commits, git 2.43):

| Case                                                              | Wall time                         |
| ----------------------------------------------------------------- | --------------------------------- |
| First run over a single-file graph (converts it to a split chain) | 3.4 s (0.04 s CPU, the rest disk) |
| 5 new commits                                                     | 0.05 s                            |
| Nothing new                                                       | 0.03 s                            |

Chosen over setting `fetch.writeCommitGraph` in the repository's git config:
that changes the user's config and covers fetches only, not local commits,
rebases or branch moves.

## Layout

100,000 kernel commits in topological order, laid out in pages of 1,000:

| Representation              |       Time |  Per commit | Line data        |
| --------------------------- | ---------: | ----------: | ---------------- |
| Per-row pass edges (before) |  ~3,020 ms |     30.2 µs | 35.8M pass edges |
| Spans (current)             | **156 ms** | **1.56 µs** | 12,957 spans     |

The kernel graph reaches 694 lanes; a row is crossed by ~360 lines on
average. Storing each lane's vertical run once (a span) instead of in every
row made layout output proportional to commits, which is what lets the
webview keep hundreds of thousands of rows.

## Find

Measured on zephyr (156,302 commits in the default view, 231 refs) in a
`git clone --shared` with its commit-graph removed, git 2.56, 28 cores shared
with other work (load average about 5). VS Code end to end with
`STRATA_PERF_REPO=<repo> npm run perf:e2e` (`test/perf/find.test.ts`); git and
the host side alone with `findCommits`/`locateCommit` from a script (3 runs
each).

| What                                            |                            Host side (git) |                                           VS Code, from typing / Enter |
| ----------------------------------------------- | -----------------------------------------: | ---------------------------------------------------------------------: |
| Text no commit has: whole history scanned       |                                0.80-0.86 s |                                                              1.2-1.9 s |
| Common text (`bluetooth`): first hit, 10,000th  |                             0.74 s, 0.81 s |                                               1.73-1.84 s, 1.81-1.91 s |
| `author:"Johan Hedberg"` (2,337 hits): done     |                                0.88-0.92 s |                                                            1.87-1.96 s |
| Same three with a commit-graph: first hit       |                       0.80 s, 25 ms, 40 ms |                                                                        |
| Go to the oldest commit (locate, then load all) | locate 0.76 s (0.14 s with a commit-graph) |                                                              2.1-3.0 s |
| Go to commit #100,000 by hash                   |                                            |                                                              1.0-1.2 s |
| Escape while loading down to a match            |                                            | 16 ms to stop; the page in flight (up to 10,000 commits) still arrives |

The VS Code times include the widget's 200 ms typing debounce. Without a
commit-graph, git's topological walk reads all history before it prints the
first commit, as for the first page, so the first hit costs the same as a full
scan; with one, common text shows its first hits in tens of milliseconds and
only text few commits match pays for the whole scan, which reads every commit
message. The rest of the VS Code time is the extension host competing with VS
Code's own git extension, which scans the 70,000-file checkout when the window
opens (the spread between runs follows it). Going far down costs the same
loading and layout as scrolling there: pages of 10,000 commits, with progress
in the toolbar and the widget.

## Known limits

- Chromium caps element height at about 33.5M px; at 24 px per row the list
  cannot scroll past roughly 1.4M commits.
- Commits reachable only from another worktree's detached HEAD are not shown.
