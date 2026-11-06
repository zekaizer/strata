# Design system

The webview has one visual language. Every surface (toolbar, popovers, ref bands, rows, banners,
details, file tree, hover card) is built from the tokens and components below. This document is
normative: "must" is a rule that review and `test/unit/design-tokens.test.ts` enforce.

## Principles

The scale follows VS Code's own UI, so Strata reads as part of the workbench in every theme.

- Text is VS Code's font size (`--vscode-font-size`), one pixel smaller for secondary text and two
  pixels smaller for captions. There is no other text size.
- Spacing is a 4px grid with a 2px half step.
- Every control (buttons, fields, list rows) is 22px tall, as VS Code's action items and list rows.
- Corners: 2px for push buttons and fields, 4px for everything hoverable or boxed, 6px for
  popovers.
- Every color is a VS Code theme variable or derived from one. High contrast themes get outlines
  instead of fills: dashed on hover, solid for keyboard focus, dotted for unfocused selection.
- Same role, same component. A ref is always a chip; a group heading is always a section title; a
  row in a list is always a list row.

## Files

| File                              | Holds                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `src/webview/tokens.css`          | Every raw value: the custom properties below. Nothing else.               |
| `src/webview/components.css`      | The shared components, built only from tokens.                            |
| `src/webview/main.css`            | Imports both, then lays out the views (grid, positions, view-only parts). |
| `test/unit/design-tokens.test.ts` | The guard: fails on raw values outside `tokens.css` and unearned tokens.  |
| `playground/gallery.ts`           | The gallery: every token and component in every state.                    |

## Rules

1. New UI **must** be composed from the components below. `main.css` **may** only add layout for a
   view (grid, flex sizing, positions, visibility) and view-specific parts that no other view has.
2. Colors, radii, font sizes, spacing (`margin`, `padding`, `gap`, `inset`, `top`/`right`/
   `bottom`/`left`) and `z-index` **must** come from tokens. `0` and `1px` (hairlines, offsets
   against a 1px border) are the only raw lengths allowed there. The guard rejects the rest; an
   exception **must** be an `ALLOWED` entry in the guard with its reason (today: the graph column
   width fallback).
3. An element that plays the role of an existing component **must** use it, even where a local
   variant would look "nearly the same". Do not restyle a component from a view; add a variant to
   the component instead (rule 6).
4. Hover styles **must** sit under `body:not(.hover-off)`; interactive elements **must** have a
   `:focus-visible` ring (`--focus-ring`) and a high contrast hover outline (`--hover-outline`, or
   `--vscode-toolbar-hoverOutline` on buttons). Disabled controls use `--opacity-disabled`.
5. Animations **must** stop under `body.vscode-reduce-motion` and `prefers-reduced-motion`.
6. A new token or component (or variant) is allowed only when no existing one expresses the role.
   It **must** land before its first use, in this order: the token in `tokens.css` or the component
   in `components.css`; a specimen in `playground/gallery.ts` in every state; a row in this
   document; then the feature that uses it.
7. Spacing **must** not change with the state of a surface. A block's gap to the next block is its
   own, the same whatever follows it, and **must** sit outside anything that folds, so the next block
   keeps its distance with the fold open or closed. A block that takes another's place (the message
   editor for the subject) keeps that block's gaps. `test/integration/spacing.test.ts` holds this
   for the details and the popovers.
8. A token exists only if at least one of these holds:
   1. it is read in two or more places;
   2. it is a step of a scale: spacing, radius, font size, line height, icon size, `z-index` layers;
   3. it holds a design decision beyond a VS Code variable: a derived value (a `color-mix`, a raw
      fallback such as `rgb(0 0 0 / 30%)`), a theme-specific value, a computed size.

   A single-use alias of a VS Code variable is not a token: the component reads
   `var(--vscode-…, fallback)` itself, a fallback to another VS Code variable or token included.
   The ref kind colors (`--badge-*`) are kept as a family, since a chip selects its color by kind.
   The guard counts `var()` reads in `src/webview` and fails on a token read fewer than twice
   unless it is in a family (`FAMILIES`) or a `SINGLE_USE` entry with its reason (today:
   `--surface-sunken-hover`, theme-specific).

