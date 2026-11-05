import { addRule, isPattern, matcher, ruleCounts, type BadgeRule } from '../core/badge-rules.ts';
import type { Ref, RefSnapshot } from '../core/refs.ts';
import { el } from './format.ts';

const GROUPS: { kind: Ref['kind']; label: string; icon: string }[] = [
  { kind: 'branch', label: 'Branches', icon: 'git-branch' },
  { kind: 'remote', label: 'Remotes', icon: 'cloud' },
  { kind: 'tag', label: 'Tags', icon: 'tag' },
];
/** Rows rendered per group; the search box narrows larger sets. */
const MAX_PER_GROUP = 150;

export interface RefFilterEvents {
  /** Full ref names whose history to show, or null for all. */
  onRefs(refs: string[] | null): void;
  onShowStashes(show: boolean): void;
  /** The badge rules to keep instead of the current ones. */
  onBadgeRules(rules: BadgeRule[]): void;
  onShowHiddenBadges(show: boolean): void;
}

/** What the popover knows of the badge rules: the rules, the refs they hide, and whether those show anyway. */
interface BadgeState {
  rules: readonly BadgeRule[];
  hidden: ReadonlyMap<string, BadgeRule>;
  showHidden: boolean;
}

/**
 * Toolbar button with a popover to pick the refs whose history is shown, and to hide the badges
 * of refs by glob rules (a search like IR* previews the refs a rule would hide).
 */
