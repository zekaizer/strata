import type { RepoItem } from '../shared/protocol.ts';
import { el } from './format.ts';
import { dismissable } from './popover.ts';

/** Above this many repositories the popover has a search box. */
const SEARCH_FROM = 8;

export interface RepoSwitcherEvents {
  /** The popover opened: the list it shows should be brought up to date. */
  onOpen(): void;
  onChoose(root: string): void;
}

/**
 * The repository name at the start of the toolbar. With several repositories open it is a button
 * with a popover listing them, which shows another one.
 */
export class RepoSwitcher {
  /** The name of the repository shown, while it is the only one. */
  readonly label = el('span', 'repo');
  readonly button = el('button', 'tool-button repo-button');
  private readonly buttonText = el('span', 'tool-label repo');
  private readonly popover = el('div', 'popover repo-popover');
  private readonly search = el('input', 'popover-search');
  private readonly list = el('div', 'popover-list');
  private repos: RepoItem[] = [];
  private shown: string | undefined;
  private readonly events: RepoSwitcherEvents;

  constructor(host: HTMLElement, events: RepoSwitcherEvents) {
    this.events = events;
    this.button.append(this.buttonText, el('span', 'codicon codicon-chevron-down'));
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.hidden = true;
    this.button.addEventListener('click', () => {
      this.toggle();
    });
    this.search.type = 'search';
    this.search.placeholder = 'Filter repositories';
    this.search.setAttribute('aria-label', 'Filter repositories');
    this.search.addEventListener('input', () => {
      this.renderList();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.rows()[0]?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.rows()[0]?.click();
      }
    });
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Repositories');
    this.list.addEventListener('keydown', (e) => {
      this.onListKey(e);
    });
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'Show repository');
    this.popover.append(this.search, this.list);
    host.append(this.popover);
    dismissable(this.popover, this.button, () => {
      this.close();
    });
  }

  /** The repository shown: its name and root, or none with `text` in its place. */
  setShown(repo: { name: string; root: string } | undefined, text = ''): void {
    this.shown = repo?.root;
    this.label.textContent = repo?.name ?? text;
    this.label.title = repo?.root ?? '';
    this.buttonText.textContent = repo?.name ?? text;
    this.button.title = repo ? `${repo.root}: show another repository` : '';
    this.update(this.repos);
  }

  update(repos: RepoItem[]): void {
    this.repos = repos;
    const several = repos.length > 1 && this.shown !== undefined;
    this.button.hidden = !several;
    this.label.hidden = several;
    if (!several && !this.popover.hidden) this.close();
    if (!this.popover.hidden) this.renderList();
  }

  /** What the toolbar shows, for integration tests. */
  probe(): { button: boolean; text: string; rows: string[] | undefined; search: boolean } {
    return {
      button: !this.button.hidden,
      text: (this.button.hidden ? this.label : this.buttonText).textContent,
      rows: this.popover.hidden
        ? undefined
        : this.rows().map((r) =>
            [...r.querySelectorAll('.repo-row-name, .repo-row-path, .repo-row-branch')]
              .map((e) => e.textContent)
              .concat(r.getAttribute('aria-selected') === 'true' ? ['shown'] : [])
              .join(' | '),
          ),
      search: !this.popover.hidden && !this.search.hidden,
    };
  }

  private toggle(): void {
    if (!this.popover.hidden) {
      this.close();
      return;
    }
    this.popover.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.search.hidden = this.repos.length < SEARCH_FROM;
    this.renderList();
    if (this.search.hidden) (this.rows().find((r) => r.dataset['root'] === this.shown) ?? this.rows()[0])?.focus();
    else this.search.focus();
    this.events.onOpen();
  }

  close(): void {
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.search.value = '';
  }

  private rows(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>('.repo-row')];
  }

  private renderList(): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['root'] : undefined;
    const query = this.search.hidden ? '' : this.search.value.trim().toLowerCase();
    const matching = this.repos.filter(
      (r) => query === '' || r.name.toLowerCase().includes(query) || r.path.toLowerCase().includes(query),
    );
    this.list.replaceChildren(
      ...matching.map((r) => {
        const row = el('button', 'popover-item repo-row');
        row.dataset['root'] = r.root;
        row.setAttribute('role', 'option');
        const shown = r.root === this.shown;
        row.setAttribute('aria-selected', String(shown));
        row.title = r.root;
        const text = el('span', 'repo-row-text');
        text.append(el('span', 'repo-row-name', r.name));
        // A repository at the top of its workspace folder is where its name says.
        if (r.path !== r.name) text.append(el('span', 'repo-row-path', r.path));
        const head = el('span', 'repo-row-head');
        if (r.head !== undefined)
          head.append(el('span', 'codicon codicon-git-branch'), el('span', 'repo-row-branch', r.head));
        row.append(el('span', `codicon ${shown ? 'codicon-check' : 'codicon-blank'}`), text, head);
        row.addEventListener('click', () => {
          this.close();
          this.button.focus();
          if (!shown) this.events.onChoose(r.root);
        });
        return row;
      }),
    );
    if (matching.length === 0) this.list.append(el('div', 'popover-more', 'No repository matches'));
    if (focused !== undefined)
      this.rows()
        .find((r) => r.dataset['root'] === focused)
        ?.focus();
  }

  private onListKey(e: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = rows[Math.min(at + 1, rows.length - 1)];
    else if (e.key === 'ArrowUp') {
      if (at <= 0 && !this.search.hidden) {
        e.preventDefault();
        this.search.focus();
        return;
      }
      next = rows[Math.max(at - 1, 0)];
    } else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') next = rows.at(-1);
    if (!next) return;
    e.preventDefault();
    next.focus();
  }
}
