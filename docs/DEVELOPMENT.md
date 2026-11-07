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
| Multi-repository integration tests     | `npm run test:integration:multi`                    |
| Everything                             | `npm test`                                          |
| Suites leave an outer `GIT_DIR` alone  | `npm run test:isolation` (any command: see below)   |
| Screenshot the context menus           | `STRATA_MENU_SHOT_DIR=<dir>` with `npm run shot`    |
| Screenshot the panel in all themes     | `npm run shot` → `artifacts/shots/*.png`            |
| Screenshot for the README              | `npm run shot:readme` → `artifacts/shots/`          |
| Webview playground in a browser        | `npm run playground` → http://localhost:5173/       |
| Playground screenshots (Playwright)    | `npm run playground:shot` → `artifacts/playground/` |
| Re-capture VS Code theme variables     | `npm run capture-themes` → `playground/themes/`     |
| Fixture repos → `out/fixtures/<name>`  | `npm run fixtures [name ...]`                       |
| Command contributions from the table   | `npm run manifest` (after editing `commands.ts`)    |
| Performance (git + layout)             | `npm run perf -- <repo>`                            |
| Performance in VS Code                 | `STRATA_PERF_REPO=<repo> npm run perf:e2e`          |
| Package                                | `npm run package` → `artifacts/strata.vsix`         |

Interactive debugging: F5 ("Run Extension") generates the fixture repositories,
starts the watch tasks and opens the chosen fixture in an Extension Development
Host.

## Fixtures

`test/fixtures/` builds repositories with `git fast-import` from fixed dates
and identities, so object ids are identical on every machine. Scenarios:
`linear`, `branchy` (criss-cross, unmerged branch), `stashes` (branchy with
two stashes on one base, one on HEAD, a displaced autostash and one on a commit
no ref reaches), `octopus`, `multi-root`, `refs` (annotated/lightweight tags,
remotes, ahead/behind), `clock-skew`, `paths` (one file renamed, changed on
merged, unmerged and cherry-picked branches, with branch tips that leave it
unchanged), `large` (5000 seeded random commits).
`test/fixtures/stashes.ts` writes stashes with git plumbing, so integration
tests add the same ones to the `branchy` workspace and drop them afterwards.

`test/fixtures/workspaces.ts` writes `multi-repo`, a folder that is not a
repository holding `alpha` and `beta` and `gamma` nested in `beta`. The tests in
`test/multirepo/` run against it under the `multi` and `multi-min` labels, and
`scripts/restart-test.mjs <version> multi` checks the repository shown last is
restored. `npm run test:integration` and `test:integration:min` run them after
the single-repository tests.

It also writes `showcase`, holding `quillboard` (`test/fixtures/showcase.ts`):
49 commits of an invented web app by six invented authors, with pull request
merges, release tags, a release branch and remote-tracking branches. Only the
README screenshot uses it, under the `readme` label (`test/readme/`).

## Running inside another git command

