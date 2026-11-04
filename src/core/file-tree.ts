import type { FileChange } from './details.ts';

export interface FileTreeFolder {
  kind: 'folder';
  /** Display name; compacted chains read "a/b/c". */
  name: string;
  /** Path from the repository root. */
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  kind: 'file';
  name: string;
  change: FileChange;
}

export type FileTreeNode = FileTreeFolder | FileTreeFile;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Changed files as a folder tree: folders first, then files, by name; single-child folder chains compacted. */
export function buildFileTree(files: readonly FileChange[]): FileTreeNode[] {
  const root: FileTreeFolder = { kind: 'folder', name: '', path: '', children: [] };
  for (const change of files) {
    const parts = change.path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.children.find((c): c is FileTreeFolder => c.kind === 'folder' && c.name === part);
      if (!next) {
        next = { kind: 'folder', name: part, path: folder.path ? `${folder.path}/${part}` : part, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', name: parts[parts.length - 1]!, change });
  }
  return finish(root.children);
}

/** Compacts single-child folder chains and sorts each level. */
function finish(nodes: FileTreeNode[]): FileTreeNode[] {
  const out = nodes.map((n): FileTreeNode => {
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
