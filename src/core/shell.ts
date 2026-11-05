/** The family of the shell a terminal runs, which decides how arguments are quoted. */
export type ShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown';

const POSIX = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** The shell family of a shell executable's path (VS Code's `env.shell`). */
export function shellKind(path: string): ShellKind {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (POSIX.has(name)) return 'posix';
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  return name === 'cmd' ? 'cmd' : 'unknown';
}

/** Arguments a POSIX shell (and fish) reads as themselves; zsh expands a leading `=`. */
const PLAIN = /^[\w./@:+,-][\w./@:=+,-]*$/;

/**
 * Arguments PowerShell reads as themselves: no `,` (array operator), no leading `@` (splatting),
 * and no `.` after a single leading `-` (PowerShell splits `-a.b` into `-a` and `.b`).
 */
const POWERSHELL_PLAIN = /^(?:--[\w./@:=+-]*|-[\w-]*|[\w./:=+][\w./@:=+-]*)$/;

const QUOTE: Record<'posix' | 'powershell', (a: string) => string> = {
  posix: (a) => (PLAIN.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`),
  // PowerShell ends a single-quoted string at any of ' ‘ ’ ‚ ‛; doubling one keeps it.
  powershell: (a) => (POWERSHELL_PLAIN.test(a) ? a : `'${a.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`),
};

/**
 * `args` as one command line for `shell`; undefined when an argument cannot be quoted safely for
 * it (cmd.exe has no quoting that stops `&`, and an unknown shell may read anything).
 */
export function shellCommand(args: readonly string[], shell: 'posix' | 'powershell'): string;
export function shellCommand(args: readonly string[], shell: ShellKind): string | undefined;
export function shellCommand(args: readonly string[], shell: ShellKind): string | undefined {
  if (shell === 'posix' || shell === 'powershell') return args.map(QUOTE[shell]).join(' ');
  return args.every((a) => PLAIN.test(a)) ? args.join(' ') : undefined;
}
