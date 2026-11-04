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

/** Arguments every shell reads as themselves. */
const PLAIN = /^[\w./@:=+,-]+$/;

/**
 * `args` as one command line for `shell`; undefined when an argument cannot be quoted safely for
 * it (cmd.exe has no quoting that stops `&`, and an unknown shell may read anything).
 */
export function shellCommand(args: readonly string[], shell: ShellKind): string | undefined {
  const quoteArg = (a: string): string | undefined => {
    if (PLAIN.test(a)) return a;
    if (shell === 'posix') return `'${a.replace(/'/g, `'\\''`)}'`;
    if (shell === 'powershell') return `'${a.replace(/'/g, "''")}'`;
    return undefined;
  };
  const quoted = args.map(quoteArg);
  return quoted.every((a) => a !== undefined) ? quoted.join(' ') : undefined;
}
