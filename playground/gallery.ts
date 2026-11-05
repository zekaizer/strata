// The design system's components in every state (docs/design-system.md), for review and screenshots:
// index.html?page=components&theme=<theme>. Hover, active and focus states are forced by copying each
// rule that uses those pseudo-classes onto .is-hover, .is-active and .is-focus-visible.
import { codicon, el } from '../src/webview/format.ts';

const FORCED: [RegExp, string][] = [
  [/:hover(?![\w-])/g, '.is-hover'],
  [/:active(?![\w-])/g, '.is-active'],
  [/:focus-visible(?![\w-])/g, '.is-focus-visible'],
  [/:focus(?![\w-])/g, '.is-focus'],
];
const STATEFUL = /:(hover|active|focus)/;

function forceStates(): void {
  const copies: string[] = [];
  for (const sheet of document.styleSheets)
    for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSStyleRule) || !STATEFUL.test(rule.selectorText)) continue;
      const selector = FORCED.reduce((s, [p, c]) => s.replace(p, c), rule.selectorText);
      copies.push(`${selector} { ${rule.style.cssText} }`);
    }
  const style = document.createElement('style');
  style.textContent = copies.join('\n');
  document.head.append(style);
}

/** The design tokens: every custom property tokens.css declares on :root. */
function tokens(): string[] {
  const names: string[] = [];
  for (const sheet of document.styleSheets)
    for (const rule of sheet.cssRules)
      if (rule instanceof CSSStyleRule && rule.selectorText === ':root')
        for (const name of rule.style) if (name.startsWith('--') && !names.includes(name)) names.push(name);
  return names;
}

const GALLERY_CSS = `
html, body { height: auto; overflow: auto; }
#app { display: block; height: auto; padding: 16px 24px 32px; }
.g-section { margin: 0 0 24px; }
.g-section > h2 { margin: 0 0 8px; font-size: 1.1em; font-weight: 600; border-bottom: 1px solid var(--color-border); padding-bottom: 4px; }
.g-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px 24px; margin: 0 0 12px; }
.g-spec { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.g-cap { color: var(--color-muted); font-size: var(--font-size-xs); }
.g-swatch { width: 40px; height: 24px; border: 1px solid var(--color-border); }
.g-token { display: grid; grid-template-columns: 44px 220px 1fr; align-items: center; gap: 8px; font-size: var(--font-size-sm); }
.g-token code { font-family: var(--font-mono); }
.g-tokens { display: grid; grid-template-columns: repeat(auto-fill, minmax(560px, 1fr)); gap: 4px 24px; }
.g-static { position: relative !important; inset: auto !important; display: flex; }
.g-box { width: 64px; height: 40px; background: var(--vscode-editorWidget-background); border: 1px solid var(--color-border); }
`;

const section = (title: string, ...rows: HTMLElement[]) => {
  const s = el('section', 'g-section');
  s.append(el('h2', undefined, title), ...rows);
  return s;
};
const row = (...specs: HTMLElement[]) => {
  const r = el('div', 'g-row');
  r.append(...specs);
  return r;
};
const spec = (caption: string, ...content: Node[]) => {
  const s = el('div', 'g-spec');
  s.append(el('span', 'g-cap', caption), ...content);
  return s;
};
const states = (caption: string, make: () => HTMLElement, list = ['default', 'hover', 'active', 'focus-visible']) =>
  list.map((state) => {
    const e = make();
    if (state === 'disabled') (e as HTMLButtonElement).disabled = true;
    else if (state !== 'default') e.classList.add(`is-${state}`);
    return spec(`${caption} ${state}`, e);
  });
const withClass = (e: HTMLElement, c: string) => {
  e.classList.add(c);
  return e;
};

