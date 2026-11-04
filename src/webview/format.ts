const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const shortDateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });

export const formatDate = (unixSeconds: number) => dateFormat.format(new Date(unixSeconds * 1000));
export const formatShortDate = (unixSeconds: number) => shortDateFormat.format(new Date(unixSeconds * 1000));
export const shortHash = (hash: string) => hash.slice(0, 8);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