## How new UI picks components

| You need                                               | Use                                                   |
| ------------------------------------------------------ | ----------------------------------------------------- |
| A command in the toolbar with a label                  | `.tool-button` (+ `.tool-label`), `.active` when on   |
| An icon-only command (toolbar, row action, list row)   | `.icon-button`                                        |
| An icon or hash inside a line of text                  | `.inline-button` (`.inline-button.codicon` for icons) |
| A confirming action in a popover or banner             | `.button`, `.button.primary` for the leading one      |
| Navigation inside text (commit links)                  | `.link-button`                                        |
| A text input                                           | `.field`                                              |
| Several lines of text (a commit message)               | `.field.multiline` on a `<textarea>`                  |
| A checkbox                                             | `input.checkbox` inside a `label.list-row.clickable`  |
| A dialog opened from the toolbar                       | `.popover` and its parts                              |
| A one-line dialog over the list (find)                 | `.popover.bar`, `.popover-progress` for progress      |
| A heading over a group of rows                         | `.section-title`                                      |
| A row in any list (popover, file tree)                 | `.list-row`                                           |
| A ref, a stash, a short label (status, "staged")       | `.chip`                                               |
| Information shown while the pointer rests              | `.card`                                               |
| An operation's state with actions                      | `.banner`                                             |
| A transient status, a spinner, an error in the toolbar | `.toolbar-status`                                     |
| Muted explanatory text, empty and loading states       | `--color-muted` text (`.popover-note` in popovers)    |

## Tokens

All tokens are custom properties on `:root` in `tokens.css`.

### Spacing

| Token        | Value | Use                                                            |
| ------------ | ----- | -------------------------------------------------------------- |
| `--space-2`  | 2px   | Half step: icon to text inside chips, tight vertical rhythm    |
| `--space-4`  | 4px   | Icon to text, adjacent buttons, control padding, popover inset |
| `--space-8`  | 8px   | Toolbar items, row padding, card padding                       |
| `--space-12` | 12px  | Columns of the commit list (`--col-gap`), link groups          |
| `--space-16` | 16px  | Panel edges (toolbar, banner start, details files)             |
| `--space-24` | 24px  | Between details columns                                        |

### Radius

| Token         | Value | Use                                                                           |
| ------------- | ----- | ----------------------------------------------------------------------------- |
| `--radius-sm` | 2px   | Controls VS Code draws square: push buttons, fields, link focus ring          |
| `--radius-md` | 4px   | Items: tool/icon/inline buttons, list rows, chips, checkbox, cards, segmented |
| `--radius-lg` | 6px   | Overlays: popovers                                                            |

### Type and icons

| Token                  | Value                         | Use                                                                |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `--font-size`          | `--vscode-font-size` (13px)   | Body: rows, controls, popovers, card, banner                       |
| `--font-size-sm`       | `--font-size` − 1px           | Secondary text: hashes, byline, metadata, notes, commit body, keys |
| `--font-size-xs`       | `--font-size` − 2px           | Captions: chips, section titles                                    |
| `--font-mono`          | `--vscode-editor-font-family` | Hashes, patterns, commit bodies                                    |
| `--font-weight-strong` | 600                           | Names that lead: repository, current commit, labels                |
| `--line-height`        | 18px                          | Single-line text in controls, cards, banners, headings             |
| `--line-height-prose`  | 1.5                           | Commit message bodies                                              |
| `--icon-size`          | 16px                          | Codicons beside body text (the codicon default)                    |
| `--icon-size-sm`       | 12px                          | Codicons beside secondary text (copy, toggle, diff)                |

