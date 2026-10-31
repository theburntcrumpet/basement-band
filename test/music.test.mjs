import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChord, parseProgression, fillProgression, voiceChord, midiToNote, noteToMidi, scaleNotes, snapToScale, stepInScale, scaleChords, goesByFifths, chordPitches, chordNotes, guideKey, CHORD_PATTERNS, SCALE_GROUPS, SCALES, SCALE_LABELS } from '../src/music/theory.js';
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

test('every scale has a label and stays inside the octave, starting on its root', () => {
  assert.deepEqual(Object.keys(SCALE_LABELS).sort(), Object.keys(SCALES).sort());
  for (const steps of Object.values(SCALES)) {
    assert.equal(steps[0], 0);
    assert.ok(steps.every((s, i) => s < 12 && (i === 0 || s > steps[i - 1])));
  }
  assert.deepEqual(scaleNotes({ root: 9, scale: 'minorPentatonic' }), [9, 0, 2, 4, 7]);
});

test('snapping lands on the nearest scale note, inside the piano range', () => {
  const cMajor = scaleNotes({ root: 0, scale: 'major' });
  assert.equal(snapToScale(60, cMajor), 60);
  assert.equal(snapToScale(61, cMajor), 62, 'a tie goes up');
  assert.equal(snapToScale(66, cMajor), 67);
  const fSharp = scaleNotes({ root: 6, scale: 'wholeTone' });
  assert.equal(snapToScale(108, fSharp), 108);
  const bOnly = [11];
  assert.equal(snapToScale(108, bOnly), 107, 'the top of the range looks down');
  assert.equal(snapToScale(21, [0]), 24, 'the bottom of the range looks up');
});

test('stepping walks the scale and stops at the ends of the range', () => {
  const cMajor = scaleNotes({ root: 0, scale: 'major' });
  assert.equal(stepInScale(60, cMajor, 1), 62);
  assert.equal(stepInScale(64, cMajor, 1), 65);
  assert.equal(stepInScale(60, cMajor, -1), 59);
  assert.equal(stepInScale(61, cMajor, -1), 60, 'a note outside the scale moves onto it');
  assert.equal(stepInScale(108, cMajor, 1), 108);
  assert.equal(stepInScale(21, cMajor, -1), 21);
});

test('the wheel holds the chords of the scale, going round by fifths from home', () => {
  const names = key => scaleChords(key).map(c => c.name);
  assert.deepEqual(names({ root: 0, scale: 'major' }), ['C', 'G', 'Dm', 'Am', 'Em', 'Bdim', 'F']);
  assert.deepEqual(scaleChords({ root: 0, scale: 'major' }).map(c => c.numeral), ['I', 'V', 'ii', 'vi', 'iii', 'vii°', 'IV']);
  assert.deepEqual(names({ root: 9, scale: 'minor' }), ['Am', 'Em', 'Bdim', 'F', 'C', 'G', 'Dm']);
  assert.deepEqual(scaleChords({ root: 9, scale: 'minor' }).map(c => c.numeral), ['i', 'v', 'ii°', 'bVI', 'bIII', 'bVII', 'iv']);
  assert.ok(names({ root: 9, scale: 'harmonicMinor' }).includes('Caug'), 'the raised seventh makes the third chord augmented');
  assert.ok(names({ root: 9, scale: 'harmonicMinor' }).includes('E'), 'and the fifth chord major');
});

test('every scale on every root gets chords made only of its own notes', () => {
  for (const scale of Object.keys(SCALES)) {
    for (let root = 0; root < 12; root++) {
      const pcs = scaleNotes({ root, scale });
      const chords = scaleChords({ root, scale });
      assert.ok(chords.length >= 3, `${root} ${scale} has ${chords.length} chords`);
      assert.equal(chords[0].root, root, 'home comes first');
      assert.equal(new Set(chords.map(c => c.name)).size, chords.length);
      for (const c of chords) assert.ok(c.intervals.every(i => pcs.includes((c.root + i) % 12)), `${c.name} in ${root} ${scale}`);
    }
  }
  assert.deepEqual(scaleChords({ root: 0, scale: 'wholeTone' }).map(c => c.quality), Array(6).fill('aug'));
});

