import type { Banner, BannerAction } from './banner.ts';
import { el } from './format.ts';

/**
 * Makes the buttons of `bar` one tab stop (the one focused last, at first the first) that the
 * arrow keys, Home and End move between, wrapping around.
 */
function roveFocus(bar: HTMLElement): void {
  const buttons = () => [...bar.querySelectorAll<HTMLButtonElement>('.banner-button')];
  bar.addEventListener('focusin', (e) => {
    for (const b of buttons()) b.tabIndex = b === e.target ? 0 : -1;
  });
  bar.addEventListener('keydown', (e) => {
    const all = buttons();
    const at = all.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (at + 1) % all.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (at - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    all[to]?.focus();
  });
}

/**
 * The banner between the toolbar and the list (design §7.2): a sentence with commit links, what
 * else to know on a line of its own, then buttons that run the graph's commands. It is a region before the list, so Shift+Tab reaches it.
 */
export class BannerView {
  readonly element = el('section', 'banner');
  private readonly run: (action: BannerAction) => void;
  private readonly select: (hash: string) => void;
  /** Takes the focus the banner had when it goes away, so the keyboard does not land on nothing. */
  private readonly leave: () => void;
  private shown = '';
  /** The operation running: the buttons are held meanwhile. */
  private busy: string | undefined;

  constructor(run: (action: BannerAction) => void, select: (hash: string) => void, leave: () => void) {
    this.run = run;
    this.select = select;
    this.leave = leave;
    this.element.hidden = true;
    this.element.setAttribute('role', 'region');
  }

  /**
   * Renders only when the banner changed. Focus inside it stays on the button with the same text,
   * else moves to the first action, and leaves with the banner.
   */
  show(banner: Banner | undefined): void {
    const shown = JSON.stringify(banner ?? null);
    if (shown === this.shown) return;
    this.shown = shown;
    const focused = this.element.contains(document.activeElement) ? document.activeElement : null;
    this.element.hidden = banner === undefined;
    if (!banner) {
      this.element.replaceChildren();
      if (focused) this.leave();
      return;
    }
    this.element.classList.toggle('warning', banner.warning);
    this.element.dataset['state'] = banner.state;
    this.element.setAttribute('aria-label', banner.label);
    const icon = el('span', `codicon codicon-${banner.warning ? 'warning' : 'info'} banner-icon`);
    icon.setAttribute('aria-hidden', 'true');
    const lead = el('span', 'banner-lead');
    for (const part of banner.parts) {
      if (typeof part === 'string') {
        lead.append(part);
        continue;
      }
      const link = el('button', 'link-button banner-link', part.short);
      link.title = part.hash;
      link.setAttribute('aria-label', `Select commit ${part.short}`);
      link.addEventListener('click', () => {
        this.select(part.hash);
      });
      lead.append(link);
    }
    const text = el('span', 'banner-text');
    text.append(lead);
    if (banner.more) text.append(el('span', 'banner-more', banner.more));
    const actions = el('span', 'banner-actions');
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', 'Actions');
    banner.actions.forEach((action, i) => {
      const button = el('button', i === 0 ? 'banner-button primary' : 'banner-button', action.label);
      button.tabIndex = i === 0 ? 0 : -1;
      button.addEventListener('click', () => {
        if (this.busy === undefined) this.run(action);
      });
      actions.append(button);
    });
    roveFocus(actions);
    this.element.replaceChildren(icon, text, actions);
    this.holdActions();
    if (!focused) return;
    const same = [...this.element.querySelectorAll('button')].find((b) => b.textContent === focused.textContent);
    (same ?? actions.querySelector('button'))?.focus();
  }

  /** Holds the buttons and says what runs while `label` runs; undefined frees them. */
  setBusy(label: string | undefined): void {
    this.busy = label;
    this.holdActions();
  }

  /** aria-disabled rather than disabled: a held button keeps the focus it has. */
  private holdActions(): void {
    const actions = this.element.querySelector('.banner-actions');
    if (!actions) return;
    actions.querySelector('.banner-busy')?.remove();
    for (const b of actions.querySelectorAll('.banner-button')) {
      if (this.busy === undefined) b.removeAttribute('aria-disabled');
      else b.setAttribute('aria-disabled', 'true');
    }
    if (this.busy !== undefined) actions.prepend(el('span', 'banner-busy', `${this.busy}…`));
  }

  /** The banner's sentences as read: links by their text. */
  get text(): string {
    return [...this.element.querySelectorAll('.banner-lead, .banner-more')].map((e) => e.textContent).join(' ');
  }
}
