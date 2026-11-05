import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..', 'src');
const sources = [
  join(root, 'core', 'wording.ts'),
  join(root, 'host', 'flow.ts'),
  ...readdirSync(join(root, 'host', 'flows')).map((f) => join(root, 'host', 'flows', f)),
];

/** Lines that format a ref or a commit by hand instead of through refName or commitName. */
function handFormatted(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^export const (?:refName|commitName) = /.test(line))
    .filter(({ line }) => /'\$\{/.test(line) || /\.short\} "\$\{/.test(line))
    .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
}

describe('user-facing text', () => {
  it('names refs with refName and commits with commitName', () => {
    assert.deepEqual(sources.flatMap(handFormatted), []);
  });
});
