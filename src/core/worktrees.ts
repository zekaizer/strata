/** Whether git lets a worktree go: `git worktree prune` removes a prunable one, never a locked one. */
export type WorktreeState =
  { kind: 'active' } | { kind: 'locked'; reason: string | undefined } | { kind: 'prunable'; reason: string };

/** A worktree of the repository with a work tree, as `git worktree list --porcelain` describes it. */
export interface WorktreeInfo {
  /** As git prints it: absolute, '/'-separated. */
  path: string;
  /** Its folder's name. */
  name: string;
  /** undefined before its first commit. */
  head: string | undefined;
  /** Full name of the branch it has checked out; undefined when detached. */
  branch: string | undefined;
  state: WorktreeState;
  /** The main worktree, which cannot be removed. */
  main: boolean;
}

const NO_COMMIT = /^0+$/;

/** A C-quoted string as git writes one (quote_c_style), else the text as it is. */
function unquote(text: string): string {
  const m = /^"(.*)"$/.exec(text);
  if (!m) return text;
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' };
  const bytes = m[1]!.replace(/\\([0-7]{3}|.)/g, (_, c: string) =>
    c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : (escapes[c] ?? c),
  );
  // Octal escapes are UTF-8 bytes; with core.quotePath=false the text is already decoded.
  if (Array.from(bytes).some((ch) => ch.charCodeAt(0) > 0xff)) return bytes;
  return new TextDecoder().decode(Uint8Array.from(bytes, (ch) => ch.charCodeAt(0)));
}

/**
 * The worktrees `git worktree list --porcelain` lists, in its order, the main one first; a bare
 * main repository is left out. Without -z (git 2.36+) a path holding a newline cannot be read.
 */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  porcelain.split('\n\n').forEach((block, i) => {
    const attrs = new Map<string, string>();
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      if (line) attrs.set(space < 0 ? line : line.slice(0, space), space < 0 ? '' : line.slice(space + 1));
    }
    const path = attrs.get('worktree');
    if (path === undefined || attrs.has('bare')) return;
    const head = attrs.get('HEAD');
    const locked = attrs.get('locked');
    const prunable = attrs.get('prunable');
    list.push({
      path,
      name: path.replace(/\/+$/, '').split('/').at(-1) ?? path,
      head: head === undefined || NO_COMMIT.test(head) ? undefined : head,
      branch: attrs.get('branch'),
      state:
        locked !== undefined
          ? { kind: 'locked', reason: locked === '' ? undefined : unquote(locked) }
          : prunable !== undefined
            ? { kind: 'prunable', reason: prunable }
            : { kind: 'active' },
      main: i === 0,
    });
  });
  return list;
}

/** The worktree of `list` each branch is checked out in, by full name. */
export function holders(list: readonly WorktreeInfo[]): Map<string, WorktreeInfo> {
  return new Map(list.flatMap((w) => (w.branch === undefined ? [] : [[w.branch, w] as const])));
}

/** Whether a path git prints and a file system path (Windows: backslashes, any drive letter case) are one. */
export function samePath(git: string, fs: string): boolean {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/^[a-z]:/i, (d) => d.toUpperCase());
  return norm(git) === norm(fs);
}
