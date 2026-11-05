/**
 * Steps that shorten a toolbar too narrow for its contents, applied in this order until they fit,
 * each a class on the toolbar kept by the later ones: no status text unless it says an operation
 * is running or failed (it then shrinks to the room left); the stash count as a number; the
 * toggles (HEAD, Badges, First parent) as icons; a shorter path chip; the ref filter as an icon and
 * a shorter repository name; last, half the space between items and the path chip as an icon.
 */
export const FIT_STEPS = ['fit-status', 'fit-stash', 'fit-toggles', 'fit-path', 'fit-filter', 'fit-tight'] as const;

/**
 * Keeps the contents of `toolbar` within its width, re-fitting when it is resized and when
 * something in it changes (shown, hidden, relabelled). Popovers are not counted, nor the `spacer`
 * that takes the room left.
 */
export function keepToolbarFitting(toolbar: HTMLElement, parts: { status: HTMLElement; spacer: HTMLElement }): void {
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit(toolbar, parts);
    });
  };
  new ResizeObserver(queue).observe(toolbar);
  const inPopover = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('.popover') != null;
  new MutationObserver((records) => {
    if (records.some((r) => !inPopover(r.target))) queue();
  }).observe(toolbar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });
}

function fit(toolbar: HTMLElement, { status, spacer }: { status: HTMLElement; spacer: HTMLElement }): void {
  toolbar.classList.remove(...FIT_STEPS);
  const style = getComputedStyle(toolbar);
  const room = toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  // Every laid out item, an empty one too, has a gap after it but the last. The status counts
  // with all of its text until it may shrink.
  const needed = () => {
    const gap = parseFloat(getComputedStyle(toolbar).columnGap) || 0;
    let width = -gap;
    for (const e of toolbar.children) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.position === 'absolute') continue;
      width += gap;
      if (e === spacer) continue;
      if (e === status) {
        if (!toolbar.classList.contains('fit-status')) width += status.scrollWidth;
        continue;
      }
      width += e.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight);
    }
    return width;
  };
  for (const step of FIT_STEPS) {
    if (needed() <= room) return;
    toolbar.classList.add(step);
  }
}
