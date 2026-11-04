# Strata

Commit graph for git repositories in VS Code. In-house, clean-room
implementation. Architecture and toolchain decisions:
`docs/adr/0001-architecture-and-toolchain.md`.

## Requirements

- VS Code >= 1.90 (runs in the workspace extension host: local, WSL, SSH)
- git on the host that has the repository

## Development

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
| Screenshot the panel in all themes     | `npm run shot` → `artifacts/shots/*.png`            |
| Webview playground in a browser        | `npm run playground` → http://localhost:5173/       |
| Playground screenshots (Playwright)    | `npm run playground:shot` → `artifacts/playground/` |
| Re-capture VS Code theme variables     | `npm run capture-themes` → `playground/themes/`     |
| Package                                | `npm run package` → `artifacts/strata.vsix`         |

Interactive debugging: F5 ("Run Extension") starts the watch tasks and an
Extension Development Host.

### Headless environments

Integration tests, screenshots and theme capture start a real VS Code. Without
a `DISPLAY`, `scripts/xvfb.mjs` wraps them in `xvfb-run`. Screenshots use
ImageMagick `import`. Test instances use a short `--user-data-dir` under the
temp dir (override with `STRATA_TEST_TMP`) because VS Code's IPC socket lives
there and unix socket paths are limited to 108 bytes.

### Iteration loop

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
