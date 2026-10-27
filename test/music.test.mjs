import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChord, parseProgression, fillProgression, voiceChord, midiToNote, noteToMidi } from '../src/music/theory.js';
import { STYLES, PARTS, generate } from '../src/music/band.js';

const C = { root: 0, scale: 'major' };

test('note names round-trip', () => {
  assert.equal(midiToNote(60), 'C4');
  assert.equal(noteToMidi('A4'), 69);
  assert.equal(noteToMidi('As1'), 34);
  assert.equal(noteToMidi('Db3'), 49);
});

test('chord symbols and roman numerals', () => {
  assert.deepEqual(parseChord('Am7').intervals, [0, 3, 7, 10]);
  assert.equal(parseChord('Am7').root, 9);
  assert.equal(parseChord('C/E').bass, 4);
  assert.equal(parseChord('vi', C).root, 9);
  assert.equal(parseChord('vi', C).minor, true);
  assert.equal(parseChord('bVII', { root: 2 }).root, 0);
  assert.deepEqual(parseChord('Imaj7', C).intervals, [0, 4, 7, 11]);
  assert.deepEqual(parseChord('ii7', C).intervals, [0, 3, 7, 10]);
  assert.deepEqual(parseChord('F#m7b5').intervals, [0, 3, 6, 10]);
  assert.equal(parseChord('Xyz'), null);
});

test('progressions split bars and repeat', () => {
  const p = parseProgression('C G | Am F', C);
  assert.deepEqual(p.map(x => [x.start, x.length]), [[0, 2], [2, 2], [4, 2], [6, 2]]);
  const q = parseProgression('C G Am F', C);
  assert.equal(q.length, 4);
  assert.equal(q[3].start, 12);
  assert.equal(fillProgression(q, 32).length, 8);
  assert.throws(() => parseProgression('C | Q7', C));
});

test('voicings stay in register and lead smoothly', () => {
  const a = voiceChord(parseChord('C'), null, { low: 55, high: 76, size: 4 });
  assert.ok(a.every(n => n >= 55 && n <= 76), String(a));
  const b = voiceChord(parseChord('F'), a, { low: 55, high: 76, size: 4 });
  const move = b.reduce((s, n, i) => s + Math.abs(n - a[i]), 0);
  assert.ok(move <= 8, `moved ${move}: ${a} -> ${b}`);
});

test('every style generates every part with sane notes', () => {
  for (const [id, style] of Object.entries(STYLES)) {
    for (const part of PARTS) {
      for (const complexity of [0, 0.5, 1]) {
        const notes = generate({ style: id, part, complexity, intensity: 0.6, seed: 3 }, { key: { root: 7, scale: 'major' }, bars: 8 });
        assert.ok(notes.length > 0, `${id}/${part} empty`);
        for (const n of notes) {
          assert.ok(n.t >= 0 && n.t < 32 + 0.2, `${id}/${part} t=${n.t}`);
          assert.ok(n.d > 0, `${id}/${part} d=${n.d}`);
          assert.ok(n.v > 0 && n.v <= 1, `${id}/${part} v=${n.v}`);
          assert.ok(Number.isInteger(n.n) && n.n >= 20 && n.n <= 108, `${id}/${part} n=${n.n}`);
        }
      }
    }
  }
});

test('generation is deterministic per seed', () => {
  const g = { style: 'funk', part: 'drums', complexity: 0.8, intensity: 0.5, seed: 42 };
  assert.deepEqual(generate(g, { key: C, bars: 4 }), generate(g, { key: C, bars: 4 }));
});

import { METER_GROOVES } from '../src/music/band.js';
import { meter, barBeat, TIME_SIGNATURES } from '../src/music/meter.js';

test('meter math', () => {
  assert.deepEqual([meter({ num: 6, den: 8 }).barBeats, meter({ num: 6, den: 8 }).steps], [3, 12]);
  assert.equal(meter({ num: 7, den: 8 }).barBeats, 3.5);
  assert.deepEqual(barBeat(7, { num: 3, den: 4 }), { bar: 3, beat: 2 });
  assert.deepEqual(barBeat(4, { num: 6, den: 8 }), { bar: 2, beat: 3 });
});

