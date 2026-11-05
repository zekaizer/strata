import { addRule, isPattern, matcher, ruleCounts, type BadgeRule } from '../core/badge-rules.ts';
import type { Ref, RefSnapshot } from '../core/refs.ts';
import type { BadgeFilterProbe } from '../shared/protocol.ts';
import { codicon, el } from './format.ts';
import { dismissable, keepingFocus } from './popover.ts';

const GROUPS: { kind: Ref['kind']; label: string; icon: string; one: string; many: string }[] = [
  { kind: 'branch', label: 'Branches', icon: 'git-branch', one: 'branch', many: 'branches' },
  { kind: 'remote', label: 'Remotes', icon: 'cloud', one: 'remote branch', many: 'remote branches' },
  { kind: 'tag', label: 'Tags', icon: 'tag', one: 'tag', many: 'tags' },
];
/** Rows listed per group; the pattern narrows larger sets. */
const MAX_PER_GROUP = 150;

/** The badge rules, the refs they hide by full name with the rule hiding each, and whether those show anyway. */
export interface BadgeState {
  rules: readonly BadgeRule[];
  hidden: ReadonlyMap<string, BadgeRule>;
  showHidden: boolean;
}

export interface BadgeFilterEvents {
  /** The badge rules to keep instead of the current ones. */
  onRules(rules: BadgeRule[]): void;
  onShowHidden(show: boolean): void;
}

/**
 * Toolbar button with a popover to hide ref badges by name patterns: a pattern previews the refs
 * it matches and adds a rule hiding or showing them, the rules can be reordered and removed, and
 * each listed ref has an eye to hide or show just its badge.
 */
