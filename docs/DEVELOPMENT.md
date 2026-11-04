# Developing Strata

Developer guide. End-user documentation is in the top-level `README.md`;
architecture and toolchain decisions are in `docs/adr/`.

## Setup

Requires Node >= 22.18 (unit tests run `.ts` directly via type stripping).

```bash
npm ci
```

| Task                                   | Command                                             |
| -------------------------------------- | --------------------------------------------------- |
| Build once / watch                     | `npm run build` / `npm run watch`                   |
| Typecheck + lint + format + unit tests | `npm run check`                                     |
| Unit tests only                        | `npm run test:unit`                                 |
| Integration tests (VS Code stable)     | `npm run test:integration`                          |
| Integration tests (VS Code 1.90.0)     | `npm run test:integration:min`                      |
| Everything                             | `npm test`                                          |
| Screenshot the context menus           | `STRATA_MENU_SHOT_DIR=<dir>` with `npm run shot`    |
| Screenshot the panel in all themes     | `npm run shot` → `artifacts/shots/*.png`            |
| Webview playground in a browser        | `npm run playground` → http://localhost:5173/       |
| Playground screenshots (Playwright)    | `npm run playground:shot` → `artifacts/playground/` |
| Re-capture VS Code theme variables     | `npm run capture-themes` → `playground/themes/`     |
| Fixture repos → `out/fixtures/<name>`  | `npm run fixtures [name ...]`                       |
| Performance (git + layout)             | `npm run perf -- <repo>`                            |
| Performance in VS Code                 | `STRATA_PERF_REPO=<repo> npm run perf:e2e`          |
| Package                                | `npm run package` → `artifacts/strata.vsix`         |

Interactive debugging: F5 ("Run Extension") generates the fixture repositories,
starts the watch tasks and opens the chosen fixture in an Extension Development
Host.

## Fixtures

`test/fixtures/` builds repositories with `git fast-import` from fixed dates
and identities, so object ids are identical on every machine. Scenarios:
`linear`, `branchy` (criss-cross, unmerged branch), `octopus`, `multi-root`,
`refs` (annotated/lightweight tags, remotes, ahead/behind), `clock-skew`,
`large` (5000 seeded random commits).

## Headless environments

Integration tests, screenshots and theme capture start a real VS Code. Without
a `DISPLAY`, `scripts/xvfb.mjs` wraps them in `xvfb-run`. Screenshots use
ImageMagick `import`. Test instances use a short `--user-data-dir` under the
temp dir (override with `STRATA_TEST_TMP`) because VS Code's IPC socket lives
there and unix socket paths are limited to 108 bytes.

## Iteration loop

- Webview layout/visuals: `npm run playground` (live rebuild, theme via
  `?theme=dark|light|high-contrast|high-contrast-light`), then
  `npm run playground:shot` to compare all themes.
- Host ↔ webview behavior: `npm run test:integration`, then `npm run shot` for
  the real VS Code rendering.

## Layout

```
src/extension.ts     activation, command registration
src/host/            extension-host side (git, panel)
src/core/            pure logic shared by host and worker (no vscode, no DOM)
src/shared/          host ↔ webview ↔ worker message types
src/webview/         webview UI
src/worker/          layout Web Worker (runs inside the webview)
test/unit/           node:test, run on .ts sources
test/integration/    @vscode/test-cli suites (bundled to out/)
playground/          browser host for the webview + captured theme variables
scripts/             build, xvfb wrapper, screenshot tooling
```

Measured numbers and the decisions they drove are in `docs/PERFORMANCE.md`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: typecheck,
lint, format and unit tests; integration and restart tests under Xvfb on VS
Code stable and 1.90.0; then packages the extension. Each successful run
uploads `strata-<version>-ci.<run>-<short sha>.vsix` as a workflow artifact,
kept for 30 days: open the run under the repository's **Actions** tab and
download it from **Artifacts** (requires a GitHub login). The download is the
`.vsix` itself, not a zip. These are the test builds to share; there are no
GitHub releases. Runners are pinned to `ubuntu-24.04`.

Before packaging, CI runs `scripts/ci-stamp.mjs`: the version becomes
`<version>-ci.<run number>` and the README (the extension's details page in
the Extensions view) starts with the build's commit and date, so an installed
CI build says which one it is. A release of the same version sorts above it.
Release packaging (`npm run package`) does not stamp.

`package.json` overrides the `glob` used by mocha (through
`@vscode/test-cli`) with glob 13: mocha 11 pins the deprecated glob 10,
and mocha 12 is ESM-only, which VS Code 1.90's extension host cannot load.
