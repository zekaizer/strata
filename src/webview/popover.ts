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
