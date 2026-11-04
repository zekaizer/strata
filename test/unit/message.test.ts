import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reflowBody } from '../../src/core/message.ts';

describe('reflowBody', () => {
  it('joins prose wrapped at the fill column', () => {
    const body = [
      'The remove callback freed the device state before the interrupt',
      'handler was unregistered, so an interrupt arriving in between read',
      'freed memory.',
      '',
      'Unregister the handler first.',
    ].join('\n');
    assert.equal(
      reflowBody(body),
      'The remove callback freed the device state before the interrupt handler was unregistered, so an interrupt arriving in between read freed memory.\n\nUnregister the handler first.',
    );
  });
  it('keeps trailers, list items, quotes and indented lines', () => {
    const body = [
      'Fixes: 1234567890ab ("driver: add remove callback that is quite long")',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
      '',
      '- first item that is long enough to look like wrapped prose text',
      '- second item',
      '* third item that is long enough to look like wrapped prose text',
      '1. numbered item that is long enough to look like wrapped prose',
      '> quoted line that is long enough to look like wrapped prose text',
      '> second quoted line',
      '    indented code line that is long enough to look like wrapped',
      '    more code',
    ].join('\n');
    assert.equal(reflowBody(body), body);
  });
  it('keeps short lines and sentence-per-line lists', () => {
    const body = [
      'Changes:',
      'faster startup',
      'Step 1: move part 1 of the suspend path into its own helper here.',
      'Step 2: move part 2 of the suspend path into its own helper here.',
    ].join('\n');
    assert.equal(reflowBody(body), body);
  });
  it('leaves fenced code untouched', () => {
    const body = [
      '```',
      'a line of code inside a fence that is long enough to be joined if',
      'it were prose',
      '```',
    ].join('\n');
    assert.equal(reflowBody(body), body);
  });
  it('normalizes CRLF line endings', () => {
    assert.equal(
      reflowBody('a sentence that goes on and on until it wraps at the fill\r\ncolumn of the editor'),
      'a sentence that goes on and on until it wraps at the fill column of the editor',
    );
  });
});
