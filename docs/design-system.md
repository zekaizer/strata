# Strata design system

> English copy of the [Strata design system artifact](https://claude.ai/artifact/AKgFR4o6MTFjcrnQKGsVGK), the
> single source of truth, as of its change at 2026-11-11T06:13:21Z. Do not change this file on its own: change the
> artifact, then bring this copy in line. Component previews and `components/bundle.css` live in the artifact.

Strata is a git commit graph inside VS Code. It lives in the workbench, so its whole visual language is VS Code's. It
has no brand palette of its own and must read as part of the editor in every color theme.

## Content fundamentals

UI text is English and written like VS Code: short, plain, exact. Say what happened and what to do next. No exclamation
marks, no emoji, no marketing words.

- **Commands, buttons and links are title case.** Commands sit under the `Strata` category ("Strata: Show Commit
  Graph", "Fetch From All Remotes"); short prepositions (in, for, to, into, onto) stay lowercase.
- **Other labels are sentence case**, a word or two: "First parent", "Hide badges matching", "Show stash rows (3)".
  Git's names keep their case: HEAD, `origin/main`, `stash@{0}`.
- **An ellipsis means the command asks for more before it acts**: "Create Branch...", "Skip…", "Abort…". None on a
  command that runs at once ("Checkout", "Push").
- **Status is a fact**: "22 commits", "Fetching…", "git log failed", "150 more; type to narrow".
- **A banner says where you are, then what to do**: "Rebasing feature/search onto main: 2 of 4, stopped at e93039b" →
  "Resolve the conflicts, then continue." Its buttons are verbs: Continue, Skip…, Abort….
- Address the user only with imperatives ("type to narrow"); never "we", never "please". Use git's terms exactly; a ref
  on a row is a _badge_.

## Color

Every color is a VS Code theme variable or derived from one. Never pick a hex: use a token, and where there is none,
read the VS Code variable directly as the components do, `var(--vscode-…, fallback)`. Each component's guide lists the
variables it reads directly; `components/bundle.css` declares their values per theme.

- **Text**: `color-fg`; secondary text and empty states `color-muted`; disabled `color-disabled`. Icons `color-icon`.
- **State**: errors `color-danger`; warnings, autostash and conflicts `color-warning`. Never color alone: always with a
  word or an icon.
- **Interaction**: hovered rows `color-hover`, hovered buttons `color-toolbar-hover`, the selection of an unfocused list
  `color-selection-inactive`, keyboard focus and accents `color-focus`.
- **Refs**: the `badge-*` family (branch, remote, tag, stash, head, worktree) is drawn only through **Chip**.
- **Files**: `color-git-modified` is the "modified" color Source Control uses. Always beside the letter or number it
  colors.
- **Surfaces**: the page is `--vscode-editor-background`. The commit details sit one layer down on `surface-sunken`,
  with `surface-sunken-shadow` for its shadow and `surface-sunken-hover` for its hover. Popovers and cards take VS
  Code's quick input and hover widget backgrounds.
- The graph's lane colors are computed from the theme at run time; they are not tokens.
- VS Code colors used in one place are read directly, with no alias: links (`--vscode-textLink-*`), the focused
  selection, pressed buttons, progress bars, find matches, "Copied", and the git decoration colors of added, deleted,
  renamed, staged, untracked and conflicted files.

The themes are VS Code's four defaults: Dark Modern (the default), Light Modern, Dark High Contrast, Light High
Contrast.

## Typography

One family, VS Code's workbench font (`font-sans`), in three sizes only: `font-size` (VS Code's setting, 13px by
default), `font-size-sm` (1px smaller), `font-size-xs` (2px smaller). Names that lead take `font-weight-strong` (600).
Hashes, patterns and commit bodies take the editor font, `font-mono`. Single-line text takes `line-height` (18px),
commit bodies `line-height-prose` (1.5). No display type.

## Space and size

A 4px grid with a 2px half step (`space-2` … `space-24`). `0` and `1px` (hairlines) are the only lengths allowed
without a token. Icon to text is `space-4` (`space-2` inside a chip), row padding `space-8`, panel edges `space-16`.

Density follows VS Code: every button, field and list row is `control-height` (22px); chips are `chip-height` (14px).

**Spacing does not change with state.** The gap after a block belongs to that block, the same whatever follows it, and
sits outside anything that folds. A block that takes another's place (the message editor for the subject) keeps that
block's gaps.

## Corners, dividers, elevation

- Corners: `radius-sm` (2px) for what VS Code draws square (push buttons, fields), `radius-md` (4px) for everything
  hoverable or boxed, `radius-lg` (6px) for popovers. The one round corner is a ref badge's: only its top-left, at half
  `chip-height`, so it reads as a bubble pointing down at its commit.
- Dividers are `--divider` (1px of `color-border`).
- One elevation, `shadow`, on popovers and cards only. `z-card` stacks above `z-popover`. No gradients.

## States

Every interactive component has default, hover, pressed, focus-visible and disabled states. A component's guide states
only where it departs from these rules.

- Hover applies only while the pointer is really over the webview (only under `body:not(.hover-off)`).
- Keyboard focus is `--focus-ring` (1px solid `color-focus`): inside rows and toolbar buttons, outside push buttons and
  links.
- Disabled controls fade to `opacity-disabled` (0.4). A control that must keep focus while an operation runs is held
  with `aria-disabled="true"` instead of `disabled`.
- A toggle that is on is `.active` (input option colors); a button whose popover is open has `aria-expanded="true"`.
- High contrast themes show outlines instead of fills: dashed on hover (`--hover-outline`, on buttons
  `--vscode-toolbar-hoverOutline`), solid for focus, dotted for an unfocused selection; links are always underlined.

## Motion

What an operation moved pulses for `--duration-landing` (1.2s). The spinner (a turn every 1.5s) and an indeterminate
progress bar (a run every 2s) write their durations where they are used. Every animation stops under VS Code's reduced
motion setting and `prefers-reduced-motion`.

## Iconography

- Every UI icon is a **codicon**: `icon-size` (16px) beside body text, `icon-size-sm` (12px) beside secondary text. Use
  VS Code's own glyph for each idea: `git-branch`, `cloud` (remote), `tag`, `git-stash`, `target` (HEAD), `git-commit`,
  `refresh`, `copy`, `eye` / `eye-closed`, `warning`, `info`, `loading`.
- **An icon centres on the capitals of the text beside it.** A line box's centre depends on the font's ascent and
  descent, so text beside an icon has its box trimmed to cap height and baseline (`text-box: trim-both cap alphabetic`)
  and padded back out to its line height: a component that centres the icon on the text's box then centres it on the
  capitals in any font. An icon inside a line of text reaches the same centre through `vertical-align`. The rule leads
  `components/bundle.css`; no component nudges by pixels. Text beside an icon takes no vertical padding of its own.
- The **Strata glyph** `strata-graph` (Icons) means only "the Strata commit graph": the status bar, commands, the
  graph's editor tab.
- The **extension icon** `icon.png` (Logos) is for the Marketplace and the README only. Never recolor or redraw it; on
  VS Code surfaces use the glyph.
- No emoji, no illustrations.

## Components

Compose new UI from the components; never restyle a component from a view. Same role, same component; when no variant
fits, add one to the component.

| You need                                    | Use                                              |
| ------------------------------------------- | ------------------------------------------------ |
| A toolbar command with a label              | **ToolButton**                                   |
| An icon-only command                        | **IconButton**                                   |
| An icon or hash inside a line of text       | **InlineButton**                                 |
| A confirming action in a popover or banner  | **Button**                                       |
| Navigation inside text                      | **LinkButton**                                   |
| Text input, one line or several             | **Field**                                        |
| A checkbox                                  | **Checkbox** (inside `label.list-row.clickable`) |
| A dialog the toolbar opens, the find bar    | **Popover**                                      |
| A heading over a group of rows              | **SectionTitle**                                 |
| A row in any list                           | **ListRow**                                      |
| A ref, a stash, a worktree, a short label   | **Chip**                                         |
| Information while the pointer rests         | **Card**                                         |
| An operation's state with actions           | **Banner**                                       |
| Status, spinner or error in the toolbar     | **ToolbarStatus**                                |
| Muted explanation, empty and loading states | `color-muted` text (`.popover-note` in popovers) |

Components are CSS classes, not scripts. Load `components/bundle.css`, and the codicon stylesheet
(`@vscode/codicons` 0.0.46-24) for icons. bundle.css holds the four composite tokens tokens.json cannot: `--focus-ring`,
`--hover-outline`, `--divider`, `--duration-landing`.

**A new token or component lands in this order**: the token or component in this design system (with previews in every
state and its guide) → `tokens.css` and `components.css` in the code → a specimen in the playground gallery → the
feature that uses it.

**A token exists only when it earns its place**: it is read in two or more places, is a step of a scale, or holds a
decision beyond a VS Code variable (a derived value, a raw fallback, a theme-specific value). No single-use alias of a
VS Code variable.

### Toolbar

The toolbar holds the repository, the status, then **ToolButton**s and **IconButton**s. With every filter on it fits
down to 420px; when it does not, it shortens its contents in this order, each step a class on the toolbar that the
later steps keep. Find and Refresh are icons at every width.

| Step          | Drops                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `fit-status`  | The status text, unless busy or failed (which then shrinks with an ellipsis)  |
| `fit-stash`   | The stash label, for its count                                                |
| `fit-toggles` | The labels of HEAD, Badges (for its count) and First parent                   |
| `fit-path`    | Path chip text past 120px                                                     |
| `fit-filter`  | The ref filter's label; the repository name past 120px                        |
| `fit-tight`   | Half the space between items; the path chip's text; repository name past 80px |

## Source and implementation

This design system is the source of Strata's design. The zekaizer/strata repository keeps an English copy of it in
`docs/design-system.md` and implements it in `src/webview/tokens.css` and `components.css`; where they differ, the
design system is right. Color values are VS Code's default themes resolved from their captures; each token's usage note
names the VS Code variable it comes from. Not covered here:

- How the graph's lane colors are computed (`theme.ts`)
- The view layouts (commit row, ref band, details pane, file tree, message editor)

`row-height`, `ref-band`, `col-gap` and `tree-indent` are tokens those views use. The gallery screenshots in the
Screenshots group are from `70fc8ca8`; the component previews show the current look.

## Tokens

### Color

Strata's own color tokens. Each maps to one VS Code theme variable or is derived from one; the values are that variable resolved in VS Code's default themes as captured in playground/themes. VS Code colors a component reads directly are not tokens: each component's guide lists them.

| Token                      | Dark Modern | Light Modern | Dark High Contrast | Light High Contrast | Use                                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------- | ------------ | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color-fg`                 | `#cccccc`   | `#3b3b3b`    | `#ffffff`          | `#292929`           | Text, on the editor background, popovers, `color-hover` and `color-selection-inactive`. VS Code `--vscode-foreground`.                                                                                                                                                                            |
| `color-muted`              | `#9d9d9d`   | `#3b3b3b`    | `#ffffffb2`        | `#292929b2`         | Secondary text, notes, empty states, section titles, chips with no kind; on the editor background and popovers. VS Code `--vscode-descriptionForeground`.                                                                                                                                         |
| `color-disabled`           | `#cccccc80` | `#61616180`  | `#a5a5a5`          | `#7f7f7f`           | Disabled links, hidden refs. Disabled text: no contrast floor. VS Code `--vscode-disabledForeground`.                                                                                                                                                                                             |
| `color-icon`               | `#cccccc`   | `#3b3b3b`    | `#ffffff`          | `#292929`           | Icon buttons, chevrons; on the editor background and popovers. VS Code `--vscode-icon-foreground` (else `--vscode-foreground`).                                                                                                                                                                   |
| `color-border`             | `#313131`   | `#e5e5e5`    | `#6fc3df`          | `#0f4a85`           | Dividers (`--divider`), segmented controls. VS Code `--vscode-widget-border` (else foreground at 16%).                                                                                                                                                                                            |
| `color-focus`              | `#0078d4`   | `#005fb8`    | `#f38518`          | `#006bbd`           | The focus ring (`--focus-ring`), a focused field's border, accents; progress bars where the theme sets no `--vscode-progressBar-background`. At least 3:1 on the editor background in every theme. VS Code `--vscode-focusBorder`.                                                                |
| `color-ruler`              | `#5a5a5a`   | `#d3d3d3`    | `#ffffff`          | `#292929`           | A column guide in a multi-line field (the message editor's rule at column 72). A 1px line: no contrast floor. VS Code `--vscode-editorRuler-foreground` (else `color-muted`).                                                                                                                     |
| `color-hover`              | `#2a2d2e`   | `#f2f2f2`    | `#ffffff1a`        | `#0f4a851a`         | Hovered rows (`.list-row.clickable`); `surface-sunken-hover` takes its place in the details pane. VS Code `--vscode-list-hoverBackground`.                                                                                                                                                        |
| `color-toolbar-hover`      | `#5a5d5e4f` | `#b8b8b84f`  | `#00000000`        | `#00000000`         | Hovered tool, icon and inline buttons; pressed ones where the theme sets no `--vscode-toolbar-activeBackground`. Unset, so transparent, in both high contrast themes. VS Code `--vscode-toolbar-hoverBackground`.                                                                                 |
| `color-selection-inactive` | `#37373d`   | `#e4e6f1`    | `#00000000`        | `#0f4a851a`         | The selected row while the list has no focus; files the path filter matches. Unset, so transparent, in Dark High Contrast. VS Code `--vscode-list-inactiveSelectionBackground`.                                                                                                                   |
| `color-danger`             | `#f85149`   | `#f85149`    | `#f48771`          | `#b5200d`           | Errors (`.toolbar-status.error`, a find query that matches nothing), on the editor background. 3.4:1 in Light Modern, below the floor: VS Code's own value, kept exact. VS Code `--vscode-errorForeground`.                                                                                       |
| `color-warning`            | `#cca700`   | `#855f00`    | `#ffd370`          | `#895503`           | Warnings, autostash chips, conflicted files, `.chip-warning`; on the editor background. VS Code `--vscode-list-warningForeground` (else `--vscode-editorWarning-foreground`, as in both high contrast themes).                                                                                    |
| `color-git-modified`       | `#e2c08d`   | `#895503`    | `#e2c08d`          | `#895503`           | Modified files (status letters on `surface-sunken`), unstaged counts on the uncommitted changes row, the dot on HEAD while there are uncommitted changes; renamed and staged files where the theme gives them no color of their own. VS Code `--vscode-gitDecoration-modifiedResourceForeground`. |
| `badge-branch`             | `#59a4f9`   | `#0063d3`    | `#59a4f9`          | `#0063d3`           | Branch chips: border at full tone, fill at 16%. VS Code `--vscode-scmGraph-historyItemRefColor` (else `--vscode-charts-blue`).                                                                                                                                                                    |
| `badge-remote`             | `#b180d7`   | `#652d90`    | `#b180d7`          | `#652d90`           | Remote branch chips. VS Code `--vscode-scmGraph-historyItemRemoteRefColor` (else `--vscode-charts-purple`).                                                                                                                                                                                       |
| `badge-tag`                | `#cca700`   | `#bf8803`    | `#ffd370`          | `#895503`           | Tag chips. VS Code `--vscode-charts-yellow`.                                                                                                                                                                                                                                                      |
| `badge-stash`              | `#9d9d9d`   | `#3b3b3b`    | `#ffffffb2`        | `#292929b2`         | Stash chips. VS Code `--vscode-descriptionForeground`.                                                                                                                                                                                                                                            |
| `badge-head`               | `#59a4f9`   | `#0063d3`    | `#59a4f9`          | `#0063d3`           | The HEAD chip (fill at 30%, bold), the head row's bar and tint. The same variable as `badge-branch`, kept apart because a chip selects its color by kind. VS Code `--vscode-scmGraph-historyItemRefColor` (else `--vscode-charts-blue`).                                                          |
| `badge-worktree`           | `#89d185`   | `#388a34`    | `#89d185`          | `#374e06`           | Worktree chips (`.chip-worktree`) and chip parts naming the worktree a branch is checked out in. VS Code `--vscode-charts-green`.                                                                                                                                                                 |
| `surface-sunken`           | `#161616`   | `#f0f0f0`    | `#000000`          | `#ffffff`           | The commit details pane, one layer below the rows. The editor background mixed with black: 6% in Light, 28% in Dark, none in high contrast; e.g. `color-mix(in srgb, var(--vscode-editor-background) 72%, #000)` (Dark).                                                                          |
| `surface-sunken-shadow`    | `#000000bf` | `#00000047`  | `#00000047`        | `#00000047`         | The inset shadow the rows cast onto the details pane. A fixed value with no VS Code variable: black at 75% (Dark), 28% elsewhere. High contrast themes draw a border instead.                                                                                                                     |
| `surface-sunken-hover`     | `#2a2d2e`   | `#e3e3e3`    | `#ffffff1a`        | `#0f4a851a`         | Hovered rows on `surface-sunken`. List hover mixed with 6% black in Light; plain list hover in Dark and high contrast. Read fewer than twice, kept as a theme-specific value.                                                                                                                     |

### Typography

| Family | Stack                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| `sans` | `-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif` |
| `mono` | `Menlo, Monaco, Consolas, "Droid Sans Mono", "Courier New", monospace`                                      |

#### Text (sans)

VS Code's workbench font (`--vscode-font-family`) at its font size (`--vscode-font-size`, 13px by default). Three sizes only: body, 1px smaller, 2px smaller.

| Style           | Size | Line height | Weight | Use                                                                                 |
| --------------- | ---- | ----------- | ------ | ----------------------------------------------------------------------------------- |
| `body`          | 13px | 18px        | 400    | Rows, controls, popovers, card, banner (`font-size`, `line-height`).                |
| `body-strong`   | 13px | 18px        | 600    | Names that lead: repository, current commit, popover labels (`font-weight-strong`). |
| `secondary`     | 12px | 18px        | 400    | Byline, metadata, notes, card keys (`font-size-sm`).                                |
| `caption`       | 11px | 12px        | 400    | Chips; the line height is `chip-height` less its 1px borders (`font-size-xs`).      |
| `section-title` | 11px |             | 600    | Group headings, set uppercase and muted (`.section-title`).                         |

#### Code (mono)

VS Code's editor font: `var(--vscode-editor-font-family, monospace)`.

| Style         | Size | Line height | Weight | Use                                                                                                          |
| ------------- | ---- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `hash`        | 12px |             | 400    | Commit hashes, hide patterns (`font-mono`, `font-size-sm`).                                                  |
| `commit-body` | 12px | 1.5         | 400    | Commit message bodies, written in a fixed-width editor so trailers and tables line up (`line-height-prose`). |

### Spacing

A 4px grid with a 2px half step. `0` and `1px` (hairlines) are the only lengths allowed without a token.

| Token         | Value  | Use                                                                                        |
| ------------- | ------ | ------------------------------------------------------------------------------------------ |
| `space-2`     | `2px`  | Half step: icon to text inside chips, tight vertical rhythm.                               |
| `space-4`     | `4px`  | Icon to text, adjacent buttons, control padding, popover inset.                            |
| `space-8`     | `8px`  | Between toolbar items, row padding, card padding.                                          |
| `space-12`    | `12px` | Between commit list columns, between link groups.                                          |
| `space-16`    | `16px` | Panel edges (toolbar, banner start, details files).                                        |
| `space-24`    | `24px` | Between details columns.                                                                   |
| `col-gap`     | `12px` | Between list columns; the details start at the same column. `var(--space-12)`. Views only. |
| `tree-indent` | `16px` | Per level of the file tree. Views only.                                                    |

### Radius

Nearly square, as VS Code. Only a ref badge's top-left corner is round (half `chip-height`), written where it is used.

| Token       | Value | Use                                                               |
| ----------- | ----- | ----------------------------------------------------------------- |
| `radius-sm` | `2px` | Push buttons, fields, the link focus ring.                        |
| `radius-md` | `4px` | Tool, icon and inline buttons, list rows, chips, checkbox, cards. |
| `radius-lg` | `6px` | Popovers.                                                         |

### Shadow

One elevation: VS Code's hover widget shadow.

| Token    | Value                                                                                                                                                          | Use                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `shadow` | Dark Modern: `0 2px 8px #0000005c`, Light Modern: `0 2px 8px #00000029`, Dark High Contrast: `0 2px 8px #0000004c`, Light High Contrast: `0 2px 8px #0000004c` | Popovers and cards. `0 2px 8px var(--vscode-widget-shadow, rgb(0 0 0 / 30%))`. |

### Type scale

The type scale the components read.

| Token                | Value  | Use                                                                        |
| -------------------- | ------ | -------------------------------------------------------------------------- |
| `font-size`          | `13px` | Body text. `var(--vscode-font-size)`: the user's setting, 13px by default. |
| `font-size-sm`       | `12px` | Secondary text. `font-size` − 1px.                                         |
| `font-size-xs`       | `11px` | Chips and section titles. `font-size` − 2px.                               |
| `font-weight-strong` | `600`  | Names that lead: repository, current commit, labels.                       |
| `line-height`        | `18px` | Single-line text in controls, cards, banners, headings.                    |
| `line-height-prose`  | `1.5`  | Commit message bodies.                                                     |

### Size

Every control is 22px tall, as VS Code's action items and list rows.

| Token            | Value  | Use                                                                 |
| ---------------- | ------ | ------------------------------------------------------------------- |
| `icon-size`      | `16px` | Codicons beside body text (the codicon default).                    |
| `icon-size-sm`   | `12px` | Codicons beside secondary text: copy, toggle, diff.                 |
| `control-height` | `22px` | Every button, field and list row.                                   |
| `chip-height`    | `14px` | Every chip; fits the ref band.                                      |
| `toolbar-height` | `32px` | The toolbar; popovers open at its height.                           |
| `row-height`     | `24px` | A commit row's line (`ROW_HEIGHT` in graph.ts). Views only.         |
| `ref-band`       | `14px` | The band above a row with refs (`REF_BAND` in main.ts). Views only. |

### Layers

Rows and the graph canvas stack in document order, below these.

| Token       | Value | Use                             |
| ----------- | ----- | ------------------------------- |
| `z-popover` | `10`  | Popovers.                       |
| `z-card`    | `20`  | The hover card, above popovers. |

### Opacity

| Token              | Value | Use                                     |
| ------------------ | ----- | --------------------------------------- |
| `opacity-disabled` | `0.4` | Disabled and held controls, as VS Code. |

## Component guides

### Banner

An operation's state and its actions, between the toolbar and the list: `.banner`, `.banner.warning`.

#### When to use

A rebase, merge or cherry pick in progress or stopped at conflicts. The sentence says where; the buttons offer Continue,
Skip… and Abort….

Also while Strata cannot change the repository at all (git older than 2.34): `.banner.warning`. Nothing in Strata
resolves this state, so it has no `.banner-actions`. `.banner-lead` says why and `.banner-more` says what follows from
it. There is one banner slot. In this state every button of an operation banner is dead, so the read-only banner takes
the place of the operation banner.

#### What the consumer provides

- A `banner-icon` codicon: `info`, or `warning` with `.warning`.
- `.banner-text`: `.banner-lead` (commit hashes as `.link-button.banner-link`) and `.banner-more`.
- `.banner-actions`: `.button`s, the first `.primary`. A banner with nothing to resolve has none.

While the operation runs, hold the buttons with `aria-disabled="true"` and add a `.banner-busy` naming the operation;
it shows a spinner.

#### Look

`space-4` above and below, `space-8` at the end, `space-16` at the start, `line-height`. The icon is centred on the
first line of text; the buttons sit on that line when they fit beside it and wrap under the text when narrow.

Colors: `--vscode-inputValidation-info*` (background, text, bottom rule) and `--vscode-notificationsInfoIcon-foreground`;
`.warning` takes each one's warning pair. High contrast adds a `--vscode-contrastBorder` rule above and below.

### Button

A push button for a confirming action in a popover or banner: `.button` (secondary) and `.button.primary` (the action
a group leads with).

#### When to use

Confirming actions in a popover header or a banner (Hide, Show, Continue, Skip…, Abort…). In the toolbar use
**ToolButton**; for an icon alone, **IconButton**; for navigation inside text, **LinkButton**.

#### What the consumer provides

A `<button class="button">` with a short label. Add `primary` to the one action the group leads with, and put it first.
A label that asks for more input ends in an ellipsis ("Skip…").

#### Look

`control-height` tall, `space-8` side padding, `radius-sm`. Colors: `--vscode-button-secondary*` (secondary) and
`--vscode-button-*` (primary), each with its hover background. The focus ring sits `space-2` outside.

A disabled or held primary drops its fill and takes the secondary colors: faded, it would still stand out.

### Card

Information shown while the pointer rests: `.card`, such as the ref card on a commit's node.

#### When to use

Read-only detail on pointer rest. A card takes no pointer events, so it holds no controls; anything actionable goes in
a popover or a context menu.

#### What the consumer provides

The card's lines and, between groups, a `.card-divider` ruled across the whole card. The ref card lists refs as lines
(icon, name, muted note) and where the commit is as a key column (`font-size-sm`, `color-muted`) and chips.

#### Look

`position: fixed`, `z-card` (above popovers), at most 360px wide, `space-4` × `space-8` padding, `radius-md`, `shadow`.
Colors: `--vscode-editorHoverWidget-*` (background, text, border). The preview lays it out in flow.

### Checkbox

A 16px checkbox in VS Code's checkbox colors: `input.checkbox`.

#### When to use

Choices in a popover list (which branches to show, show stash rows). Always inside a `label.list-row.clickable`, so the
whole row toggles it.

#### What the consumer provides

`<label class="list-row clickable"><input class="checkbox" type="checkbox"> icon <span class="list-row-text">Label</span></label>`

#### Look

An `icon-size` square, `radius-md`, in `--vscode-checkbox-*` (background, border, check). The focus ring sits 1px
outside.

#### Contrast

The default border is below 3:1 on the editor background in Dark Modern and Light Modern. VS Code's value, kept exact;
the label row carries the affordance.

### Chip

A ref, a stash or a short label: `.chip`. A ref is always drawn as a chip.

#### When to use

Every ref (branch, remote, tag, HEAD), every stash, and short status labels ("Rebasing onto", "Stopped here").

#### What the consumer provides

`<span class="chip chip-<kind>">` holding an optional codicon (sized with the text) and `<span class="chip-text">`.

| Variant                                                          | Meaning                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip-branch`, `-remote`, `-tag`, `-stash`, `-head`, `-worktree` | The ref's kind, in its `badge-*` color; head stronger and bold                                                                                        |
| `chip-warning`                                                   | `color-warning`; with `.chip-outline`, a stopped operation                                                                                            |
| no kind                                                          | A muted chip ("+3")                                                                                                                                   |
| `chip-stash.autostash`                                           | An autostash left behind: the warning color, at full tone even in a quiet row                                                                         |
| `.chip-outline`                                                  | A label: an outline in the text color, no fill                                                                                                        |
| `.badge`                                                         | In a row's ref band: shrinks down to its icon; a bubble, round only at its top-left                                                                   |
| `.chip-part.chip-<kind>`                                         | A second name after a divider (the worktree a branch is checked out in, with `lock` when locked); gives way first; a `.badge` with one grows to 320px |
| `.chip-stale`                                                    | What it names is gone (a worktree whose folder was deleted): its text struck through, on a chip or a part                                             |

A context can quiet chips without knowing their kind through `--chip-edge`, `--chip-tint` and `--chip-icon`
(percentages of the kind's color). Rows set 45%, 7% and 60% until hovered or selected, except for HEAD and the current
branch's upstream.

#### Look

`chip-height`, `font-size-xs`, `space-4` side padding, `space-2` icon gap, `radius-md`. Border at the kind's color,
fill at 16% (HEAD: 30% and bold). A part's divider is its kind's color at 60% (`--vscode-contrastBorder` in high
contrast). Text stays `color-fg`.

### Field

A text input: `.field` for one line, `.field.multiline` for several.

#### When to use

Every text input in the webview (a popover's filter, a hide pattern, the find query). `.field.multiline` where several
lines are needed, such as a commit message being edited.

#### What the consumer provides

- `<input class="field">` with a placeholder that shows the expected form ("e.g. release/* or _-rc_"). Its container
  sets its width.
- `<textarea class="field multiline" rows="…">`: set as commit bodies are (`font-mono`, `font-size-sm`,
  `line-height-prose`), as wide as its container, wrapping long lines, resized only vertically.

#### Look

`control-height`, `space-4` side padding, `radius-sm`, in `--vscode-input-*` (background, text, border, placeholder).
On focus the border turns `color-focus`; there is no ring.

#### Contrast

The default border is below 3:1 in Dark Modern and Light Modern. VS Code's value, kept exact; the fill carries the
edge.

### IconButton

An icon-only command, 22×22: `.icon-button`.

#### When to use

Icon commands in the toolbar (refresh), row actions, and trailing actions on a list row (move up, remove).

#### What the consumer provides

`<button class="icon-button codicon codicon-<name>" aria-label="…">`. The `aria-label` is required: there is no
visible text. A toggle carries `.active` while on (the find widget's match list).

#### Look

A `control-height` square, `color-icon`, `radius-md`, nothing drawn until hovered. Hover `color-toolbar-hover`, pressed
`--vscode-toolbar-activeBackground`, the focus ring 1px inside. `.active` takes `--vscode-inputOption-active*`, moves
the focus ring 1px outside and does not darken when pressed.

### InlineButton

A button inside a line of text, such as a commit hash that copies itself: `.inline-button`, or `.inline-button.codicon`
for a small icon.

#### When to use

An icon or hash that acts inside a byline or a note (copy a hash, toggle, open a diff). It keeps the surrounding text's
font and color.

#### What the consumer provides

`<button class="inline-button">` around the text, or `<button class="inline-button codicon codicon-copy" aria-label="…">`
for an icon, shown at `icon-size-sm` in `color-icon` with `space-2` side padding.

#### Look

No box until hovered; on hover `color-toolbar-hover`, `radius-md`.

### LinkButton

Link text that acts as a button, for navigation inside text: `.link-button`.

#### When to use

Commit links in a banner, "Show All" and "Current Branch" in a popover's actions, web addresses in the body of a commit
message. A confirming action is a **Button**.

#### What the consumer provides

A `<button class="link-button">` with the link text. In a banner add `banner-link` to set a hash in `font-mono` at
`font-size-sm`.

A link in running text that has to wrap with the text around it (a web address in a commit message) is a
`<span class="link-button" role="link" tabindex="0">`: a `<button>` is one box, so a long address would move to the next
line whole. Enter and a click open it.

#### Look

`--vscode-textLink-foreground`; on hover `--vscode-textLink-activeForeground` and underlined; disabled `color-disabled`,
no underline. High contrast themes always underline it, so it reads as a link by more than its color. The focus ring
sits 1px outside, `radius-sm`.

### ListRow

A row in any list (popover, file tree): `.list-row`.

#### When to use

Every row of a list. `.list-row.clickable` when the row itself is the control (a `<label>` around a checkbox, a
`<button>`, a tree item).

#### What the consumer provides

An icon, `<span class="list-row-text">` (takes the room, ellipsis), an optional `<span class="list-row-note">` (muted,
`font-size-sm`, at most 45%), then any `.icon-button`s. Two-line rows add `space-2` above and below.

#### Look

`control-height` minimum, `space-8` side padding, `space-4` gaps, `radius-md`. A clickable row shows `color-hover` on
hover; on `surface-sunken`, `surface-sunken-hover` takes its place through `color-hover`.

### Popover

A dialog under a toolbar button: `.popover` and its parts.

#### When to use

Anything the toolbar opens (the branch filter, hidden badges, the repository switcher). 320px wide, `.popover.wide`
420px. The find widget is a `.popover.bar`.

#### What the consumer provides

Parts, top to bottom, each optional:

- `.popover-header`: a `.field`, optionally a `.popover-label` above it and `.popover-header-actions` (a
  `.popover-summary` and buttons) below. A header with nothing shown takes no room.
- `.popover-actions`: link buttons.
- `.popover-list`: scrolls; holds `.section-title`, `.list-row` and `.popover-note`.
- `.popover-note`: muted text for "N more" and empty states ("No badges hidden.").
- `.popover-section`: stays in view below the list, ruled off by a `--divider` across the whole popover.

Text in every part lines up at `space-4` + `space-8` from the popover's edge.

`.popover.bar` is a one-line popover over the list: a `.field` that takes the room (200px, down to 60px), a
`.popover-summary` that ends in an ellipsis, and `.icon-button`s, `space-2` apart. Disable the arrows while there is
nothing to go to and say why in the summary (`color-danger` when the query matches nothing).

`.popover-progress` (holding a `.popover-progress-bar`) runs along the popover's bottom edge: the bar's width is the
share done, or `.indeterminate` while the end is unknown; `hidden` removes it.

#### Look

`radius-lg`, `shadow`, `space-4` inset, `z-popover`. Colors `--vscode-quickInput-*`, border `--vscode-widget-border`.
Placed under the toolbar (`toolbar-height` − `space-2`), `space-8` from the right; the preview lays it out in flow.

### SectionTitle

The heading over a group of rows: `.section-title`.

#### When to use

Every group heading in a list (Branches, Remotes, Tags, Stashes, Rules, Hidden badges).

#### What the consumer provides

`<div class="section-title">Branches</div>`, written in title case; the component sets it uppercase. In a popover it
takes `space-8` above and at the sides and `space-2` below.

#### Look

`font-size-xs`, `font-weight-strong`, uppercase, `color-muted`.

### ToolButton

A toolbar command with an icon and a label that draws no box until hovered: `.tool-button` with a `.tool-label`.

#### When to use

A toolbar command that needs a word (HEAD, All, Badges, First parent). Never a `.tool-button` without a label: an
icon-only command is an **IconButton**.

#### What the consumer provides

`<button class="tool-button">` holding a codicon and `<span class="tool-label">` (ellipsis past 200px). A button that
opens a popover ends in `chevron-down` and has `aria-expanded="true"` while it is open; a toggle carries `.active` while
on.

Labels drop in a fixed order as the toolbar narrows; a button whose label can go keeps its name in its tooltip and
accessible name.

#### Look

`control-height` tall, `space-4` padding and icon gap, `radius-md`. Hover `color-toolbar-hover`; pressed or popover
open `--vscode-toolbar-activeBackground`. `.active` takes `--vscode-inputOption-active*`, with the focus ring 1px
outside so it does not land on that border.

### ToolbarStatus

A transient status in the toolbar (what the view shows, a running operation, an error): `.toolbar-status`.

#### When to use

The commit count, "Fetching…" while an operation runs, "git log failed" after one fails. The first to go when the
toolbar narrows, unless busy or failed: then it shrinks with an ellipsis.

#### What the consumer provides

`<span class="toolbar-status">` with a few words; add `busy` while an operation runs (a spinner comes before it) or
`error` when it failed.

#### Look

`color-muted`, with an ellipsis. `.busy` is `color-fg` after a spinner that adds no height to the line; `.error` is
`color-danger`.

#### Contrast

`color-danger` is 3.4:1 on the editor background in Light Modern, below 4.5:1. VS Code's value, kept exact.

## Assets

### Logos

- `icon.png`: the extension icon, 256×256, for the Marketplace listing and the README. Full color on its own slate
  tile; used as is, never recolored.
- `icon.svg`: the source of `icon.png` (128×128 viewBox): five offset rounded bars in yellow `#CCA700`, orange
  `#D18616`, purple `#B180D7`, blue `#3794FF` and teal `#4EC9B0` on slate `#1b2230`, joined by a white lane with five
  commit nodes.
- `strata-mono.svg`: the monochrome design of the product glyph, 16×16, in `currentColor` with the bars at 45% opacity.
  Through `<img>` its ink is black; inline it to take the text color. Icon fonts cannot carry its translucent bars: on
  VS Code surfaces use `strata-graph` (Icons).

### Icons

Strata's own icons; every other icon is a codicon (`@vscode/codicons`).

- `strata-graph.svg`: the product glyph's source, one filled path at 16×16. No fill set: black through `<img>`. The
  source of the icon font.
- `strata-icons.woff`: the product icon font VS Code loads; `strata-graph` at U+F101, used as `$(strata-graph)` in the
  status bar ("Graph") and on commands.
- `strata-graph-light.svg`: the glyph in `#424242`, the graph's editor tab icon in light themes.
- `strata-graph-dark.svg`: the glyph in `#C5C5C5`, the editor tab icon in dark themes.

### Screenshots

- `screenshot.png`: the hero, 1440×864. The commit graph in Dark Modern: branch lanes with badges, a selected merge
  commit with its message and changed files unfolded.
- `gallery-dark.png`, `gallery-light.png`, `gallery-high-contrast.png`, `gallery-high-contrast-light.png`: the
  playground's design system gallery (`index.html?page=components`), one per theme. From `70fc8ca8`, before later
  spacing fixes; the component previews show the current look.
