import { isFolder, parentFolder, pathLabel, type PathFilter, type RepoPath } from '../core/path-filter.ts';
import { PATH_HISTORY } from '../core/wording.ts';
import { codicon, el } from './format.ts';
import { dismissable, placeUnder } from './popover.ts';

export interface PathChipEvents {
  /** Show All Files: the whole repository's history again. */
  onClear(): void;
  /** Show History of the parent folder. */
  onFolder(folder: RepoPath): void;
  onOpen(path: RepoPath): void;
  onCopy(path: RepoPath): void;
}

/**
 * The toolbar chip of a path history ("session.ts ×"): × shows every file again, the name opens a
 * popover with the full path, what was found and the ways on. Hidden without a path filter.
 */
export class PathChip {
  readonly element = el('span', 'tool-button active path-chip');
  private readonly main = el('button', 'inline-button path-chip-main');
  private readonly icon = codicon('file');
  private readonly label = el('span', 'tool-label');
  private readonly clear = el('button', 'inline-button codicon codicon-close path-chip-clear');
  private readonly popover = el('div', 'popover path-popover');
  private readonly head = el('div', 'popover-header');
  private readonly actions = el('div', 'popover-list');
  private readonly clearSection = el('div', 'popover-section');
  private filter: PathFilter | null = null;
  private summary = '';
  private readonly events: PathChipEvents;

  constructor(host: HTMLElement, events: PathChipEvents) {
    this.events = events;
    this.main.append(this.icon, this.label);
    this.main.setAttribute('aria-haspopup', 'dialog');
    this.main.setAttribute('aria-expanded', 'false');
    this.main.addEventListener('click', (e) => {
      // From the keyboard (detail 0) focus moves into the popover; a click leaves no ring behind.
      this.toggle(e.detail === 0);
    });
    this.clear.title = 'Show All Files';
    this.clear.setAttribute('aria-label', this.clear.title);
    this.clear.addEventListener('click', () => {
      this.close();
      events.onClear();
    });
    this.element.append(this.main, this.clear);
    this.element.hidden = true;
    this.popover.hidden = true;
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', 'File history');
    this.clearSection.append(
      this.item('close', 'Show All Files', () => {
        events.onClear();
      }),
    );
    this.popover.append(this.head, this.actions, this.clearSection);
    host.append(this.popover);
    dismissable(this.popover, this.main, () => {
      this.close();
    });
    window.addEventListener('resize', () => {
      if (!this.popover.hidden) placeUnder(this.popover, this.element);
    });
  }

  /** The filter shown, and what the history says about it so far ("8 commits change it."). */
  update(filter: PathFilter | null, summary: string): void {
    this.filter = filter;
    this.summary = summary;
    this.element.hidden = filter === null;
    if (filter === null) {
      this.close();
      return;
    }
    const first = filter.paths[0];
    this.icon.className = `codicon codicon-${isFolder(first) ? 'folder' : 'file'}`;
    this.label.textContent = pathLabel(filter);
    this.main.title = `History of ${filter.paths.join(', ')}`;
    this.main.setAttribute('aria-label', this.main.title);
    if (!this.popover.hidden) this.render();
  }

  private toggle(focus: boolean): void {
    if (this.popover.hidden) {
      this.popover.hidden = false;
      this.main.setAttribute('aria-expanded', 'true');
      this.render();
      placeUnder(this.popover, this.element);
      if (focus) this.actions.querySelector<HTMLElement>('button')?.focus();
    } else {
      this.close();
    }
  }

  close(): void {
    this.popover.hidden = true;
    this.main.setAttribute('aria-expanded', 'false');
  }

  private render(): void {
    const f = this.filter;
    if (!f) return;
    const [first, ...older] = f.paths;
    const lines: HTMLElement[] = [el('div', 'popover-label path-popover-path', first)];
    if (older.length > 0) lines.push(el('div', 'popover-summary', `and ${older.join(', ')}`));
    if (this.summary) lines.push(el('div', 'popover-summary', this.summary));
    this.head.replaceChildren(...lines);
    const items: HTMLElement[] = [];
    const folder = parentFolder(first);
    if (folder !== undefined)
      items.push(
        this.item('folder', PATH_HISTORY.folderHistory(folder), () => {
          this.events.onFolder(folder);
        }),
      );
    if (!isFolder(first))
      items.push(
        this.item('go-to-file', 'Open File', () => {
          this.events.onOpen(first);
        }),
      );
    items.push(
      this.item('copy', 'Copy Relative Path', () => {
        this.events.onCopy(first);
      }),
    );
    this.actions.replaceChildren(...items);
  }

  private item(icon: string, text: string, run: () => void): HTMLElement {
    const b = el('button', 'list-row clickable');
    b.append(codicon(icon), el('span', 'list-row-text', text));
    b.addEventListener('click', () => {
      this.close();
      run();
    });
    return b;
  }
}