export class BadgeFilter {
  readonly button = el('button', 'tool-button badge-filter-button');
  private readonly label = el('span', 'tool-label');
  private readonly narrowCount = el('span', 'badge-count-narrow');
  private readonly popover = el('div', 'popover badge-popover');
  private readonly input = el('input', 'field badge-pattern');
  private readonly summary = el('div', 'popover-summary');
  private readonly hideButton = el('button', 'button primary badge-hide', 'Hide');
  private readonly showButton = el('button', 'button badge-show', 'Show');
  private readonly ruleList = el('div', 'popover-rules');
  private readonly refsHeading = el('div', 'section-title');
  private readonly list = el('div', 'popover-list badge-refs');
  /** Offered while badges are hidden, or shown for now. */
  private readonly showHidden = el('div', 'popover-section');
  private readonly showHiddenBox = el('input', 'checkbox');
  private readonly showHiddenLabel = el('span', 'list-row-text');
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [], remotes: [] };
  private state: BadgeState = { rules: [], hidden: new Map(), showHidden: false };
  private readonly events: BadgeFilterEvents;

  constructor(host: HTMLElement, events: BadgeFilterEvents) {
    this.events = events;
    this.button.append(codicon('eye-closed'), this.label, this.narrowCount);
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => {
      this.toggle();
    });

    const inputLabel = el('label', 'popover-label', 'Hide badges matching');
    inputLabel.htmlFor = 'badge-pattern';
    this.input.id = 'badge-pattern';
    this.input.type = 'search';
    this.input.placeholder = 'e.g. release/* or *-rc*';
    this.input.spellcheck = false;
    this.input.addEventListener('input', () => {
      this.render();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!this.hideButton.disabled) this.hideButton.click();
    });
    this.summary.id = 'badge-summary';
    this.summary.setAttribute('aria-live', 'polite');
    this.input.setAttribute('aria-describedby', 'badge-summary');
    this.hideButton.addEventListener('click', () => {
      this.addFromInput(false);
    });
    this.showButton.addEventListener('click', () => {
      this.addFromInput(true);
    });
    const actions = el('div', 'popover-header-actions');
    actions.append(this.summary, this.hideButton, this.showButton);
    const top = el('div', 'popover-header');
    top.append(inputLabel, this.input, actions);

    const rules = el('div', 'popover-section badge-rules');
    rules.append(el('div', 'section-title', 'Rules'), this.ruleList);

    this.showHiddenBox.type = 'checkbox';
    this.showHiddenBox.dataset['option'] = 'showHiddenBadges';
    this.showHiddenBox.addEventListener('change', () => {
      events.onShowHidden(this.showHiddenBox.checked);
    });
    const showHiddenItem = el('label', 'list-row clickable');
    showHiddenItem.append(this.showHiddenBox, codicon('eye'), this.showHiddenLabel);
    this.showHidden.append(showHiddenItem);

    const listed = el('div', 'popover-section badge-listed');
    listed.append(this.refsHeading, this.list);
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'Hidden badges');
    this.popover.append(top, rules, listed, this.showHidden);
    host.append(this.popover);
    dismissable(this.popover, this.button, () => {
      this.close();
    });
    this.updateButton();
  }

  /** The refs and what the rules make of them; the popover follows while open. */
  update(refs: RefSnapshot, state: BadgeState): void {
    this.refs = refs;
    this.state = state;
    this.updateButton();
    if (!this.popover.hidden)
      keepingFocus(this.popover, this.input, [this.list, this.ruleList], () => {
        this.render();
      });
  }

  /** Opens the popover with `pattern` typed, selected so typing replaces it. */
  openWith(pattern: string): void {
    if (this.popover.hidden) this.open();
    this.input.value = pattern;
    this.render();
    this.input.focus();
    this.input.select();
  }

  /** Closes the popover; a later open starts from an empty pattern. */
  close(): void {
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.input.value = '';
  }

  probe(): BadgeFilterProbe {
    const open = !this.popover.hidden;
    return {
      button: this.label.textContent,
      pattern: open ? this.input.value : undefined,
      summary: open ? this.summary.textContent : undefined,
      hide: open ? !this.hideButton.disabled : undefined,
      show: open ? !this.showButton.disabled : undefined,
      rules: open ? this.state.rules.map((r) => `${r.keep ? '!' : ''}${r.pattern}`) : undefined,
      refs: open
        ? [...this.list.querySelectorAll<HTMLElement>('.badge-ref')].map(
            (r) => `${r.dataset['short'] ?? ''}${r.classList.contains('badge-hidden') ? ' (hidden)' : ''}`,
          )
        : undefined,
      showHidden: open && !this.showHidden.hidden ? this.showHiddenLabel.textContent : undefined,
    };
  }

  private toggle(): void {
    if (this.popover.hidden) {
      this.open();
      this.input.focus();
    } else {
      this.close();
    }
  }

  private open(): void {
    this.popover.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.render();
  }

  private updateButton(): void {
    const { hidden, showHidden } = this.state;
    const n = showHidden ? 0 : hidden.size;
    this.label.textContent = n > 0 ? `${n} hidden` : 'Badges';
    this.narrowCount.textContent = n > 0 ? String(n) : '';
    this.button.title =
      n > 0 ? `${n} ${n === 1 ? 'badge' : 'badges'} hidden. Show or hide badges` : 'Hide badges by name';
    this.button.setAttribute('aria-label', n > 0 ? `Hidden badges: ${n}` : 'Hidden badges');
  }

  private addFromInput(keep: boolean): void {
    const pattern = this.input.value.trim();
    if (pattern === '') return;
    this.events.onRules(addRule(this.state.rules, { pattern, keep }));
    // The pressed button may turn disabled, which would drop focus to <body>.
    this.input.focus();
    this.input.select();
  }

  private render(): void {
    const pattern = this.input.value.trim();
    const test = pattern === '' ? undefined : matcher(pattern);
    const listed = this.refs.refs.filter((r) => (test ? test(r.short) : this.state.hidden.has(r.name)));
    this.renderSummary(pattern, listed);
    this.renderRules();
    this.refsHeading.textContent = test ? 'Matching refs' : 'Hidden badges';
    const items: HTMLElement[] = [];
    for (const g of GROUPS) {
      const refs = listed
        .filter((r) => r.kind === g.kind)
        .sort((a, b) => Number(this.isCurrent(b)) - Number(this.isCurrent(a)) || a.short.localeCompare(b.short));
      if (refs.length === 0) continue;
      items.push(el('div', 'section-title badge-kind', g.label));
      for (const r of refs.slice(0, MAX_PER_GROUP)) items.push(this.item(r, g.icon));
      if (refs.length > MAX_PER_GROUP)
        items.push(el('div', 'popover-note', `${refs.length - MAX_PER_GROUP} more; narrow the pattern`));
    }
    if (items.length === 0)
      items.push(el('div', 'popover-note', test ? 'No refs match' : 'No badges hidden. Type a pattern above.'));
    this.list.replaceChildren(...items);
    const n = this.state.hidden.size;
    const offered = n > 0 || this.state.showHidden;
    if (!offered && this.showHidden.contains(document.activeElement)) this.input.focus();
    this.showHidden.hidden = !offered;
    this.showHiddenBox.checked = this.state.showHidden;
    this.showHiddenLabel.textContent = `Show hidden badges (${n})`;
  }

  /** What the pattern matches, by kind, and whether Hide and Show would change anything. */
  private renderSummary(pattern: string, matched: readonly Ref[]): void {
    const changeable = pattern === '' ? [] : matched.filter((r) => !this.isCurrent(r));
    const hidden = changeable.filter((r) => this.state.hidden.has(r.name)).length;
    this.hideButton.disabled = changeable.length - hidden === 0;
    this.showButton.disabled = hidden === 0;
    this.hideButton.setAttribute('aria-label', `Hide ${changeable.length - hidden} badges matching ${pattern}`);
    this.showButton.setAttribute('aria-label', `Show ${hidden} hidden badges matching ${pattern}`);
    if (pattern === '') {
      this.summary.textContent = '';
      return;
    }
    if (matched.length === 0) {
      this.summary.textContent = isPattern(pattern) ? 'No refs match' : 'No ref has this name; add * to match more';
      return;
    }
    const kinds = GROUPS.flatMap((g) => {
      const n = matched.filter((r) => r.kind === g.kind).length;
      return n === 0 ? [] : [`${n} ${n === 1 ? g.one : g.many}`];
    });
    const notes = [
      ...(hidden > 0 ? [`${hidden} hidden`] : []),
      ...(changeable.length < matched.length ? ['the current branch stays shown'] : []),
    ];
    this.summary.textContent = `Matches ${kinds.join(', ')}${notes.map((t) => ` · ${t}`).join('')}`;
  }

  /** Each rule with the refs it decides, to reorder or remove. */
  private renderRules(): void {
    const { rules } = this.state;
    if (rules.length === 0) {
      this.ruleList.replaceChildren(
        el('div', 'popover-note', 'None yet. * matches any text, ? one character; later rules win.'),
      );
      return;
    }
    const counts = ruleCounts(rules, this.refs);
    this.ruleList.replaceChildren(
      ...rules.map((rule, i) => {
        const row = el('div', rule.keep ? 'list-row popover-rule keep' : 'list-row popover-rule');
        const icon = codicon(rule.keep ? 'eye' : 'eye-closed');
        const n = counts[i]!;
        const what = `${rule.keep ? 'Shows' : 'Hides'} ${n} ${n === 1 ? 'badge' : 'badges'}`;
        row.title = `${rule.pattern}: ${what.toLowerCase()}${rule.keep ? ' that rules above hide' : ''}`;
        const count = el('span', 'popover-rule-count', String(n));
        count.setAttribute('aria-label', what);
        const button = (action: string, codicon: string, label: string, disabled: boolean, next: () => BadgeRule[]) => {
          const b = el('button', `icon-button codicon codicon-${codicon}`);
          b.setAttribute('aria-label', label);
          b.title = label;
          b.disabled = disabled;
          b.dataset['focus'] = `rule:${rule.pattern}|${action}`;
          b.addEventListener('click', () => {
            this.events.onRules(next());
          });
          return b;
        };
        const moved = (to: number) => {
          const next = rules.filter((_, j) => j !== i);
          next.splice(to, 0, rule);
          return next;
        };
        row.append(
          icon,
          el('span', 'list-row-text popover-rule-pattern', rule.pattern),
          count,
          button('up', 'arrow-up', `Move ${rule.pattern} up`, i === 0, () => moved(i - 1)),
          button('down', 'arrow-down', `Move ${rule.pattern} down`, i === rules.length - 1, () => moved(i + 1)),
          button('remove', 'close', `Remove ${rule.pattern}`, false, () => rules.filter((_, j) => j !== i)),
        );
        return row;
      }),
    );
  }

  private isCurrent(r: Ref): boolean {
    return r.kind === 'branch' && r.short === this.refs.headBranch;
  }

  private item(r: Ref, icon: string): HTMLElement {
    const hiding = this.state.hidden.get(r.name);
    const row = el('div', hiding ? 'list-row badge-ref badge-hidden' : 'list-row badge-ref');
    row.dataset['short'] = r.short;
    row.title = hiding ? `${r.name}\nHidden by ${hiding.pattern}` : r.name;
    row.append(codicon(icon), el('span', 'list-row-text', r.short));
    if (hiding) row.append(el('span', 'list-row-note', `by ${hiding.pattern}`));
    if (this.isCurrent(r)) {
      row.append(el('span', 'list-row-note', 'current branch, always shown'));
      return row;
    }
    // The short name, which git keeps free of * and ?, matches exactly this ref's name.
    const eye = el('button', `icon-button badge-eye codicon codicon-${hiding ? 'eye-closed' : 'eye'}`);
    eye.setAttribute('aria-label', `Hide badge of ${r.short}`);
    eye.setAttribute('aria-pressed', String(hiding !== undefined));
    eye.title = hiding ? `Hidden by ${hiding.pattern}. Show this badge` : 'Hide this badge';
    eye.dataset['ref'] = r.name;
    eye.dataset['focus'] = `ref:${r.name}|eye`;
    eye.addEventListener('click', () => {
      this.events.onRules(addRule(this.state.rules, { pattern: r.short, keep: hiding !== undefined }));
    });
    row.append(eye);
    return row;
  }
}
