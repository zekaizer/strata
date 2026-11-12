import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchRanges } from '../../src/core/find.ts';
import { isWebUrl, messageSegments } from '../../src/core/message-links.ts';

/** The segments as a string: links in [brackets], find matches in *stars*. */
const shown = (text: string, needle = '') =>
  messageSegments(text, matchRanges(text, needle))
    .map((s) => {
      const inner = s.pieces.map((p) => (p.marked ? `*${p.text}*` : p.text)).join('');
      return s.url === undefined ? inner : `[${inner}]`;
    })
    .join('');
const urls = (text: string) => messageSegments(text, []).flatMap((s) => (s.url === undefined ? [] : [s.url]));

describe('messageSegments', () => {
  it('leaves text without a URL as it is', () => {
    assert.equal(shown('Unregister the handler first.'), 'Unregister the handler first.');
    assert.deepEqual(messageSegments('', []), []);
  });
  it('makes http and https URLs links, and nothing else', () => {
    assert.equal(
      shown('See https://example.org/a and http://example.org/b\nnot ftp://example.org/c or file:///etc/passwd'),
      'See [https://example.org/a] and [http://example.org/b]\nnot ftp://example.org/c or file:///etc/passwd',
    );
    assert.deepEqual(urls('Link: https://example.org/r/1?x=1&y=2#top'), ['https://example.org/r/1?x=1&y=2#top']);
  });
  it('leaves the punctuation after a URL out of the link', () => {
    assert.equal(shown('Read https://example.org/a.'), 'Read [https://example.org/a].');
    assert.equal(shown('At https://example.org/a, then on.'), 'At [https://example.org/a], then on.');
    assert.equal(shown('(see https://example.org/a)'), '(see [https://example.org/a])');
    assert.equal(shown('(see https://example.org/a).'), '(see [https://example.org/a]).');
    assert.equal(shown('<https://example.org/a>'), '<[https://example.org/a]>');
  });
  it('keeps a closing parenthesis that the URL itself opened', () => {
    assert.equal(shown('https://example.org/wiki/Remove_(callback)'), '[https://example.org/wiki/Remove_(callback)]');
    assert.equal(
      shown('(https://example.org/wiki/Remove_(callback))'),
      '([https://example.org/wiki/Remove_(callback)])',
    );
  });
  it('needs something after the scheme, and a scheme that starts a word', () => {
    assert.equal(
      shown('The scheme https:// alone, and xhttps://example.org'),
      'The scheme https:// alone, and xhttps://example.org',
    );
  });
  it('marks a find match inside a link, beside it and across its edge', () => {
    assert.equal(shown('See https://example.org/a now', 'example'), 'See [https://*example*.org/a] now');
    assert.equal(shown('See https://example.org/a now', 'see'), '*See* [https://example.org/a] now');
    assert.equal(shown('See https://example.org/a now', 'a now'), 'See [https://example.org/*a*]* now*');
    assert.equal(shown('See https://example.org/a now', 'see https'), '*See *[*https*://example.org/a] now');
  });
  it('gives each link its whole URL however find cuts it', () => {
    const segments = messageSegments('See https://example.org/a now', [[8, 15]]);
    assert.deepEqual(
      segments.map((s) => s.url),
      [undefined, 'https://example.org/a', undefined],
    );
    assert.equal(segments.flatMap((s) => s.pieces.map((p) => p.text)).join(''), 'See https://example.org/a now');
  });
});

describe('isWebUrl', () => {
  it('accepts http and https', () => {
    assert.ok(isWebUrl('https://example.org/a'));
    assert.ok(isWebUrl('http://example.org'));
    assert.ok(isWebUrl('HTTPS://example.org'));
  });
  it('refuses every other scheme and anything that is not a URL', () => {
    for (const url of [
      'file:///etc/passwd',
      'command:workbench.action.terminal.new',
      'vscode://settings',
      'javascript:alert(1)',
      ' https://example.org',
      'https:example.org',
      'example.org',
      '',
    ])
      assert.equal(isWebUrl(url), false, url);
  });
});
