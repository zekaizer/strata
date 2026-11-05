/** Bytes of a commit-graph file that hold its header and chunk table, whatever its chunk count. */
export const GRAPH_HEADER_BYTES = 8 + 256 * 12;

/**
 * Chunk ids listed in a commit-graph file's chunk table, read from its first bytes; empty when
 * they are not a commit-graph header. 'BIDX' and 'BDAT' are its changed-path (Bloom) filters.
 */
export function graphChunks(header: Uint8Array): string[] {
  const ascii = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
  if (header.length < 8 || ascii(0) !== 'CGPH') return [];
  const count = header[6]!;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 12;
    if (at + 4 > header.length) break;
    ids.push(ascii(at));
  }
  return ids;
}

/** Whether a commit-graph file with these chunks carries changed-path filters git can use. */
export const hasBloomChunks = (chunks: readonly string[]): boolean =>
  chunks.includes('BIDX') && chunks.includes('BDAT');
