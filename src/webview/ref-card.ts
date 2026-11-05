import type { CardRef } from './badges.ts';
import { codicon, el } from './format.ts';

/** How long the pointer rests on a node before its card shows. */
const SHOW_DELAY_MS = 300;
/** Lines listed before "+N more". */
const MAX_LINES = 12;
/** Space between the card and the node, and the card and the window edges, in px. */
const OFFSET = 12;
const MARGIN = 4;

const ICON: Record<CardRef['look'], string> = {
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
};

/** A commit's node under the pointer: its refs and the node's centre in client px. */
export interface CardTarget {
  hash: string;
  /** The card's lines; none: no card. */
  refs: readonly CardRef[];
  x: number;
  y: number;
}

/**
 * The card listing every ref of the commit whose graph node the pointer rests on. It takes no
 * pointer events, so clicks and selection go to the row under it.
 */
export class RefCard {
  readonly element = el('div', 'ref-card');
  /** The commit the card shows or is about to show. */
  private target: CardTarget | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.element.setAttribute('role', 'tooltip');
    this.element.hidden = true;
  }

  /** The commit whose card is shown or pending. */
  get hash(): string | undefined {
    return this.target?.hash;
  }

  /** The node under the pointer, or undefined off every node: a new one shows after a delay. */
  point(target: CardTarget | undefined): void {
    if (target?.hash === this.target?.hash) return;
    this.hide();
    if (!target || target.refs.length === 0) return;
    this.target = target;
    this.timer = setTimeout(() => {
      this.show(target);
    }, SHOW_DELAY_MS);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.target = undefined;
    this.element.hidden = true;
  }

  /** The card's lines while it is shown, for integration tests. */
  probe(): { hash: string; lines: string[] } | undefined {
    if (this.element.hidden || !this.target) return undefined;
    return {
      hash: this.target.hash,
      lines: [...this.element.children].map((line) =>
        [...line.querySelectorAll('.ref-card-text, .ref-card-note')].map((e) => e.textContent).join(' · '),
      ),
    };
  }

  private show(target: CardTarget): void {
    const lines = target.refs.slice(0, target.refs.length > MAX_LINES ? MAX_LINES - 1 : MAX_LINES).map((r) => {
      const line = el('div', `ref-card-line ref-card-${r.look}${r.hiddenBy === undefined ? '' : ' hidden-badge'}`);
      line.append(codicon(ICON[r.look]), el('span', 'ref-card-text', r.text));
      if (r.note !== undefined) line.append(el('span', 'ref-card-note', r.note));
      if (r.hiddenBy !== undefined) line.append(el('span', 'ref-card-note', `hidden by ${r.hiddenBy}`));
      return line;
    });
    const rest = target.refs.length - lines.length;
    if (rest > 0) {
      const more = el('div', 'ref-card-line ref-card-more');
      more.append(el('span', 'ref-card-text', `+${rest} more`));
      lines.push(more);
    }
    this.element.replaceChildren(...lines);
    this.element.hidden = false;
    const { width, height } = this.element.getBoundingClientRect();
    const left = Math.min(target.x + OFFSET, innerWidth - MARGIN - width);
    // Below the node, so the row's own subject and badges stay in view; above it near the bottom.
    const below = target.y + OFFSET;
    const top = below + height <= innerHeight - MARGIN ? below : target.y - OFFSET - height;
    this.element.style.left = `${Math.max(MARGIN, left)}px`;
    this.element.style.top = `${Math.max(MARGIN, top)}px`;
  }
}
