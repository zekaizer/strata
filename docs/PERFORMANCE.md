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

## Known limits

- Chromium caps element height at about 33.5M px; at 24 px per row the list
  cannot scroll past roughly 1.4M commits.
- Commits reachable only from another worktree's detached HEAD are not shown.
