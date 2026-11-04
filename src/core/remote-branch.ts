/**
 * The remote and branch of a remote-tracking ref (refs/remotes/<remote>/<branch>). Remote names
 * may contain '/', so the longest known remote wins; `<remote>/HEAD` is no branch.
 */
export function remoteBranch(name: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => name.startsWith(`refs/remotes/${r}/`));
  if (remote === undefined) return undefined;
  const branch = name.slice(`refs/remotes/${remote}/`.length);
  return branch === 'HEAD' || branch === '' ? undefined : { remote, branch };
}
