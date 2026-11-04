import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contrast, oklabDistance, oklch, parseCssColor, toHex } from '../../src/core/color.ts';

const hex = (s: string) => {
  const c = parseCssColor(s);
  assert.ok(c, s);
  return c;
};

describe('color', () => {
  it('parses and formats hex colors', () => {
    for (const s of ['#000000', '#ffffff', '#1f1f1f', '#04395e', '#59a4f9']) assert.equal(toHex(hex(s)), s);
    assert.equal(toHex(hex('#abc')), '#aabbcc');
    assert.equal(toHex(hex('#ABCDEF')), '#abcdef');
  });

  it('composites alpha over the surface below in gamma space, like browsers', () => {
    const white = hex('#ffffff');
    assert.equal(toHex(parseCssColor('rgba(0, 0, 0, 0.5)', white)!), '#808080');
    assert.equal(toHex(parseCssColor('#00000080', white)!), '#7f7f7f');
    assert.equal(toHex(parseCssColor('rgb(4, 57, 94)')!), '#04395e');
    assert.equal(toHex(parseCssColor('rgba(255,255,255,0.1)', hex('#000000'))!), '#1a1a1a');
  });

  it('rejects what it cannot parse', () => {
    for (const s of ['', 'red', 'null', '#12', 'rgb(1,2)', 'hsl(0 0% 0%)'])
      assert.equal(parseCssColor(s), undefined, s);
  });

  it('computes WCAG contrast', () => {
    assert.equal(contrast(hex('#000000'), hex('#ffffff')).toFixed(2), '21.00');
    assert.equal(contrast(hex('#777777'), hex('#ffffff')).toFixed(2), '4.48');
    assert.equal(contrast(hex('#ffffff'), hex('#777777')), contrast(hex('#777777'), hex('#ffffff')));
  });

  it('converts OKLCH and stays inside the sRGB gamut', () => {
    assert.equal(toHex(oklch(1, 0, 0)), '#ffffff');
    assert.equal(toHex(oklch(0, 0, 0)), '#000000');
    // Reference value: oklch(0.628 0.2577 29.23) is sRGB red.
    assert.equal(toHex(oklch(0.62796, 0.25768, 29.2339)), '#ff0000');
    for (let h = 0; h < 360; h += 15) {
      for (const c of oklch(0.7, 0.4, h)) assert.ok(c >= 0 && c <= 1, `h=${h}`);
    }
  });

  it('measures OKLab distance', () => {
    assert.equal(oklabDistance(hex('#123456'), hex('#123456')), 0);
    assert.equal(oklabDistance(hex('#000000'), hex('#ffffff')).toFixed(3), '1.000');
  });
});
