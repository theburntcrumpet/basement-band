import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeStretch } from '../src/engine/stretch.js';

const rate = 44100;
const crossings = (d, from, to) => { let n = 0; for (let i = from + 1; i < to; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) n++; return n; };
const rms = (d, from, to) => { let e = 0; for (let i = from; i < to; i++) e += d[i] * d[i]; return Math.sqrt(e / (to - from)); };

for (const factor of [0.75, 1.25, 1.6]) {
  test(`stretch x${factor}: length scales, pitch and level hold`, () => {
    const n = rate * 2;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    const [out] = timeStretch([tone], factor, rate);
    assert.equal(out.length, Math.round(n * factor));
    // Pitch: zero crossings per second in the middle of the output stay at ~880 (440 Hz).
    const a = Math.floor(out.length * 0.25), b = Math.floor(out.length * 0.75);
    const hz = crossings(out, a, b) / 2 / ((b - a) / rate);
    assert.ok(Math.abs(hz - 440) < 4, `pitch ${hz.toFixed(1)} Hz`);
    // Level: steady through the whole output, including the very start (no fade-in from framing).
    for (const [x, y] of [[0, 0.05], [0.3, 0.4], [0.9, 0.97]]) {
      const level = rms(out, Math.floor(out.length * x), Math.floor(out.length * y));
      assert.ok(Math.abs(level - 0.3535) < 0.04, `level ${level.toFixed(3)} at ${x}`);
    }
  });
}

test('stretch keeps transients in time and stereo channels aligned', () => {
  const n = rate * 2, factor = 1.5;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let k = 0; k < 4; k++) { const at = Math.round(k * 0.5 * rate); for (let i = 0; i < 300; i++) { l[at + i] = Math.sin(i * 0.4) * 0.8 * (1 - i / 300); r[at + i] = l[at + i] * 0.5; } }
  const [ol, or] = timeStretch([l, r], factor, rate);
  // Each click should land near k * 0.75 s.
  for (let k = 1; k < 4; k++) {
    const expected = Math.round(k * 0.5 * factor * rate);
    let peak = 0, where = 0;
    for (let i = expected - rate * 0.05; i < expected + rate * 0.05; i++) if (Math.abs(ol[i]) > peak) { peak = Math.abs(ol[i]); where = i; }
    assert.ok(Math.abs(where - expected) < rate * 0.03, `click ${k} at ${(where / rate).toFixed(3)} s, expected ${(expected / rate).toFixed(3)} s`);
    assert.ok(peak > 0.3, `click ${k} survived (${peak.toFixed(2)})`);
    assert.ok(Math.abs(Math.abs(or[where]) - Math.abs(ol[where]) * 0.5) < 0.05, 'stereo stays aligned');
  }
});