`git rebase --exec`, hooks and similar set `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
friends for the commands they run. Tests and fixtures create repositories of their own, so these
must not reach them: `test/isolate-git.ts` removes them from the environment of the unit test
processes (`--import`), the fixture writer and the VS Code instances the integration tests start.
`node scripts/git-isolation.ts <command>` runs a command with them pointing at a scratch
repository and fails if it changed; `npm run test:isolation` does that for the unit tests.

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

## Design system

The design system (principles, tokens, components and their guidelines) is defined in the
[Strata design system artifact](https://claude.ai/artifact/AKgFR4o6MTFjcrnQKGsVGK), the single
source of truth. The artifact is written in Korean; `docs/design-system.md` is its English copy,
dated by the artifact change it follows, and is changed only to follow the artifact. Where the code
and the design system disagree, the design system wins.

| File                              | Holds                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- |
| `src/webview/tokens.css`          | Every raw value: the design system's tokens as custom properties.           |
| `src/webview/components.css`      | The design system's components, built only from tokens.                     |
| `src/webview/main.css`            | Imports both, then lays out the views (grid, positions, view-only parts).   |
| `test/unit/design-tokens.test.ts` | The guard: fails on raw values outside `tokens.css` and on unearned tokens. |
| `playground/gallery.ts`           | The gallery: every token and component in every state.                      |

The artifact's `tokens.json` holds each color resolved per theme, as `playground/themes` captures
VS Code's default themes; `tokens.css` holds what produces it (`var(--vscode-…)`, fallbacks,
`color-mix`), which each token's usage note names. The artifact's `components/bundle.css` is
`components.css` with high contrast selectors keyed to `[data-theme]`, every hover, active and focus
rule copied onto `.is-hover`, `.is-active`, `.is-focus-visible` and `.is-focus`, and the VS Code
variables the components read declared per theme.

The guard holds two of the design system's rules: colors, radii, font sizes, spacing and `z-index`
come from tokens (`0` and `1px` aside; an exception is an `ALLOWED` entry with its reason), and a
token is read at least twice unless it is in a family (`FAMILIES`) or a `SINGLE_USE` entry with its
reason. `test/integration/spacing.test.ts` holds the spacing rule for the details and the popovers.

To change the design system:

1. Change the artifact: the token with its usage note, the component's guideline and preview, or
   the rule.
2. Implement it in `tokens.css`, then `components.css`, with a specimen in every state in
   `playground/gallery.ts`, then the feature that uses it.
3. Bring the artifact's resolved values (`tokens.json`) and `components/bundle.css` in line with the
   code.
4. Bring `docs/design-system.md` in line with the artifact, and its date with the artifact's last
   change.

The gallery is `index.html?page=components&theme=<theme>` in `npm run playground`; screenshot it
in all four themes with `node scripts/playground-shot.mjs artifacts/gallery 1280x800 page=components`.
Hover, active and focus states are forced there by copying each rule that uses those pseudo-classes
onto `.is-hover`, `.is-active`, `.is-focus-visible` and `.is-focus`.

## Icons and screenshot

`media/icon.svg` is the source of the extension icon `media/icon.png`
(256×256). `media/strata-mono.svg` is the monochrome design of the product
icon; icon fonts cannot carry its translucent bars, so
`media/product-icons/strata-graph.svg` is the font-safe version (one filled
path: solid bars cut back from the lane). It is contributed as
`$(strata-graph)` from `media/strata-icons.woff` at U+F101. After changing it,
regenerate the font with a pinned one-off fantasticon (not a dependency):

```bash
mkdir -p artifacts/icon-font
npx -y fantasticon@4.1.0 media/product-icons -o artifacts/icon-font \
  -n strata-icons -t woff -g json --normalize -h 1000
cp artifacts/icon-font/strata-icons.woff media/
```

`artifacts/icon-font/strata-icons.json` must still map `strata-graph` to
`61697` (U+F101); a second SVG in `media/product-icons/` takes the next code
point.

`media/screenshot.png`, the README's screenshot, comes from
`npm run shot:readme` (`artifacts/shots/readme.png`, on the default 1600×1000
screen, dates in UTC) without the window title bar, reduced to 256 colors:

```bash
convert artifacts/shots/readme.png -crop 1440x864+80+86 +repage -strip \
  -dither None -colors 256 PNG8:media/screenshot.png
```

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
the Extensions view) gets the build's commit and date under its header, at the
`<!-- ci-stamp -->` line, so an installed CI build says which one it is. The
script fails if the README lacks that line. A release of the same version
sorts above it. Release packaging (`npm run package`) does not stamp.

`package.json` overrides the `glob` used by mocha (through
`@vscode/test-cli`) with glob 13: mocha 11 pins the deprecated glob 10,
and mocha 12 is ESM-only, which VS Code 1.90's extension host cannot load.
