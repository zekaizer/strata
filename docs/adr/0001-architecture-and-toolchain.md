# 1. Architecture and toolchain

Date: 2026-11-04

## Status

Accepted

## Context

Strata is an in-house VS Code extension that renders the commit graph of a git
repository. It replaces a third-party extension and must be a clean-room
implementation. Target repositories include very large ones (Linux kernel
scale, more than 1M commits), used over WSL and SSH remotes. The minimum
supported VS Code is 1.90.

## Decision

### Data access

- Spawn the `git` CLI directly. Commit data is read with `git log` using a
  custom `--format` whose fields and records are NUL-separated, parsed as a
  stream.
- The built-in `vscode.git` extension API is used only for repository
  discovery, repository state change events and the configured git binary path.
- History is always read page by page. Loading the full history is not
  supported. `--first-parent` is a user toggle.
- History is read in `--topo-order`, starting from local branches,
  remote-tracking branches and HEAD. Tags are not start points: on the Linux
  kernel (952 tags) they made git walk nearly all history before printing the
  first commit (4.8 s with a commit-graph, 0.1 s without tags). Tags still
  label commits; a commit reachable only from a tag shows when that tag is
  selected in the ref filter. Topological order also keeps the first page of
  the kernel graph 14 lanes wide instead of 58 with `--date-order`.

### Graph layout

- Lane assignment is a pure function from (previous lane state, page of
  commits) to (layout rows for the page, next lane state). Pages are laid out
  incrementally, never re-laid from the start.
- Layout runs in a Web Worker inside the webview, off the UI thread.

### Rendering

- A single webview with a virtual-scrolled list. The graph column is drawn on
  `<canvas>`; per-row SVG is not used.
- UI chrome uses only VS Code theme CSS variables. Graph colors come from a
  token set (lane palette + semantic ref colors) defined per theme kind (light,
  dark, high contrast) and validated for contrast by a script.
- The webview has no UI framework and no runtime npm dependencies besides
  bundled codicons.

### Diffs

- Diffs are opened with the `vscode.diff` command on `git:` URIs produced by the
  built-in git extension's `toGitUri`. Strata registers no content provider.

### Extension shape

- `extensionKind: ["workspace"]` so it runs on the host that has the repository
  and git.
- `engines.vscode: ^1.90.0`. The extension bundle is CommonJS (ESM extensions are
  not supported at that version).

### Toolchain

- TypeScript 6.0 (strict, `erasableSyntaxOnly`). TypeScript 7 is not used until
  typescript-eslint supports it.
- esbuild is the only bundler (extension, webview, worker, tests).
- Unit tests: `node:test` executed directly on `.ts` sources via Node's type
  stripping (Node >= 22.18). No test framework dependency.
- Integration tests: `@vscode/test-cli` + `@vscode/test-electron`, run under
  Xvfb in headless environments.
- Lint: ESLint flat config with typescript-eslint. Format: Prettier.
  Packaging: `@vscode/vsce`.
- The package is ESM (`"type": "module"`); bundles that must be CommonJS
  (extension, integration tests) are emitted as `.cjs`.

## Consequences

- Parsing depends on `git log` output format stability; the format string is
  owned by Strata and covered by unit tests against fixture repositories.
- No full-history features (e.g. global search over all commits) without an
  explicit, separate design.
- Incremental layout makes page boundaries a correctness hazard; it must be
  tested with layouts split at every possible boundary and compared to a
  single-page layout.
- The webview cannot read CSS variables from canvas directly; theme tokens are
  resolved via `getComputedStyle` and re-resolved on theme change.
- Unit tests require Node >= 22.18 and only erasable TypeScript syntax (no
  enums, namespaces, parameter properties).
