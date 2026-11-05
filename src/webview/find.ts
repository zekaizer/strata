import { el } from './format.ts';

/** Typing settles this long before the search runs. */
const DEBOUNCE_MS = 200;

export interface FindWidgetEvents {
  /** The input settled on `input` (debounced), or Enter asked for it at once. */
  onQuery(input: string): void;
  /** ↓ or Enter (↑ or Shift+Enter with `back`). */
  onStep(back: boolean): void;
  /** Escape: stops the jump in progress, if any; true when it did, and the widget stays open. */
  onStop(): boolean;
  onClose(): void;
  /** The match list was shown or hidden. */
  onList(shown: boolean): void;
}

/** What the count says, and how: an error look for no results and commits out of view. */
export interface FindCount {
  text: string;
  problem?: boolean;
}

/**
 * The find widget over the top right of the list: input, match count, previous and next, the
 * match list toggle, close, and a progress bar while the list loads up to a match; the match list
 * opens under it. It does not close on outside clicks.
 */
export class FindWidget {
  readonly element = el('div', 'find-widget');
  private readonly bar = el('div', 'popover bar');
  /** The match list's rows; the owner fills it while `listShown`. */
  readonly list = el('div', 'popover-list');
  private readonly listBox = el('div', 'popover wide find-list');
  private readonly toggle = el('button', 'icon-button find-toggle');
  readonly input = el('input', 'field find-input');
  private readonly count = el('span', 'popover-summary find-count');
  private readonly prev = el('button', 'icon-button find-prev');
  private readonly next = el('button', 'icon-button find-next');
  private readonly close = el('button', 'icon-button find-close');
  private readonly progress = el('div', 'popover-progress');
  private readonly fill = el('div', 'popover-progress-bar');
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The input the last onQuery reported. */
  private settled = '';
  private readonly events: FindWidgetEvents;

  constructor(events: FindWidgetEvents) {
    this.events = events;
    this.bar.setAttribute('role', 'search');
    this.bar.setAttribute('aria-label', 'Find commits');
    this.input.type = 'text';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.input.title = 'Message, hash or branch; author:name for an author';
    this.input.setAttribute('aria-label', 'Find commits by message, hash, branch or author:name');
    this.count.setAttribute('aria-live', 'polite');
    const button = (b: HTMLButtonElement, icon: string, title: string, run: () => void) => {
      b.classList.add('codicon', `codicon-${icon}`);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', run);
    };
    button(this.prev, 'arrow-up', 'Previous Match (Shift+Enter)', () => {
      this.step(true);
    });
    button(this.next, 'arrow-down', 'Next Match (Enter)', () => {
      this.step(false);
    });
    button(this.close, 'close', 'Close (Escape)', () => {
      this.events.onClose();
    });
    button(this.toggle, 'list-unordered', 'Show Matches as a List', () => {
      this.showList(!this.listShown);
    });
    this.toggle.setAttribute('aria-pressed', 'false');
    this.progress.append(this.fill);
    this.progress.hidden = true;
    this.bar.append(this.input, this.count, this.prev, this.next, this.toggle, this.close, this.progress);
    this.list.setAttribute('role', 'list');
    this.listBox.setAttribute('aria-label', 'Matches');
    this.listBox.hidden = true;
    this.listBox.append(this.list);
    this.element.hidden = true;
    this.element.append(this.bar, this.listBox);
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.settle();
      }, DEBOUNCE_MS);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this.events.onStop()) this.events.onClose();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  get value(): string {
    return this.input.value;
  }

  get listShown(): boolean {
    return this.toggle.classList.contains('active');
  }

  /** Shows or hides the match list; it shows only while it has rows. */
  showList(shown: boolean): void {
    this.toggle.classList.toggle('active', shown);
    this.toggle.setAttribute('aria-pressed', String(shown));
    this.events.onList(shown);
    this.syncList();
  }

  /** Call after filling `list`. */
  syncList(): void {
    this.listBox.hidden = !this.listShown || this.list.childElementCount === 0;
  }

  /** Shows the widget with the input focused and its text selected; `text` replaces the input. */
  open(text?: string): void {
    this.element.hidden = false;
    if (text !== undefined) this.input.value = text;
    if (this.input.value !== this.settled) this.settle();
    this.input.focus();
    this.input.select();
  }

  /** Hides the widget; the text stays and is searched again when it opens. */
  hide(): void {
    clearTimeout(this.timer);
    this.settled = '';
    this.element.hidden = true;
    this.setProgress(null);
  }

  setCount(count: FindCount): void {
    this.count.textContent = count.text;
    this.count.title = count.text;
    this.count.classList.toggle('problem', count.problem === true);
    this.input.classList.toggle('problem', count.problem === true);
  }

  /** Whether ↑ and ↓ have anywhere to go. */
  setStepping(enabled: boolean): void {
    this.prev.disabled = !enabled;
    this.next.disabled = !enabled;
  }

  /** `null` hides the bar; `undefined` shows it running without a known end; else the share done, 0-1. */
  setProgress(done: number | null | undefined): void {
    this.progress.hidden = done === null;
    this.progress.classList.toggle('indeterminate', done === undefined);
    this.fill.style.width = done === null || done === undefined ? '' : `${Math.round(Math.min(1, done) * 100)}%`;
  }

  /** Runs the pending query at once, if the input changed since the last one. */
  private settle(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.input.value === this.settled) return;
    this.settled = this.input.value;
    this.events.onQuery(this.settled);
  }

  private step(back: boolean): void {
    this.settle();
    this.events.onStep(back);
  }
}