export class RefFilter {
  readonly button = el('button', 'tool-button ref-filter-button');
  private readonly label = el('span', 'tool-label');
  private readonly hiddenLabel = el('span', 'tool-label ref-filter-hidden');
  private readonly popover = el('div', 'popover');
  private readonly search = el('input', 'popover-search');
  /** Under the search while it is a glob: add a rule hiding or showing the refs it matches. */
  private readonly patternActions = el('div', 'popover-actions popover-pattern');
  private readonly hideButton = el('button', 'link-button popover-hide');
  private readonly keepButton = el('button', 'link-button popover-keep');
  private readonly list = el('div', 'popover-list');
  private readonly currentButton = el('button', 'link-button popover-current', 'Current branch');
  /** Shown when there are badge rules: the rules in order, and whether their badges show anyway. */
  private readonly badges = el('div', 'popover-section popover-badges');
  private readonly ruleList = el('div', 'popover-rules');
  private readonly showHiddenBox = el('input');
  private readonly showHiddenLabel = el('span', 'popover-item-text');
  /** Shown when there are stashes: whether they are drawn as rows. */
  private readonly stashes = el('div', 'popover-section popover-stashes');
  private readonly stashBox = el('input');
  private readonly stashLabel = el('span', 'popover-item-text');
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [], remotes: [] };
  private selected: Set<string> | null = null;
  private badgeState: BadgeState = { rules: [], hidden: new Map(), showHidden: false };
  private readonly events: RefFilterEvents;

  constructor(host: HTMLElement, events: RefFilterEvents) {
    this.events = events;
    this.button.append(
      el('span', 'codicon codicon-git-branch'),
      this.label,
      this.hiddenLabel,
      el('span', 'codicon codicon-chevron-down'),
    );
    this.button.title = 'Show history of selected branches and tags';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => {
      this.toggle();
    });
    this.search.type = 'search';
    this.search.placeholder = 'Filter refs, or IR* to hide badges';
    this.search.setAttribute('aria-label', 'Filter refs, or type a pattern like IR* to hide badges');
    this.search.addEventListener('input', () => {
      this.renderList();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.patternActions.hidden && !this.hideButton.disabled) {
        e.preventDefault();
        this.hideButton.click();
      }
    });
    this.hideButton.addEventListener('click', () => {
      this.addRule({ pattern: this.pattern()!, keep: false });
    });
    this.keepButton.addEventListener('click', () => {
      this.addRule({ pattern: this.pattern()!, keep: true });
    });
    this.patternActions.append(this.hideButton, this.keepButton);
    this.patternActions.hidden = true;
    const all = el('button', 'link-button popover-all', 'Show all');
    all.addEventListener('click', () => {
      this.commit(null);
    });
    const current = this.currentButton;
    current.addEventListener('click', () => {
      const head = this.refs.headBranch;
      if (head !== undefined) this.commit(new Set([`refs/heads/${head}`]));
    });
    const actions = el('div', 'popover-actions');
    actions.append(all, current);
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'Filter refs');
    this.showHiddenBox.type = 'checkbox';
    this.showHiddenBox.dataset['option'] = 'showHiddenBadges';
    this.showHiddenBox.addEventListener('change', () => {
      events.onShowHiddenBadges(this.showHiddenBox.checked);
    });
    const showHiddenItem = el('label', 'popover-item');
    showHiddenItem.append(this.showHiddenBox, el('span', 'codicon codicon-eye'), this.showHiddenLabel);
    this.badges.append(el('div', 'popover-group', 'Hidden badges'), this.ruleList, showHiddenItem);
    this.badges.hidden = true;
    this.stashBox.type = 'checkbox';
    this.stashBox.dataset['option'] = 'stashes';
    this.stashBox.addEventListener('change', () => {
      events.onShowStashes(this.stashBox.checked);
    });
    const stashItem = el('label', 'popover-item');
    stashItem.append(this.stashBox, el('span', 'codicon codicon-git-stash'), this.stashLabel);
    this.stashes.append(el('div', 'popover-group', 'Stashes'), stashItem);
    this.stashes.hidden = true;
    this.popover.append(this.search, this.patternActions, actions, this.list, this.badges, this.stashes);
    host.append(this.popover);
    // Leaving the webview (focus to an editor) closes it, like a click outside.
    window.addEventListener('blur', () => {
      if (!this.popover.hidden) this.close();
    });
    // Tabbing out of the popover closes it, like a click outside.
    this.popover.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && !this.popover.contains(next) && !this.button.contains(next)) this.close();
    });
    // Escape closes the popover even when focus has left it.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.popover.hidden) {
        this.close();
        this.button.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.popover.hidden && !this.popover.contains(e.target as Node) && !this.button.contains(e.target as Node))
        this.close();
    });
    this.updateLabel();
  }

  update(refs: RefSnapshot, selected: string[] | null): void {
    const refsChanged = refs !== this.refs;
    this.refs = refs;
    this.selected = selected ? new Set(selected) : null;
    this.updateLabel();
    this.currentButton.disabled = refs.headBranch === undefined;
    this.currentButton.title = refs.headBranch === undefined ? 'HEAD is detached' : '';
    if (this.popover.hidden) return;
    if (refsChanged)
      this.keepingFocus(() => {
        this.renderList();
        this.renderRules();
      });
    else
      for (const box of this.list.querySelectorAll<HTMLInputElement>('input[data-ref]')) {
        box.checked = this.selected?.has(box.dataset['ref'] ?? '') ?? false;
      }
  }

  /** The badge rules, the refs of the last update() they hide, and whether those show anyway. */
  updateBadges(state: BadgeState): void {
    this.badgeState = state;
    this.updateLabel();
    if (!this.popover.hidden)
      this.keepingFocus(() => {
        this.renderList();
        this.renderRules();
      });
  }

  /** `count` stashes, drawn as rows when `shown`. */
  updateStashes(count: number, shown: boolean): void {
    this.stashes.hidden = count === 0;
    this.stashBox.checked = shown;
    this.stashLabel.textContent = `Show stash rows (${count})`;
  }

  /** Opens the popover searching for `text`, selected so typing replaces it. */
  openWith(text: string): void {
    if (this.popover.hidden) this.toggle();
    this.search.value = text;
    this.renderList();
    this.search.focus();
    this.search.select();
  }

  private toggle(): void {
    if (this.popover.hidden) {
      this.popover.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.renderList();
      this.renderRules();
      this.search.focus();
    } else {
      this.close();
    }
  }

  /** Closes the popover; a later open starts from an empty search, as after Escape. */
  close(): void {
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.search.value = '';
  }

  private commit(selected: Set<string> | null): void {
    this.selected = selected && selected.size > 0 ? selected : null;
    this.updateLabel();
    // Update checkboxes in place: rebuilding the list would drop keyboard focus to <body>.
    for (const box of this.list.querySelectorAll<HTMLInputElement>('input[data-ref]')) {
      box.checked = this.selected?.has(box.dataset['ref'] ?? '') ?? false;
    }
    this.events.onRefs(this.selected ? [...this.selected] : null);
  }

  private addRule(rule: BadgeRule): void {
    this.events.onBadgeRules(addRule(this.badgeState.rules, rule));
  }

  /**
   * Rebuilds parts of the popover, then puts focus back on the control that had it (by its
   * data-focus key): rebuilding would otherwise drop keyboard focus to <body>. A control gone or
   * disabled hands focus to its row's first usable one, else to the search box.
   */
  private keepingFocus(rebuild: () => void): void {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && this.popover.contains(active) ? active.dataset['focus'] : undefined;
    const scroll = [this.list.scrollTop, this.ruleList.scrollTop] as const;
    rebuild();
    [this.list.scrollTop, this.ruleList.scrollTop] = scroll;
    if (key === undefined) return;
    // Ref names may contain "|"; the control's part after the last one does not.
    const row = key.slice(0, key.lastIndexOf('|'));
    const usable = (e: HTMLElement | null) => (e && !(e as HTMLButtonElement).disabled ? e : null);
    const target =
      usable(this.popover.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)) ??
      [...this.popover.querySelectorAll<HTMLElement>(`[data-focus^="${CSS.escape(`${row}|`)}"]`)].find(
        (e) => usable(e) !== null,
      ) ??
      this.search;
    target.focus();
  }

  private updateLabel(): void {
    const s = this.selected;
    if (!s) this.label.textContent = 'All';
    else if (s.size === 1) this.label.textContent = shortName([...s][0]!);
    else this.label.textContent = `${s.size} refs`;
    this.button.classList.toggle('active', s !== null);
    const { hidden, showHidden } = this.badgeState;
    this.hiddenLabel.textContent = hidden.size > 0 && !showHidden ? `· ${hidden.size} hidden` : '';
    this.hiddenLabel.hidden = this.hiddenLabel.textContent === '';
  }

  /** The search text when it is a glob. */
  private pattern(): string | undefined {
    const q = this.search.value.trim();
    return isPattern(q) ? q : undefined;
  }

  private renderList(): void {
    const pattern = this.pattern();
    const q = this.search.value.trim().toLowerCase();
    const matches = pattern === undefined ? (r: Ref) => r.short.toLowerCase().includes(q) : globOf(pattern);
    const items: HTMLElement[] = [];
    for (const g of GROUPS) {
      const refs = this.refs.refs
        .filter((r) => r.kind === g.kind && matches(r))
        .sort(
          (a, b) =>
            Number(b.short === this.refs.headBranch) - Number(a.short === this.refs.headBranch) ||
            a.short.localeCompare(b.short),
        );
      if (refs.length === 0) continue;
      items.push(el('div', 'popover-group', g.label));
      for (const r of refs.slice(0, MAX_PER_GROUP)) items.push(this.item(r, g.icon));
      if (refs.length > MAX_PER_GROUP)
        items.push(el('div', 'popover-more', `${refs.length - MAX_PER_GROUP} more — type to narrow`));
    }
    if (items.length === 0) items.push(el('div', 'popover-more', 'No matching refs'));
    this.list.replaceChildren(...items);
    this.renderPatternActions(pattern === undefined ? [] : this.refs.refs.filter(matches), pattern !== undefined);
  }

  /** "Hide N badges" and "Show N again" for the refs a glob search matches, the current branch aside. */
  private renderPatternActions(matched: readonly Ref[], shown: boolean): void {
    this.patternActions.hidden = !shown;
    if (!shown) return;
    const changeable = matched.filter((r) => !this.isCurrent(r));
    const hidden = changeable.filter((r) => this.badgeState.hidden.has(r.name)).length;
    const hide = changeable.length - hidden;
    this.hideButton.textContent = hide === 0 ? 'No badges to hide' : `Hide ${hide} ${hide === 1 ? 'badge' : 'badges'}`;
    this.hideButton.disabled = hide === 0;
    this.hideButton.dataset['focus'] = 'pattern|hide';
    this.keepButton.textContent = `Show ${hidden} again`;
    this.keepButton.hidden = hidden === 0;
    this.keepButton.dataset['focus'] = 'pattern|keep';
  }

  /** The Hidden badges section: each rule with the refs it decides, to reorder or remove. */
  private renderRules(): void {
    const { rules, hidden, showHidden } = this.badgeState;
    this.badges.hidden = rules.length === 0;
    this.showHiddenBox.checked = showHidden;
    this.showHiddenLabel.textContent = `Show hidden badges (${hidden.size})`;
    const counts = ruleCounts(rules, this.refs);
    this.ruleList.replaceChildren(
      ...rules.map((rule, i) => {
        const row = el('div', rule.keep ? 'popover-rule keep' : 'popover-rule');
        const icon = el('span', `codicon codicon-${rule.keep ? 'eye' : 'eye-closed'}`);
        icon.setAttribute('aria-hidden', 'true');
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
            this.events.onBadgeRules(next());
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
          el('span', 'popover-item-text popover-rule-pattern', rule.pattern),
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
    const row = el('div', 'popover-row');
    const label = el('label', 'popover-item');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.selected?.has(r.name) ?? false;
    box.dataset['ref'] = r.name;
    box.dataset['focus'] = `ref:${r.name}|box`;
    box.addEventListener('change', () => {
      const next = new Set(this.selected ?? []);
      if (box.checked) next.add(r.name);
      else next.delete(r.name);
      this.commit(next);
    });
    const hiding = this.badgeState.hidden.get(r.name);
    label.title = hiding ? `${r.name}\nBadge hidden by ${hiding.pattern}` : r.name;
    label.append(box, el('span', `codicon codicon-${icon}`), el('span', 'popover-item-text', r.short));
    row.append(label);
    row.classList.toggle('badge-hidden', hiding !== undefined);
    if (this.isCurrent(r)) return row;
    // The short name, which git keeps free of * and ?, matches exactly this ref's name.
    const eye = el('button', `icon-button popover-eye codicon codicon-${hiding ? 'eye-closed' : 'eye'}`);
    eye.setAttribute('aria-label', `Hide badge of ${r.short}`);
    eye.setAttribute('aria-pressed', String(hiding !== undefined));
    eye.title = hiding ? `Badge hidden by ${hiding.pattern}. Show it` : 'Hide badge';
    eye.dataset['ref'] = r.name;
    eye.dataset['focus'] = `ref:${r.name}|eye`;
    eye.addEventListener('click', () => {
      this.addRule({ pattern: r.short, keep: hiding !== undefined });
    });
    row.append(eye);
    return row;
  }
}

function globOf(pattern: string): (r: Ref) => boolean {
  const test = matcher(pattern);
  return (r) => test(r.short);
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}
