const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A commit row's date in local time, the same in every locale: "11-15 07:35" this year (as of
 * `now`), "2023-11-15" before or after it.
 */
export function rowDate(unixSeconds: number, now = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === now.getFullYear()
    ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}-${day}`;
}
