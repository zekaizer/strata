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
  private shown = '';

  constructor(run: (action: BannerAction) => void, select: (hash: string) => void) {
    this.run = run;
    this.select = select;
    this.element.hidden = true;
    this.element.setAttribute('role', 'region');
  }

  /** Renders only when the banner changed, so a focused button keeps focus. */
  show(banner: Banner | undefined): void {
    const shown = JSON.stringify(banner ?? null);
    if (shown === this.shown) return;
    this.shown = shown;
    const hadFocus = this.element.contains(document.activeElement);
    this.element.hidden = banner === undefined;
    if (!banner) {
      this.element.replaceChildren();
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
        this.run(action);
      });
      actions.append(button);
    });
    text.title = text.textContent;
    this.element.replaceChildren(icon, text, actions);
    if (hadFocus) actions.querySelector('button')?.focus();
  }

  /** The banner's sentence as read: links by their text. */
  get text(): string {
    return this.element.querySelector('.banner-text')?.textContent ?? '';
  }
}