test('meter grooves fill exactly one bar', () => {
  for (const [label, g] of Object.entries(METER_GROOVES)) {
    const [num, den] = label.split('/').map(Number);
    const steps = meter({ num, den }).steps;
    const all = [...g.drums.flatMap(d => Object.values(d)), ...g.bass, ...g.comp, ...g.arp, g.lh];
    for (const p of all) assert.equal(p.length, steps, `${label}: "${p}"`);
  }
});

test('every style and part works in every time signature', () => {
  for (const label of TIME_SIGNATURES) {
    const [num, den] = label.split('/').map(Number);
    const timeSig = { num, den };
    const bar = meter(timeSig).barBeats;
    for (const style of Object.keys(STYLES)) {
      for (const part of PARTS) {
        const notes = generate({ style, part, complexity: 0.7, intensity: 0.6, seed: 5 }, { key: C, bars: 4, timeSig });
        assert.ok(notes.length > 0, `${label} ${style}/${part} empty`);
        for (const n of notes) assert.ok(n.t >= 0 && n.t < 4 * bar + 0.2 && n.d > 0, `${label} ${style}/${part} t=${n.t} d=${n.d}`);
        if (part === 'drums') {
          // Every bar starts with a kick (or the jazz ride) on the downbeat.
          for (let b = 0; b < 4; b++) assert.ok(notes.some(n => Math.abs(n.t - b * bar) < 0.02), `${label} ${style} bar ${b} has no downbeat`);
        }
      }
    }
  }
});

test('drummer pad axes change the beat, not just velocity', () => {
  const C4 = { root: 0, scale: 'major' }, ts = { num: 4, den: 4 };
  const drums = (style, complexity, intensity) => generate({ style, part: 'drums', complexity, intensity, seed: 11, fills: false }, { key: C4, bars: 8, timeSig: ts });
  const voices = notes => new Set(notes.map(n => n.n));
  for (const style of Object.keys(STYLES)) {
    const simple = drums(style, 0, 0.5), complex = drums(style, 1, 0.5);
    assert.ok(complex.length >= simple.length * 1.4, `${style}: complex ${complex.length} vs simple ${simple.length}`);
    // Complex players vary from bar to bar.
    const bar = b => JSON.stringify(complex.filter(n => n.t >= b * 4 - 0.01 && n.t < b * 4 + 3.99).map(n => [n.n, Math.round((n.t - b * 4) * 4)]));
    assert.ok(new Set([0, 1, 2, 3, 4, 5, 6, 7].map(bar)).size >= 4, `${style}: complex bars too repetitive`);
    if (style === 'jazz') continue;
    const soft = voices(drums(style, 0.5, 0.05)), loud = voices(drums(style, 0.5, 1));
    const differs = [...soft].some(n => !loud.has(n)) || [...loud].some(n => !soft.has(n));
    assert.ok(differs, `${style}: soft and loud use the same drums ${[...soft]} / ${[...loud]}`);
  }
});

test('extending a generated region generates the extra bars', async () => {
  // state.js needs a browser for instruments; exercise the same path through band.generate.
  const C4 = { root: 0, scale: 'major' }, ts = { num: 4, den: 4 };
  const gen = { style: 'rock', part: 'drums', complexity: 0.5, intensity: 0.6, seed: 3 };
  const four = generate(gen, { key: C4, bars: 4, timeSig: ts });
  const eight = generate(gen, { key: C4, bars: 8, timeSig: ts });
  assert.ok(eight.some(n => n.t >= 28), 'bar 8 has drums');
  // The first bars stay the same apart from the fill that moved to the new end.
  const early = notes => JSON.stringify(notes.filter(n => n.t < 8));
  assert.equal(early(eight), early(four));
});
