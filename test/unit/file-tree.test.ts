import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileChange } from '../../src/core/details.ts';
import { buildFileTree, type FileTreeNode } from '../../src/core/file-tree.ts';

const M = (path: string): FileChange => ({ status: 'M', path });

/** Compact text form: folders end with "/", children indented by two spaces. */
function show(nodes: FileTreeNode[], indent = ''): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'folder' ? [`${indent}${n.name}/`, ...show(n.children, `${indent}  `)] : [`${indent}${n.name}`],
  );
}

describe('buildFileTree', () => {
  it('keeps root files flat', () => {
    assert.deepEqual(show(buildFileTree([M('b.txt'), M('a.txt')])), ['a.txt', 'b.txt']);
  });

  it('nests files under folders, folders first and sorted by name', () => {
    const tree = buildFileTree([M('src/z.ts'), M('README.md'), M('src/a.ts'), M('docs/x.md'), M('src/core/c.ts')]);
    assert.deepEqual(show(tree), ['docs/', '  x.md', 'src/', '  core/', '    c.ts', '  a.ts', '  z.ts', 'README.md']);
  });

  it('compacts chains of single-child folders', () => {
    const tree = buildFileTree([M('drivers/net/ethernet/intel/e1000.c'), M('drivers/net/ethernet/intel/e1000.h')]);
    assert.deepEqual(show(tree), ['drivers/net/ethernet/intel/', '  e1000.c', '  e1000.h']);
    const folder = tree[0]!;
    assert.ok(folder.kind === 'folder');
    assert.equal(folder.path, 'drivers/net/ethernet/intel');
  });

  it('stops compacting where a folder also holds files', () => {
    const tree = buildFileTree([M('a/b/c/x.ts'), M('a/b/y.ts')]);
    assert.deepEqual(show(tree), ['a/b/', '  c/', '    x.ts', '  y.ts']);
  });

  it('places a rename under its new path and keeps the change', () => {
    const rename: FileChange = { status: 'R', path: 'new/dir/f.ts', oldPath: 'old/f.ts' };
    const tree = buildFileTree([rename]);
    assert.deepEqual(show(tree), ['new/dir/', '  f.ts']);
    const folder = tree[0]!;
    assert.ok(folder.kind === 'folder');
    assert.deepEqual(folder.children[0], { kind: 'file', name: 'f.ts', change: rename });
  });

  it('sorts names the way people read them', () => {
    assert.deepEqual(show(buildFileTree([M('f10.c'), M('f2.c'), M('F1.c')])), ['F1.c', 'f2.c', 'f10.c']);
  });
});
