import type { Ref, RefSnapshot } from '../core/refs.ts';
import { el } from './format.ts';

const GROUPS: { kind: Ref['kind']; label: string; icon: string }[] = [
  { kind: 'branch', label: 'Branches', icon: 'git-branch' },
  { kind: 'remote', label: 'Remotes', icon: 'cloud' },
  { kind: 'tag', label: 'Tags', icon: 'tag' },
];
/** Rows rendered per group; the search box narrows larger sets. */
const MAX_PER_GROUP = 150;

/**
 * Toolbar button with a popover to pick the refs whose history is shown.
 * Calls `onChange` with full ref names, or null for "all".
 */
export class RefFilter {
  readonly button = el('button', 'tool-button ref-filter-button');
  private readonly label = el('span', 'tool-label');
  private readonly popover = el('div', 'popover');
  private readonly search = el('input', 'popover-search');
  private readonly list = el('div', 'popover-list');
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [] };
  private selected: Set<string> | null = null;
  private readonly onChange: (refs: string[] | null) => void;

  constructor(host: HTMLElement, onChange: (refs: string[] | null) => void) {
    this.onChange = onChange;
    this.button.append(
      el('span', 'codicon codicon-git-branch'),
      this.label,
      el('span', 'codicon codicon-chevron-down'),
    );
    this.button.title = 'Show history of selected branches and tags';
    this.button.setAttribute('aria-haspopup', 'dialog');
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
    const current = el('button', 'link-button popover-current', 'Current branch');
    current.addEventListener('click', () => {
      const head = this.refs.headBranch;
      if (head !== undefined) this.commit(new Set([`refs/heads/${head}`]));
    });
    const actions = el('div', 'popover-actions');
    actions.append(all, current);
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'Filter refs');
    this.popover.append(this.search, actions, this.list);
    this.popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
        this.button.focus();
      }
    });
    host.append(this.popover);
    document.addEventListener('pointerdown', (e) => {
      if (!this.popover.hidden && !this.popover.contains(e.target as Node) && !this.button.contains(e.target as Node))
        this.close();
    });
    this.updateLabel();
  }

  update(refs: RefSnapshot, selected: string[] | null): void {
    this.refs = refs;
    this.selected = selected ? new Set(selected) : null;
    this.updateLabel();
    if (!this.popover.hidden) this.renderList();
  }

  private toggle(): void {
    if (this.popover.hidden) {
      this.popover.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.renderList();
      this.search.focus();
    } else {
      this.close();
    }
  }

  private close(): void {
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  private commit(selected: Set<string> | null): void {
    this.selected = selected && selected.size > 0 ? selected : null;
    this.updateLabel();
    this.renderList();
    this.onChange(this.selected ? [...this.selected] : null);
  }

  private updateLabel(): void {
    const s = this.selected;
    if (!s) this.label.textContent = 'All';
    else if (s.size === 1) this.label.textContent = shortName([...s][0]!);
    else this.label.textContent = `${s.size} refs`;
    this.button.classList.toggle('active', s !== null);
  }

  private renderList(): void {
    const q = this.search.value.trim().toLowerCase();
    const items: HTMLElement[] = [];
    for (const g of GROUPS) {
      const refs = this.refs.refs
        .filter((r) => r.kind === g.kind && r.short.toLowerCase().includes(q))
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
  }

  private item(r: Ref, icon: string): HTMLElement {
    const label = el('label', 'popover-item');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.selected?.has(r.name) ?? false;
    box.dataset['ref'] = r.name;
    box.addEventListener('change', () => {
      const next = new Set(this.selected ?? []);
      if (box.checked) next.add(r.name);
      else next.delete(r.name);
      this.commit(next);
    });
    label.title = r.name;
    label.append(box, el('span', `codicon codicon-${icon}`), el('span', 'popover-item-text', r.short));
    return label;
  }
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}
