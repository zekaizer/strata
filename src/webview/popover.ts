/**
 * Closes a toolbar popover the ways a click outside would: the webview losing focus (to an
 * editor), focus tabbing out of it, a pointer press outside it and its button, and Escape from
 * anywhere, which hands focus back to the button.
 */
export function dismissable(popover: HTMLElement, button: HTMLElement, close: () => void): void {
  const outside = (n: Node | null) => n !== null && !popover.contains(n) && !button.contains(n);
  window.addEventListener('blur', () => {
    if (!popover.hidden) close();
  });
  popover.addEventListener('focusout', (e) => {
    if (outside(e.relatedTarget as Node | null)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) {
      close();
      button.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && outside(e.target as Node)) close();
  });
}

/** Space kept between a popover and the window's sides, in px. */
const MARGIN = 8;

/**
 * Places an open popover under `button`, left edges aligned, moved left as far as it must go to
 * stay MARGIN px inside the window.
 */
export function placeUnder(popover: HTMLElement, button: HTMLElement): void {
  const origin = popover.offsetParent?.getBoundingClientRect().left ?? 0;
  const left = Math.max(
    MARGIN,
    Math.min(button.getBoundingClientRect().left, innerWidth - MARGIN - popover.offsetWidth),
  );
  popover.style.left = `${left - origin}px`;
  popover.style.right = 'auto';
}

/**
 * Rebuilds parts of a popover, then puts focus back on the control that had it, by its
 * `data-focus` key `<row>|<control>`: rebuilding would otherwise drop keyboard focus to <body>. A
 * control gone or disabled hands focus to its row's first usable one, else to the control of the
 * same kind now at its place (the next row's), else to `fallback`. Ref names may contain "|"; the
 * control's part after the last one does not. `scrolled` keep their scroll offsets.
 */
export function keepingFocus(
  popover: HTMLElement,
  fallback: HTMLElement,
  scrolled: readonly HTMLElement[],
  rebuild: () => void,
): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && popover.contains(active) ? active.dataset['focus'] : undefined;
  const control = key?.slice(key.lastIndexOf('|'));
  const peers = () =>
    control === undefined
      ? []
      : [...popover.querySelectorAll<HTMLElement>(`[data-focus$="${CSS.escape(control)}"]`)].filter(usable);
  const place = peers().indexOf(active as HTMLElement);
  const scroll = scrolled.map((e) => e.scrollTop);
  rebuild();
  scrolled.forEach((e, i) => {
    e.scrollTop = scroll[i]!;
  });
  if (key === undefined) return;
  const row = key.slice(0, key.lastIndexOf('|'));
  const now = peers();
  const target =
    [...popover.querySelectorAll<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)].find(usable) ??
    [...popover.querySelectorAll<HTMLElement>(`[data-focus^="${CSS.escape(`${row}|`)}"]`)].find(usable) ??
    (place >= 0 ? now[Math.min(place, now.length - 1)] : undefined) ??
    fallback;
  target.focus();
}

const usable = (e: HTMLElement) => !(e as HTMLButtonElement).disabled;