function tokenSection(): HTMLElement {
  const style = getComputedStyle(document.documentElement);
  const list = el('div', 'g-tokens');
  for (const name of tokens()) {
    const value = style.getPropertyValue(name).trim();
    const sample = el('span');
    if (/^--(color|badge|surface|shadow-color)/.test(name)) {
      sample.className = 'g-swatch';
      sample.style.background = `var(${name})`;
    } else if (name.startsWith('--space-')) {
      sample.style.cssText = `display:block;height:8px;width:var(${name});background:var(--color-focus)`;
    } else if (name.startsWith('--radius')) {
      sample.className = 'g-swatch';
      sample.style.borderRadius = `var(${name})`;
    } else if (name.startsWith('--shadow-')) {
      sample.className = 'g-swatch';
      sample.style.boxShadow = `var(${name})`;
    } else if (name.startsWith('--font-size')) {
      sample.textContent = 'Ag';
      sample.style.fontSize = `var(${name})`;
    } else if (name.startsWith('--icon-size')) {
      sample.className = 'codicon codicon-git-branch';
      sample.style.fontSize = `var(${name})`;
    }
    const line = el('div', 'g-token');
    line.append(sample, el('code', undefined, name), el('code', 'g-cap', value));
    list.append(line);
  }
  return section('Tokens', list);
}

function buttons(): HTMLElement {
  const push = (primary: boolean) => () =>
    el('button', primary ? 'button primary' : 'button', primary ? 'Hide' : 'Show');
  const held = (primary: boolean) => {
    const b = push(primary)();
    b.setAttribute('aria-disabled', 'true');
    return spec(`${primary ? 'primary' : 'secondary'} aria-disabled`, b);
  };
  const tool = (label: string, icon: string) => () => {
    const b = el('button', 'tool-button');
    b.append(codicon(icon), el('span', 'tool-label', label));
    return b;
  };
  const toggled = (state: string) => {
    const b = tool('First parent', 'git-commit')();
    b.classList.add('active');
    if (state !== 'default') b.classList.add(`is-${state}`);
    return spec(`.active ${state}`, b);
  };
  const expanded = tool('All', 'git-branch')();
  expanded.append(codicon('chevron-down'));
  expanded.setAttribute('aria-expanded', 'true');
  const icon = () => el('button', 'icon-button codicon codicon-refresh');
  const link = () => el('button', 'link-button', 'Show all');
  const inline = () => {
    const b = el('button', 'inline-button byline-hash');
    b.append(el('span', 'hash-text', 'e93039b'), codicon('copy', 'hash-icon'));
    return b;
  };
  const inlineIcon = () => el('button', 'inline-button codicon codicon-copy');
  return section(
    'Buttons',
    row(...states('.button', push(false), ['default', 'hover', 'focus-visible', 'disabled']), held(false)),
    row(...states('.button.primary', push(true), ['default', 'hover', 'focus-visible', 'disabled']), held(true)),
    row(
      ...states('.tool-button', tool('First parent', 'git-commit'), ['default', 'hover', 'active', 'focus-visible']),
      spec('.tool-button disabled', withDisabled(tool('HEAD', 'target')())),
      spec('[aria-expanded=true]', expanded),
    ),
    row(...['default', 'hover', 'focus-visible'].map(toggled)),
    row(...states('.icon-button', icon, ['default', 'hover', 'active', 'focus-visible', 'disabled'])),
    row(
      ...states(
        '.icon-button.active',
        () => withClass(el('button', 'icon-button codicon codicon-list-unordered'), 'active'),
        ['default', 'hover', 'focus-visible'],
      ),
    ),
    row(...states('.link-button', link, ['default', 'hover', 'focus-visible', 'disabled'])),
    row(
      ...states('.inline-button', inline, ['default', 'hover', 'focus-visible']),
      ...states('.inline-button.codicon', inlineIcon, ['default', 'hover', 'focus-visible']),
    ),
  );
}

function withDisabled(b: HTMLButtonElement): HTMLButtonElement {
  b.disabled = true;
  return b;
}