test('a chord sits by the row it is drawn on and stays on the piano', () => {
  const [am] = scaleChords({ root: 9, scale: 'minor' });
  assert.deepEqual(chordPitches(am, 60), [57, 60, 64]);
  assert.deepEqual(chordPitches(am, 66), [69, 72, 76]);
  assert.ok(chordPitches(am, 108).every(n => n <= 108));
  assert.ok(chordPitches(am, 21).every(n => n >= 21));
});

test('chord notes fill the span as a block or an arpeggio', () => {
  const p = [60, 64, 67];
  assert.deepEqual(chordNotes(p, { span: 4 }).map(n => [n.t, n.d, n.n]), [[0, 4, 60], [0, 4, 64], [0, 4, 67]]);
  const pitches = style => chordNotes(p, { style, span: 2, step: 0.5 }).map(n => n.n);
  assert.deepEqual(pitches('up'), [60, 64, 67, 60]);
  assert.deepEqual(pitches('down'), [67, 64, 60, 67]);
  assert.deepEqual(chordNotes(p, { style: 'updown', span: 3, step: 0.5 }).map(n => n.n), [60, 64, 67, 64, 60, 64]);
  const last = chordNotes(p, { style: 'up', span: 1.25, step: 0.5 }).pop();
  assert.equal(last.t + last.d, 1.25, 'the last note stops at the end of the span');
});

test('the wheel follows the piano roll scale, and the song key when the highlight is off', () => {
  const key = { root: 2, scale: 'minor' };
  assert.deepEqual(guideKey({ key }), key);
  assert.deepEqual(guideKey({ key, scaleGuide: { scale: 'dorian', root: 4 } }), { root: 4, scale: 'dorian' });
  assert.equal(guideKey({ key, scaleGuide: { scale: 'off' } }), null);
  assert.deepEqual(guideKey({ key, scaleGuide: { scale: 'song', root: 4 } }), key);
});

test('sevenths and ninths stack up from the scale and are named for what they are', () => {
  const names = (key, size) => scaleChords(key, size).map(c => c.name);
  const cMajor = { root: 0, scale: 'major' };
  assert.deepEqual(names(cMajor, 4), ['Cmaj7', 'G7', 'Dm7', 'Am7', 'Em7', 'Bm7b5', 'Fmaj7']);
  assert.deepEqual(names(cMajor, 5), ['Cmaj9', 'G9', 'Dm9', 'Am9', 'Em7(b9)', 'Bm7b5(b9)', 'Fmaj9']);
  const aHarmonic = names({ root: 9, scale: 'harmonicMinor' }, 4);
  for (const chord of ['AmMaj7', 'E7', 'Abdim7', 'CaugMaj7']) assert.ok(aHarmonic.includes(chord), `${chord} in ${aHarmonic}`);
  assert.ok(names({ root: 0, scale: 'majorPentatonic' }, 4).includes('C6'), 'a pentatonic has a sixth, not a seventh');
  assert.ok(names({ root: 9, scale: 'blues' }, 4).includes('Am7'));
});

test('bigger chords on every scale stay inside it, in order and on the piano', () => {
  for (const scale of Object.keys(SCALES)) {
    for (let root = 0; root < 12; root++) {
      for (const size of [4, 5]) {
        const pcs = scaleNotes({ root, scale });
        const chords = scaleChords({ root, scale }, size);
        assert.equal(new Set(chords.map(c => c.name)).size, chords.length, `${root} ${scale} ${size}`);
        for (const c of chords) {
          assert.ok(c.intervals.length <= size);
          assert.ok(c.intervals.every((iv, i) => pcs.includes((c.root + iv) % 12) && (i === 0 || iv > c.intervals[i - 1])), `${c.name} in ${root} ${scale}`);
          assert.ok(chordPitches(c, 108).every(n => n <= 108), c.name);
          assert.ok(chordPitches(c, 21).every(n => n >= 21), c.name);
        }
      }
    }
  }
});

