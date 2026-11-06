import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rowDate } from '../../src/core/dates.ts';

const at = (...p: [number, number, number, number, number]) => new Date(...p).getTime() / 1000;
const now = new Date(2026, 10, 6, 9, 0);

describe('rowDate', () => {
  it('gives a date of this year as month, day and 24-hour time, zero-padded', () => {
    assert.equal(rowDate(at(2026, 0, 5, 7, 3), now), '01-05 07:03');
    assert.equal(rowDate(at(2026, 10, 15, 19, 35), now), '11-15 19:35');
  });
  it('gives a date of another year as year, month and day', () => {
    assert.equal(rowDate(at(2023, 10, 15, 7, 35), now), '2023-11-15');
    assert.equal(rowDate(at(2027, 1, 1, 0, 0), now), '2027-02-01');
  });
});