function fields(): HTMLElement {
  const field = (value: string) => () => {
    const f = el('input', 'field');
    f.placeholder = 'e.g. release/* or *-rc*';
    f.value = value;
    return f;
  };
  const box = (checked: boolean) => () => {
    const b = el('input', 'checkbox');
    b.type = 'checkbox';
    b.checked = checked;
    return b;
  };
  return section(
    'Fields',
    row(...states('.field', field(''), ['default', 'focus']), spec('.field with text', field('cross/*')())),
    row(
      ...states('.checkbox', box(false), ['default', 'focus-visible']),
      ...states('.checkbox checked', box(true), ['default', 'focus-visible']),
    ),
  );
}

function popovers(): HTMLElement {
  const pop = (...parts: HTMLElement[]) => {
    const p = el('div', 'popover g-static');
    p.append(...parts);
    return p;
  };
  const search = el('div', 'popover-header');
  const searchField = el('input', 'field');
  searchField.placeholder = 'Filter refs';
  search.append(searchField);
  const actions = el('div', 'popover-actions');
  actions.append(el('button', 'link-button', 'Show all'), el('button', 'link-button', 'Current branch'));
  const option = (text: string, icon: string, state?: string, checked = false) => {
    const r = el('label', 'list-row clickable');
    const b = el('input', 'checkbox');
    b.type = 'checkbox';
    b.checked = checked;
    r.append(b, codicon(icon), el('span', 'list-row-text', text));
    if (state) r.classList.add(`is-${state}`);
    return r;
  };
  const list = el('div', 'popover-list');
  list.append(
    el('div', 'section-title', 'Branches'),
    option('main', 'git-branch', undefined, true),
    option('feature/search (hover)', 'git-branch', 'hover'),
    option('feature/a-very-long-branch-name-that-ends-in-an-ellipsis', 'git-branch'),
    el('div', 'popover-note', '150 more; type to narrow'),
  );
  const stash = el('div', 'popover-section');
  stash.append(el('div', 'section-title', 'Stashes'), option('Show stash rows (3)', 'git-stash'));

  const header = el('div', 'popover-header');
  const label = el('label', 'popover-label', 'Hide badges matching');
  const pattern = el('input', 'field is-focus');
  pattern.value = 'cross/*';
  const headerActions = el('div', 'popover-header-actions');
  headerActions.append(
    el('div', 'popover-summary', 'Matches 2 branches'),
    el('button', 'button primary', 'Hide'),
    withDisabled(el('button', 'button', 'Show')),
  );
  header.append(label, pattern, headerActions);
  const rule = (text: string, icon: string, n: string) => {
    const r = el('div', 'list-row');
    r.append(codicon(icon), el('span', 'list-row-text', text), el('span', 'list-row-note', n));
    r.append(withDisabled(el('button', 'icon-button codicon codicon-arrow-up')));
    r.append(el('button', 'icon-button codicon codicon-close'));
    return r;
  };
  const rules = el('div', 'popover-section');
  rules.append(el('div', 'section-title', 'Rules'), rule('cross/*', 'eye-closed', '2'), rule('cross/x', 'eye', '1'));
  const empty = el('div', 'popover-section');
  empty.append(el('div', 'section-title', 'Hidden badges'), el('div', 'popover-note', 'No badges hidden.'));

  const repo = el('button', 'list-row clickable repo-row is-focus-visible');
  const text = el('span', 'repo-row-text');
  text.append(el('span', 'repo-row-name', 'api-server'), el('span', 'repo-row-path', 'services/api-server'));
  repo.append(codicon('check'), text);
  const repos = el('div', 'popover-list');
  repos.append(repo, el('div', 'popover-note', 'No repository matches'));
  return section(
    'Popover',
    row(
      spec('search, actions, list, section', pop(search, actions, list, stash)),
      spec('header, rows with actions, empty state', pop(header, rules, empty)),
      spec('.popover.wide: button rows (focus-visible), note', withClass(pop(repos), 'wide')),
    ),
    row(...bars()),
  );
}