### Sizes and layers

| Token              | Value                              | Use                                                       |
| ------------------ | ---------------------------------- | --------------------------------------------------------- |
| `--control-height` | 22px                               | Every button, field and list row                          |
| `--chip-height`    | 14px                               | Every chip (fits the ref band)                            |
| `--toolbar-height` | 32px                               | The toolbar                                               |
| `--row-height`     | 24px                               | A commit row's line (`ROW_HEIGHT` in `graph.ts`)          |
| `--ref-band`       | 14px                               | The ref band above a row (`REF_BAND` in `main.ts`)        |
| `--col-gap`        | `--space-12`                       | Between list columns; the details start at the same place |
| `--tree-indent`    | 16px                               | Per level of the file tree                                |
| `--z-popover`      | 10                                 | Popovers                                                  |
| `--z-card`         | 20                                 | The hover card (above popovers)                           |
| `--shadow`         | `0 2px 8px --vscode-widget-shadow` | Popovers and cards (VS Code's hover widget shadow)        |

### Interaction and motion

| Token                | Value                                                              | Use                                     |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `--focus-ring`       | `1px solid --color-focus`                                          | `outline` of every `:focus-visible`     |
| `--hover-outline`    | `1px dashed --vscode-contrastActiveBorder` (transparent elsewhere) | Hover outline of rows (high contrast)   |
| `--opacity-disabled` | 0.4                                                                | Disabled and held controls (as VS Code) |
| `--divider`          | `1px solid --color-border`                                         | Rules between sections                  |
| `--duration-landing` | 1.2s                                                               | The pulse on what an operation moved    |

### Colors

| Token                        | VS Code variable                                                            | Use                                                             |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `--color-fg`                 | `--vscode-foreground`                                                       | Text                                                            |
| `--color-muted`              | `--vscode-descriptionForeground`                                            | Secondary text, notes, empty states                             |
| `--color-disabled`           | `--vscode-disabledForeground`                                               | Disabled links, hidden refs                                     |
| `--color-icon`               | `--vscode-icon-foreground`, else foreground                                 | Icon buttons, chevrons                                          |
| `--color-border`             | `--vscode-widget-border`, else foreground at 16%                            | Dividers, segmented controls                                    |
| `--color-ruler`              | `--vscode-editorRuler-foreground`, else muted                               | A column guide in a multi-line field                            |
| `--color-focus`              | `--vscode-focusBorder`                                                      | Focus ring, accents, progress bars                              |
| `--color-hover`              | `--vscode-list-hoverBackground` (`--surface-sunken-hover` in details)       | Hovered rows                                                    |
| `--color-toolbar-hover`      | `--vscode-toolbar-hoverBackground`                                          | Hovered buttons                                                 |
| `--color-selection-inactive` | `--vscode-list-inactiveSelectionBackground`                                 | Selected row (list not focused), path filter files              |
| `--color-danger`             | `--vscode-errorForeground`                                                  | Errors                                                          |
| `--color-warning`            | `--vscode-list-warningForeground`, else `--vscode-editorWarning-foreground` | Warnings, autostash, conflicted files                           |
| `--color-git-modified`       | `--vscode-gitDecoration-modifiedResourceForeground`                         | Modified files; renamed and staged ones without their own color |
| `--badge-branch`             | `--vscode-scmGraph-historyItemRefColor`, else charts blue                   | Branch chips                                                    |
| `--badge-remote`             | `--vscode-scmGraph-historyItemRemoteRefColor`, else charts purple           | Remote chips                                                    |
| `--badge-tag`                | `--vscode-charts-yellow`                                                    | Tag chips                                                       |
| `--badge-stash`              | `--vscode-descriptionForeground`                                            | Stash chips                                                     |
| `--badge-head`               | `--vscode-scmGraph-historyItemRefColor`, else charts blue                   | HEAD chip, the head row's bar and tint                          |
| `--badge-worktree`           | `--vscode-charts-green`                                                     | Worktree chips and chip parts                                   |
| `--surface-sunken`           | editor background mixed with black (6%, 28% in dark, none in HC)            | The details pane                                                |
| `--surface-sunken-shadow`    | black at 28% (75% in dark)                                                  | The details pane's inset shadow                                 |
| `--surface-sunken-hover`     | list hover mixed with black (light), list hover (dark, HC)                  | Hovered rows on the sunken surface                              |

Other VS Code colors are read where they are used, not aliased: links (`--vscode-textLink-*`), the
focused selection, pressed buttons, progress bars, "Copied", and the git decoration colors of
added, deleted, renamed, staged, untracked and conflicted files.

The graph's lane colors are computed in `theme.ts`, not tokens.

## Components

States every interactive component has: default, hover (`body:not(.hover-off)`), active (pressed),
focus-visible (`--focus-ring`), disabled (`--opacity-disabled`), and the high contrast hover
outline. A tool button that toggles is `.active` when on; one that opens a popover has
`aria-expanded='true'` while it is open.

### Buttons

| Class             | Looks                                         | States beyond the common ones                                                       |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `.tool-button`    | Icon and `.tool-label`, no box until hovered  | `.active` (toggle on: input option colors), `[aria-expanded='true']` (popover open) |
| `.icon-button`    | 22×22, icon only                              | `.active` (toggle on: input option colors)                                          |
| `.inline-button`  | No box until hovered, inside a line of text   | `.inline-button.codicon`: a small icon (`--icon-size-sm`)                           |
| `.button`         | Push button, secondary colors                 | `[aria-disabled='true']` holds it while keeping focus                               |
| `.button.primary` | Push button, primary colors                   | Disabled or held: drops its fill                                                    |
| `.link-button`    | Link text; underlined in high contrast themes |                                                                                     |

Do: one `.primary` per group, first. Don't: give an icon-only button a label-less `.tool-button`,
or size a button by hand; every button is `--control-height` tall.

### Fields

`.field` is a text input: 22px, `--radius-sm`, input colors, the focus border on `:focus`.
`.field.multiline` is a `<textarea>` of fixed-width text in the commit body's font and line height
(`--font-mono`, `--font-size-sm`, `--line-height-prose`), as wide as its container, resized only
vertically.
`input.checkbox` is a 16px checkbox drawn in checkbox colors, with the focus ring.

### Lists

`.section-title` heads a group: caption size, strong, uppercase, muted. `.list-row` is a row:
22px minimum, icon, `.list-row-text` (takes the room, ellipsis), an optional `.list-row-note`
(muted, small, at most 45%), trailing `.icon-button`s. `.list-row.clickable` is itself the control
(a `<label>` around a checkbox, a `<button>`, a tree item): it shows the list hover. Rows on the
sunken surface get its hover color through `--color-hover`. The file tree indents rows by
`--tree-indent` per level; the repository switcher's two-line rows add `--space-2` above and below.

### Popover

`.popover` is a dialog under a toolbar button: 320px (`.popover.wide`: 420px), `--radius-lg`,
`--shadow`, `--space-4` inset. Parts, top to bottom:

- `.popover-header`: a `.field`, optionally a `.popover-label` above it and
  `.popover-header-actions` (a `.popover-summary` and buttons) below. A header with nothing shown
  takes no room.
- `.popover-actions`: link buttons.
- `.popover-list`: scrolls; holds `.section-title`, `.list-row` and `.popover-note`.
- `.popover-note`: muted text for "N more" and empty states.
- `.popover-section`: stays in view below the list, ruled off across the whole popover.

Text lines up at `--space-4 + --space-8` from the popover's edge in every part.

`.popover.bar` is a one-line popover (the find widget): a `.field` that takes the room, a
`.popover-summary` and `.icon-button`s side by side. `.popover-progress` (holding a
`.popover-progress-bar`) runs along any popover's bottom edge: its bar's width is the share done,
or `.indeterminate` runs without a known end (2s a run, still under reduced motion).

### Chip

`.chip` shows a ref, a stash or a short label: `--chip-height`, caption size, `--radius-md`.

| Variant                                              | Looks                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.chip-branch`, `-remote`, `-tag`, `-stash`, `-head` | Tinted with the kind's `--badge-*` color; head bolder                                                     |
| `.chip-worktree`                                     | Another worktree (`--badge-worktree`)                                                                     |
| `.chip-part` + a kind                                | A second name after a divider, in its kind's color; a `.badge` with one may grow to 320px                 |
| `.chip-stale` (on a chip or a part)                  | What it names is gone: its text struck through                                                            |
| `.chip-warning`                                      | `--color-warning` (with `.chip-outline`: a stopped operation)                                             |
| `.chip-stash.autostash`                              | Warning tint, full tone even in a quiet row                                                               |
| no kind                                              | Muted ("+N")                                                                                              |
| `.chip-outline` (with or without `.chip-warning`)    | A label: outline in the text color, no tint                                                               |
| `.badge`                                             | In a ref band: shrinks to its icon; a bubble (top-left round at half `--chip-height`, square bottom-left) |

Contents: an optional codicon (sized with the text), `.chip-text`. A context can quiet chips
without knowing their kind by setting `--chip-edge`, `--chip-tint` and `--chip-icon`; rows do this
until hovered or selected, except for HEAD and the current branch's upstream. Don't draw a ref any
other way.

### Card

`.card` shows information while the pointer rests: fixed, `--z-card`, hover widget colors,
`--radius-md`, `--shadow`, no pointer events. `.card-divider` rules it across. The ref card lists
refs as lines (icon, name, muted note) and where the commit is as a key column (`--font-size-sm`,
muted) and chips.

### Banner

`.banner` sits between the toolbar and the list: info colors, `.warning` for warning colors, an
icon centred on the first line of text (where a button's label would be), `.banner-text` (`.banner-lead` with `.link-button.banner-link` commits, `.banner-more`) and
`.banner-actions` of `.button`s, which wrap under the text when narrow. While an operation runs the
buttons are held (`aria-disabled`) and `.banner-busy` shows a spinner and the operation.

### Toolbar

The toolbar holds the repository, the status, then `.tool-button`s and `.icon-button`s. Its
contents fit its width, down to 420px with every filter on: when they do not, `toolbar-fit.ts`
shortens them in a fixed order until they do, each step a class on the toolbar that the later ones
keep:

| Step          | Drops                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `fit-status`  | The status text, unless busy or failed (which then shrinks with an ellipsis)  |
| `fit-stash`   | The stash label, for its count                                                |
| `fit-toggles` | The labels of HEAD, Badges (for its count) and First parent                   |
| `fit-path`    | Path chip text past 120px                                                     |
| `fit-filter`  | The ref filter's label; repository name past 120px                            |
| `fit-tight`   | Half the space between items; the path chip's text; repository name past 80px |

A control whose label can go keeps its name in its tooltip and accessible name. Find and Refresh are
icons at every width.

### Toolbar status

`.toolbar-status`: muted text; `.busy` (foreground, spinner before it) and `.error`
(`--color-danger`). The first toolbar step hides it unless busy or failed.

## Verifying

- `npm run check` runs the guard.
- `node scripts/playground-shot.mjs artifacts/gallery 1280x800 page=components` screenshots the
  gallery in all four themes (`index.html?page=components&theme=<theme>` in `npm run playground`).
  Hover, active and focus states are forced in the gallery by copying each rule that uses those
  pseudo-classes onto `.is-hover`, `.is-active`, `.is-focus-visible` and `.is-focus`.
- `npm run playground:shot` and `npm run shot` for the views themselves, as for any visual change.
