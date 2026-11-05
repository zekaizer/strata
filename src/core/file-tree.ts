import type { FileChange } from './details.ts';

export interface FileTreeFolder<F extends FileChange = FileChange> {
  kind: 'folder';
  /** Display name; compacted chains read "a/b/c". */
  name: string;
  /** Path from the repository root. */
  path: string;
  children: FileTreeNode<F>[];
}

export interface FileTreeFile<F extends FileChange = FileChange> {
  kind: 'file';
  /** A path ending in "/" (a folder git lists as one untracked entry) keeps the "/". */
  name: string;
  change: F;
}

export type FileTreeNode<F extends FileChange = FileChange> = FileTreeFolder<F> | FileTreeFile<F>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Changed files as a folder tree: folders first, then files, by name; single-child folder chains compacted. */
export function buildFileTree<F extends FileChange>(files: readonly F[]): FileTreeNode<F>[] {
  const root: FileTreeFolder<F> = { kind: 'folder', name: '', path: '', children: [] };
  for (const change of files) {
    const dir = change.path.endsWith('/');
    const parts = (dir ? change.path.slice(0, -1) : change.path).split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.children.find((c): c is FileTreeFolder<F> => c.kind === 'folder' && c.name === part);
      if (!next) {
        next = { kind: 'folder', name: part, path: folder.path ? `${folder.path}/${part}` : part, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', name: `${parts[parts.length - 1]!}${dir ? '/' : ''}`, change });
  }
  return finish(root.children);
}

/** Compacts single-child folder chains and sorts each level. */
function finish<F extends FileChange>(nodes: FileTreeNode<F>[]): FileTreeNode<F>[] {
  const out = nodes.map((n): FileTreeNode<F> => {
    if (n.kind === 'file') return n;
    let folder = n;
    // A folder whose only child is a folder reads as one entry, like VS Code's compact folders.
    for (
      let only = folder.children[0];
      folder.children.length === 1 && only?.kind === 'folder';
      only = folder.children[0]
    ) {
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    return { ...folder, children: finish(folder.children) };
  });
  return out.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1));
}