/** .popover.bar: the find widget's parts, at rest, failing and with progress. */
function bars(): HTMLElement[] {
  const bar = (value: string, summary: string, progress?: number, problem = false) => {
    const p = el('div', 'popover bar g-static');
    const field = el('input', 'field');
    field.value = value;
    const note = el('span', 'popover-summary', summary);
    if (problem) note.style.color = 'var(--color-danger)';
    const button = (icon: string, disabled = false) => {
      const b = el('button', `icon-button codicon codicon-${icon}`);
      b.disabled = disabled;
      return b;
    };
    p.append(field, note, button('arrow-up', problem), button('arrow-down', problem), button('close'));
    if (progress !== undefined) {
      const track = el('div', `popover-progress${Number.isNaN(progress) ? ' indeterminate' : ''}`);
      const fill = el('div', 'popover-progress-bar');
      if (!Number.isNaN(progress)) fill.style.width = `${progress * 100}%`;
      track.append(fill);
      p.append(track);
    }
    return p;
  };
  return [
    spec('.popover.bar', bar('b384', '3 of 21')),
    spec('.popover.bar, buttons disabled', bar('xyzzy', 'No results', undefined, true)),
    spec('.popover-progress (40%)', bar('login form', 'Going to 1 of 1…', 0.4)),
    spec('.popover-progress.indeterminate', bar('login form', 'Going to 1 of 1…', NaN)),
  ];
}

function chips(): HTMLElement {
  const chip = (kind: string, icon: string | undefined, text: string, extra = '') => {
    const c = el('span', `chip ${kind ? `chip-${kind}` : ''} ${extra}`.trim());
    if (icon) c.append(codicon(icon));
    c.append(el('span', 'chip-text', text));
    return c;
  };
  const kinds: [string, string, string][] = [
    ['head', 'target', 'HEAD'],
    ['branch', 'git-branch', 'main'],
    ['remote', 'cloud', 'origin/main'],
    ['tag', 'tag', 'v1.2.0'],
    ['stash', 'git-stash', 'stash@{0}'],
    ['worktree', 'worktree', 'review'],
  ];
  const inRow = (selected: boolean, hover: boolean, ...content: HTMLElement[]) => {
    const r = el('div', `row${selected ? ' selected' : ''}${hover ? ' is-hover' : ''} g-static`);
    r.style.cssText = 'height:auto;padding:4px 8px;gap:4px;display:flex;align-items:center';
    r.append(...content);
    return r;
  };
  /** A branch chip naming the worktree it is checked out in; `state`: '', 'locked' or 'chip-stale'. */
  const held = (state: string) => {
    const c = chip('branch', 'git-branch', 'feature/login', 'badge');
    const part = el('span', `chip-part chip-worktree ${state === 'chip-stale' ? state : ''}`.trim());
    part.append(codicon('worktree'), el('span', 'chip-text', 'strata-login'));
    if (state === 'locked') part.append(codicon('lock'));
    c.append(part);
    return c;
  };
  const autostash = () => {
    const c = chip('stash', 'git-stash', 'stash@{0}', 'autostash');
    c.append(el('span', 'badge-autostash', 'autostash'));
    return c;
  };
  return section(
    'Chips',
    row(...kinds.map(([k, i, t]) => spec(`.chip-${k}`, chip(k, i, t))), spec('neutral', chip('', undefined, '+3'))),
    row(
      ...kinds.map(([k, i, t]) => spec(`.chip-${k}.badge`, chip(k, i, t, 'badge'))),
      spec('.badge-more', chip('', undefined, '+3', 'badge badge-more')),
    ),
    row(
      spec('.chip-outline', chip('', undefined, 'Rebasing onto', 'chip-outline')),
      spec('.chip-outline.chip-warning', chip('warning', 'warning', 'Stopped here', 'chip-outline')),
      spec('.chip-stash.autostash', autostash()),
    ),
    row(
      spec('.chip-part.chip-worktree', held('')),
      spec('locked', held('locked')),
      spec('.chip-part.chip-stale', held('chip-stale')),
      spec('.chip-worktree.chip-stale.badge', chip('worktree', 'worktree', 'old-spike', 'badge chip-stale')),
      spec('quiet in a row', inRow(false, false, held('locked'))),
    ),
    row(
      spec('quiet in a row', inRow(false, false, ...kinds.map(([k, i, t]) => chip(k, i, t, 'badge')), autostash())),
      spec('row hovered', inRow(false, true, ...kinds.map(([k, i, t]) => chip(k, i, t, 'badge')), autostash())),
      spec('row selected', inRow(true, false, ...kinds.map(([k, i, t]) => chip(k, i, t, 'badge')), autostash())),
    ),
  );
}