test('rhythms repeat each bar, hold where they say, and stop at the end of the span', () => {
  const p = [60, 64, 67];
  const hits = (style, opts) => chordNotes(p, { style, span: 4, ...opts });
  const quarters = hits('quarters');
  assert.deepEqual([...new Set(quarters.map(n => n.t))], [0, 1, 2, 3]);
  assert.equal(quarters.length, 12, 'every note of the chord on every beat');
  assert.ok(quarters.every(n => Math.abs(n.d - 0.45) < 1e-9), 'a hit and its hold');
  assert.deepEqual([...new Set(hits('offbeat').map(n => n.t))], [0.5, 1.5, 2.5, 3.5]);
  // Oom-pah: the root an octave down, then the chord.
  const oom = hits('oompah');
  assert.deepEqual(oom.filter(n => n.t === 0).map(n => n.n), [48]);
  assert.deepEqual(oom.filter(n => n.t === 1).map(n => n.n), p);
  // Strong hits are louder than soft ones.
  assert.ok(quarters.find(n => n.t === 0).v > quarters.find(n => n.t === 1).v);
  // Two bars is the first bar twice.
  const one = chordNotes(p, { style: 'pop', span: 4 }), two = chordNotes(p, { style: 'pop', span: 8 });
  assert.equal(two.length, one.length * 2);
  assert.deepEqual(two.filter(n => n.t >= 4).map(n => [n.t - 4, n.n]), one.map(n => [n.t, n.n]));
  // A short span cuts the last hit; a 3/4 bar repeats after three beats.
  for (const pattern of CHORD_PATTERNS.filter(q => q.steps)) {
    for (const opts of [{ span: 1.3 }, { span: 7 }, { span: 6, bar: 3 }, { span: 3.5, bar: 3.5 }]) {
      const notes = chordNotes(p, { style: pattern.id, ...opts });
      assert.ok(notes.length, pattern.id);
      assert.ok(notes.every(n => n.d > 0 && n.t >= 0 && n.t + n.d <= opts.span + 1e-9), `${pattern.id} ${JSON.stringify(opts)}`);
    }
  }
  assert.deepEqual([...new Set(chordNotes(p, { style: 'quarters', span: 6, bar: 3 }).map(n => n.t))], [0, 1, 2, 3, 4, 5]);
});

test('every scale is in exactly one menu group, and all have a different set of notes', () => {
  const grouped = SCALE_GROUPS.flatMap(([, ids]) => ids);
  assert.deepEqual([...grouped].sort(), Object.keys(SCALES).sort());
  assert.equal(new Set(grouped).size, grouped.length);
  assert.equal(new Set(Object.values(SCALES).map(s => s.join())).size, grouped.length, 'two names for the same scale');
});

test('the new scales hold the notes they should', () => {
  const notes = (root, scale) => scaleNotes({ root, scale }).map(pc => midiToNote(pc + 60).slice(0, -1)).join(' ');
  assert.equal(notes(4, 'phrygianDominant'), 'E F G# A B C D');
  assert.equal(notes(9, 'hungarianMinor'), 'A B C D# E F G#');
  assert.equal(notes(0, 'doubleHarmonic'), 'C C# E F G G# B');
  assert.equal(notes(7, 'lydianDominant'), 'G A B C# D E F');
  assert.equal(notes(0, 'altered'), 'C C# D# E F# G# A#');
  assert.equal(notes(0, 'bebopDominant'), 'C D E F G A A# B');
  assert.equal(notes(0, 'halfWhole'), 'C C# D# E F# G A A#');
  assert.equal(notes(4, 'hirajoshi'), 'E F# G B C');
  assert.equal(notes(0, 'majorBlues'), 'C D D# E G A');
});

test('only scales with a chord on all seven notes go round by fifths', () => {
  const aMinor = { root: 9, scale: 'minor' };
  assert.ok(goesByFifths(aMinor, scaleChords(aMinor)));
  const bebop = { root: 0, scale: 'bebopDominant' };
  const chords = scaleChords(bebop);
  assert.ok(!goesByFifths(bebop, chords));
  const steps = chords.map(c => (c.root + 12) % 12);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'other scales go in scale order');
});
