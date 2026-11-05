import type { RefKind } from '../core/refs.ts';
import type { Where, WhereAsk } from '../core/where.ts';
import type { CardRef } from './badges.ts';
import { codicon, el } from './format.ts';

/** How long the pointer rests on a node before its card shows. */
const SHOW_DELAY_MS = 300;
/** Lines listed before "+N more". */
const MAX_LINES = 12;
/** Space between the card and the node, and the card and the window edges, in px. */
const OFFSET = 12;
const MARGIN = 4;

const ICON: Record<CardRef['look'] | RefKind, string> = {
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
  worktree: 'worktree',
};

/** A commit's node under the pointer: its refs, which tag lines to show, and the node's centre in client px. */
export interface CardTarget {
  hash: string;
  refs: readonly CardRef[];
  tags: Pick<WhereAsk, 'firstIn' | 'after'>;
  x: number;
  y: number;
}

/** A labelled line below the refs, e.g. "First in" and its value. */
type WhereLine = [key: string, value: HTMLElement];

/**
 * The card listing every ref of the commit whose graph node the pointer rests on, then where the
 * commit is (On, First in, After). It takes no pointer events, so clicks and selection go to the
 * row under it. Where a commit is comes from the host (`ask`), only once its card shows, and is
 * kept until forget().
 */
export class RefCard {
  readonly element = el('div', 'card ref-card');
  /** The commit the card shows or is about to show. */
  private target: CardTarget | undefined;
  /** Whether the show delay for `target` has passed. */
  private shown = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly answers = new Map<string, Where>();
  /** The commit asked about and not answered yet. */
  private asked: string | undefined;
  /** Asks the host where commit `hash` is; undefined withdraws the question. */
  private readonly ask: (hash: string | undefined) => void;

  constructor(ask: (hash: string | undefined) => void) {
    this.ask = ask;
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
    if (!target) return;
    this.target = target;
    this.timer = setTimeout(() => {
      this.show();
    }, SHOW_DELAY_MS);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.target = undefined;
    this.shown = false;
    this.element.hidden = true;
    if (this.asked !== undefined) {
      this.asked = undefined;
      this.ask(undefined);
    }
  }

  /** Where commit `hash` is, as the host answered. */
  answer(hash: string, where: Where): void {
    this.answers.set(hash, where);
    if (this.asked === hash) this.asked = undefined;
    if (this.shown && this.target?.hash === hash) this.render();
  }

  /** Drops the answers, which a reload or new badge rules make stale; a card on screen asks again. */
  forget(): void {
    this.answers.clear();
    this.asked = undefined;
    if (this.shown) this.show();
  }

  /** The card's lines while it is shown, for integration tests. */
  probe(): { hash: string; lines: string[] } | undefined {
    if (this.element.hidden || !this.target) return undefined;
    const text = (parts: Iterable<Element>) => [...parts].map((e) => e.textContent).join(' · ');
    const refs = [...this.element.querySelectorAll('.ref-card-line')].map((line) =>
      text(line.querySelectorAll('.ref-card-text, .ref-card-note')),
    );
    const where = [...this.element.querySelectorAll('.ref-card-key')].map(
      (key) => `${key.textContent}: ${text(key.nextElementSibling!.querySelectorAll('.chip-text, .ref-card-note'))}`,
    );
    return { hash: this.target.hash, lines: [...refs, ...where] };
  }

  private show(): void {
    const target = this.target!;
    this.shown = true;
    if (!this.answers.has(target.hash)) {
      this.asked = target.hash;
      this.ask(target.hash);
    }
    this.render();
  }

  private render(): void {
    const target = this.target!;
    const lines: HTMLElement[] = target.refs
      .slice(0, target.refs.length > MAX_LINES ? MAX_LINES - 1 : MAX_LINES)
      .map((r) => {
        const line = el('div', `ref-card-line ref-card-${r.look}${r.hiddenBy === undefined ? '' : ' hidden-badge'}`);
        line.append(codicon(ICON[r.look]), el('span', 'ref-card-text', r.text));
        const state = r.state === undefined ? '' : `, ${r.state}`;
        if (r.note !== undefined) line.append(el('span', 'ref-card-note', r.note + (r.worktree ? '' : state)));
        if (r.worktree !== undefined) line.append(el('span', 'ref-card-note', `in worktree ${r.worktree}${state}`));
        if (r.hiddenBy !== undefined) line.append(el('span', 'ref-card-note', `hidden by ${r.hiddenBy}`));
        return line;
      });
    const rest = target.refs.length - lines.length;
    if (rest > 0) {
      const more = el('div', 'ref-card-line ref-card-more');
      more.append(el('span', 'ref-card-text', `+${rest} more`));
      lines.push(more);
    }
    const where = whereLines(target, this.answers.get(target.hash));
    if (where.length > 0) {
      if (lines.length > 0) lines.push(el('div', 'card-divider'));
      const grid = el('div', 'ref-card-where');
      for (const [key, value] of where) grid.append(el('span', 'ref-card-key', key), value);
      lines.push(grid);
    }
    this.element.replaceChildren(...lines);
    // Nothing to say: every query of a commit without refs failed.
    this.element.hidden = lines.length === 0;
    if (this.element.hidden) return;
    const { width, height } = this.element.getBoundingClientRect();
    const left = Math.min(target.x + OFFSET, innerWidth - MARGIN - width);
    // Below the node, so the row's own subject and badges stay in view; above it near the bottom.
    const below = target.y + OFFSET;
    const top = below + height <= innerHeight - MARGIN ? below : target.y - OFFSET - height;
    this.element.style.left = `${Math.max(MARGIN, left)}px`;
    this.element.style.top = `${Math.max(MARGIN, top)}px`;
  }
}

/** The labelled lines below the refs: "…" for each line asked while `where` is unanswered. */
function whereLines(target: CardTarget, where: Where | undefined): WhereLine[] {
  if (!where) {
    const asked = [
      ['On', true],
      ['First in', target.tags.firstIn],
      ['After', target.tags.after],
    ] as const;
    return asked.filter(([, on]) => on).map(([key]) => [key, value(note('…'))]);
  }
  const lines: WhereLine[] = [];
  if (where.on) {
    const { refs, more, hidden } = where.on;
    const chips = refs.map((r) => chip(r.kind, r.short));
    if (more > 0) chips.push(note(`+${more}`));
    if (refs.length === 0) chips.push(note(hidden > 0 ? `${hidden} hidden` : 'no branch'));
    lines.push(['On', value(...chips)]);
  }
  if (where.firstIn !== undefined)
    lines.push(['First in', value(where.firstIn === null ? note('no tag yet') : chip('tag', where.firstIn))]);
  if (where.after) {
    const { tag, commits } = where.after;
    lines.push(['After', value(chip('tag', tag), note(`+${commits} commit${commits === 1 ? '' : 's'}`))]);
  }
  return lines;
}

const value = (...parts: HTMLElement[]): HTMLElement => {
  const e = el('span', 'ref-card-value');
  e.append(...parts);
  return e;
};

const chip = (kind: RefKind, text: string): HTMLElement => {
  const e = el('span', `chip chip-${kind}`);
  e.append(codicon(ICON[kind]), el('span', 'chip-text', text));
  return e;
};

const note = (text: string): HTMLElement => el('span', 'ref-card-note', text);
