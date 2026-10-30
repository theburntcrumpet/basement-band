import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, nearestNote } from '../src/music/pitch.js';

const cents = (a, b) => 1200 * Math.log2(a / b);

function tone(hz, rate, harmonics, n = 8192, level = 0.3) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) for (const [h, a] of harmonics) x[i] += level * a * Math.sin((2 * Math.PI * hz * h * i) / rate + h);
  return x;
}
const SAW = Array.from({ length: 12 }, (_, i) => [i + 1, 1 / (i + 1)]);

test('finds the pitch to within a cent across a guitar and bass range', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const hz of [30.87, 41.2, 55, 82.41, 110, 146.83, 196, 246.94, 329.63, 440, 660, 1318.5]) {
      for (const [name, h] of [['sine', [[1, 1]]], ['saw', SAW]]) {
        const found = detectPitch(tone(hz, rate, h, Math.round((8192 * rate) / 48000)), rate);
        assert.ok(found, `${name} ${hz} Hz at ${rate}: nothing found`);
        assert.ok(Math.abs(cents(found.hz, hz)) < 1, `${name} ${hz} Hz at ${rate}: ${found.hz}`);
      }
    }
  }
});

test('hears the fundamental even when the second harmonic is stronger', () => {
  const found = detectPitch(tone(110, 48000, [[1, 0.4], [2, 1], [3, 0.5]]), 48000);
  assert.ok(Math.abs(cents(found.hz, 110)) < 1, `${found.hz}`);
});

test('a slightly detuned string reads as detuned', () => {
  const found = detectPitch(tone(110 * 2 ** (7 / 1200), 48000, SAW), 48000);
  assert.ok(Math.abs(nearestNote(found.hz).cents - 7) < 1, `${nearestNote(found.hz).cents}`);
});

test('silence and noise are not notes', () => {
  assert.equal(detectPitch(new Float32Array(8192), 48000), null);
  assert.equal(detectPitch(tone(110, 48000, SAW, 8192, 0.0001), 48000), null);
  let seed = 1;
  const noise = Float32Array.from({ length: 8192 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; });
  assert.equal(detectPitch(noise, 48000), null);
});

// A loud clipped pluck arriving over mains hum, as an instrument does on a real input. Some of these
// once sent the refinement negative, and each pass then took twice as long: the app froze.
test('a note arriving over mains hum never runs away', () => {
  let checked = 0;
  for (const rate of [48000, 96000]) {
    for (const hz of [82.41, 110, 146.83, 196, 246.94, 329.63, 622.25]) {
      for (const start of [2048, 3072, 4096, 5120, 6144]) {
        for (const gain of [1, 4, 8]) {
          for (const hum of [0.002, 0.01, 0.03]) {
            const x = new Float32Array(8192);
            for (let i = 0; i < x.length; i++) {
              let v = hum * Math.sin((2 * Math.PI * 50 * i) / rate);
              if (i >= start) {
                const t = (i - start) / rate;
                let note = 0;
                for (let h = 1; h <= 24; h++) note += Math.sin(2 * Math.PI * hz * h * t + h * h) / h;
                v += gain * 0.3 * note * Math.exp(-t * 6);
              }
              x[i] = Math.max(-1, Math.min(1, v));
            }
            const began = performance.now();
            const found = detectPitch(x, rate);
            assert.ok(performance.now() - began < 200, `took too long: ${hz} Hz at ${rate}, start ${start}, gain ${gain}, hum ${hum}`);
            if (found) assert.ok(found.hz > 20 && found.hz < 2500, `${found.hz} Hz from ${hz} Hz at ${rate}, start ${start}, gain ${gain}, hum ${hum}`);
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 630);
});

test('readings stay in the range a tuner can use', () => {
  // Regular clicks once read as 2822 Hz; well above any instrument's fundamental isn't a reading.
  for (const signal of [tone(5000, 48000, [[1, 1]]), Float32Array.from({ length: 8192 }, (_, i) => (i % 17 === 0 ? 0.5 : 0))]) {
    const found = detectPitch(signal, 48000);
    assert.ok(!found || found.hz < 2500, `${found?.hz}`);
  }
});

test('names the nearest note, honouring the reference pitch', () => {
  assert.deepEqual(nearestNote(440), { midi: 69, name: 'A', octave: 4, cents: 0 });
  const e = nearestNote(82.41);
  assert.equal(e.name + e.octave, 'E2');
  assert.ok(Math.abs(e.cents) < 1);
  assert.ok(Math.abs(nearestNote(432, 432).cents) < 1e-9);
  assert.equal(nearestNote(432, 432).name, 'A');
  assert.equal(nearestNote(261.63).name + nearestNote(261.63).octave, 'C4');
  assert.ok(nearestNote(445).cents > 19 && nearestNote(445).cents < 20);
});