function surfaces(): HTMLElement {
  const card = el('div', 'card g-static');
  const line = (look: string, icon: string, text: string, note?: string) => {
    const l = el('div', `ref-card-line ref-card-${look}`);
    l.append(codicon(icon), el('span', 'ref-card-text', text));
    if (note) l.append(el('span', 'ref-card-note', note));
    return l;
  };
  const where = el('div', 'ref-card-where');
  const value = el('span', 'ref-card-value');
  const plain = el('span', 'chip chip-tag');
  plain.append(codicon('tag'), el('span', 'chip-text', 'v1.2.0'));
  value.append(plain);
  where.append(el('span', 'ref-card-key', 'First in'), value);
  card.append(
    line('head', 'target', 'main', 'current branch'),
    line('remote', 'cloud', 'origin/main'),
    el('div', 'card-divider'),
    where,
  );

  const banner = (warning: boolean, busy: boolean, text: string) => {
    const b = el('section', `banner${warning ? ' warning' : ''}`);
    const t = el('span', 'banner-text');
    const lead = el('span', 'banner-lead', text);
    lead.append(el('button', 'link-button banner-link', 'e93039b'));
    t.append(lead, el('span', 'banner-more', 'Resolve the conflicts, then continue.'));
    const actions = el('span', 'banner-actions');
    if (busy) actions.append(el('span', 'banner-busy', 'Continuing rebase…'));
    for (const [i, label] of ['Continue', 'Skip…', 'Abort…'].entries()) {
      const btn = el('button', i === 0 ? 'button primary' : 'button', label);
      if (busy) btn.setAttribute('aria-disabled', 'true');
      actions.append(btn);
    }
    b.append(codicon(warning ? 'warning' : 'info', 'banner-icon'), t, actions);
    return b;
  };
  const wide = (e: HTMLElement) => {
    e.style.width = '900px';
    return e;
  };
  const status = (cls: string, text: string) => el('span', `toolbar-status ${cls}`.trim(), text);
  return section(
    'Surfaces',
    row(spec('.card (ref card)', card)),
    row(spec('.banner', wide(banner(false, false, 'Rebasing feature/search onto main: 2 of 4, stopped at ')))),
    row(spec('.banner.warning', wide(banner(true, false, 'Conflicts in 2 files after applying ')))),
    row(spec('.banner held (busy)', wide(banner(false, true, 'Conflicts resolved at ')))),
    row(
      spec('.toolbar-status', status('', '22 commits')),
      spec('.toolbar-status.busy', status('busy', 'Fetching…')),
      spec('.toolbar-status.error', status('error', 'git log failed')),
    ),
  );
}

export function renderGallery(app: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = GALLERY_CSS;
  document.head.append(style);
  app.append(tokenSection(), buttons(), fields(), popovers(), chips(), surfaces());
  forceStates();
  document.documentElement.dataset['galleryReady'] = '1';
}
