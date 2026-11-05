import type { Banner, BannerAction } from './banner.ts';
import { el } from './format.ts';

/**
 * The banner between the toolbar and the list (design §7.2): one sentence with commit links, then
 * buttons that run the graph's commands. It is a region before the list, so Shift+Tab reaches it.
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
    const text = el('span', 'banner-text');
    for (const part of banner.parts) {
      if (typeof part === 'string') {
        text.append(part);
        continue;
      }
      const link = el('button', 'link-button banner-link', part.short);
      link.title = part.hash;
      link.setAttribute('aria-label', `Select commit ${part.short}`);
      link.addEventListener('click', () => {
        this.select(part.hash);
      });
      text.append(link);
    }
    const actions = el('span', 'banner-actions');
    banner.actions.forEach((action, i) => {
      const button = el('button', i === 0 ? 'banner-button primary' : 'banner-button', action.label);
      button.addEventListener('click', () => {
        if (this.busy === undefined) this.run(action);
      });
      actions.append(button);
    });
    text.title = text.textContent;
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

  /** The banner's sentence as read: links by their text. */
  get text(): string {
    return this.element.querySelector('.banner-text')?.textContent ?? '';
  }
}
