import type { Ref, RefSnapshot } from '../core/refs.ts';
import { codicon, el } from './format.ts';
import { dismissable, keepingFocus, placeUnder } from './popover.ts';

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
}

/** Toolbar button with a popover to pick the refs whose history is shown. */
export class RefFilter {
  readonly button = el('button', 'tool-button ref-filter-button');
  private readonly label = el('span', 'tool-label');
  private readonly popover = el('div', 'popover');
  private readonly search = el('input', 'popover-search');
  private readonly list = el('div', 'popover-list');
  private readonly currentButton = el('button', 'link-button popover-current', 'Current branch');
  /** Shown when there are stashes: whether they are drawn as rows. */
  private readonly stashes = el('div', 'popover-section popover-stashes');
  private readonly stashBox = el('input');
  private readonly stashLabel = el('span', 'popover-item-text');
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [], remotes: [] };
  private selected: Set<string> | null = null;
  private readonly events: RefFilterEvents;

  constructor(host: HTMLElement, events: RefFilterEvents) {
    this.events = events;
    this.button.append(codicon('git-branch'), this.label, codicon('chevron-down'));
    this.button.title = 'Show history of selected branches and tags';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => {
      this.toggle();
    });
    this.search.type = 'search';
    this.search.placeholder = 'Filter refs';
    this.search.setAttribute('aria-label', 'Filter refs');
    this.search.addEventListener('input', () => {
      this.renderList();
    });
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
    this.stashBox.type = 'checkbox';
    this.stashBox.dataset['option'] = 'stashes';
    this.stashBox.addEventListener('change', () => {
      events.onShowStashes(this.stashBox.checked);
    });
    const stashItem = el('label', 'popover-item');
    stashItem.append(this.stashBox, codicon('git-stash'), this.stashLabel);
    this.stashes.append(el('div', 'popover-group', 'Stashes'), stashItem);
    this.stashes.hidden = true;
    this.popover.append(this.search, actions, this.list, this.stashes);
    host.append(this.popover);
    dismissable(this.popover, this.button, () => {
      this.close();
    });
    window.addEventListener('resize', () => {
      if (!this.popover.hidden) placeUnder(this.popover, this.button);
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
      keepingFocus(this.popover, this.search, [this.list], () => {
        this.renderList();
      });
    else
      for (const box of this.list.querySelectorAll<HTMLInputElement>('input[data-ref]')) {
        box.checked = this.selected?.has(box.dataset['ref'] ?? '') ?? false;
      }
  }

  /** `count` stashes, drawn as rows when `shown`. */
  updateStashes(count: number, shown: boolean): void {
    this.stashes.hidden = count === 0;
    this.stashBox.checked = shown;
    this.stashLabel.textContent = `Show stash rows (${count})`;
  }

  private toggle(): void {
    if (this.popover.hidden) {
      this.popover.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.renderList();
      placeUnder(this.popover, this.button);
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

  private updateLabel(): void {
    const s = this.selected;
    if (!s) this.label.textContent = 'All';
    else if (s.size === 1) this.label.textContent = shortName([...s][0]!);
    else this.label.textContent = `${s.size} refs`;
    this.button.setAttribute('aria-label', `Filter refs: ${this.label.textContent}`);
    this.button.classList.toggle('active', s !== null);
  }

  private renderList(): void {
    const q = this.search.value.trim().toLowerCase();
    const matches = (r: Ref) => r.short.toLowerCase().includes(q);
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
        items.push(el('div', 'popover-more', `${refs.length - MAX_PER_GROUP} more; type to narrow`));
    }
    if (items.length === 0) items.push(el('div', 'popover-more', 'No refs match'));
    this.list.replaceChildren(...items);
  }

  private item(r: Ref, icon: string): HTMLElement {
    const label = el('label', 'popover-item');
    label.title = r.name;
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
    label.append(box, codicon(icon), el('span', 'popover-item-text', r.short));
    return label;
  }
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}
