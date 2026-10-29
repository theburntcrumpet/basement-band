import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueAt, normalize, rampsFrom } from '../src/engine/automation.js';

const pts = [{ t: 4, v: -20 }, { t: 8, v: 0 }, { t: 12, v: -10 }];

test('automation value: flat before, linear between, flat after', () => {
  assert.equal(valueAt(pts, 0), -20);
  assert.equal(valueAt(pts, 6), -10);
  assert.equal(valueAt(pts, 10), -5);
  assert.equal(valueAt(pts, 20), -10);
  assert.equal(valueAt([], 3), null);
});

test('normalize sorts and keeps one point per moment', () => {
  const n = normalize([{ t: 8, v: 1 }, { t: 2, v: 0 }, { t: 8, v: 2 }]);
  assert.deepEqual(n, [{ t: 2, v: 0 }, { t: 8, v: 2 }]);
});

test('ramps from a position inside, before and after the curve', () => {
  assert.deepEqual(rampsFrom(pts, 6), [
    { at: 6, v: -10, to: 8, toV: 0 },
    { at: 8, v: 0, to: 12, toV: -10 },
    { at: 12, v: -10, to: null, toV: -10 },
  ]);
  assert.deepEqual(rampsFrom(pts, 0)[0], { at: 0, v: -20, to: 4, toV: -20 });
  assert.deepEqual(rampsFrom(pts, 14), [{ at: 14, v: -10, to: null, toV: -10 }]);
});
