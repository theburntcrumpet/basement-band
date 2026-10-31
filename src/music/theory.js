// Notes, scales, chord symbols and chord progressions. Pure functions, no audio.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  majorBlues: [0, 2, 3, 4, 7, 9],
  suspendedPentatonic: [0, 2, 5, 7, 10],
  lydianDominant: [0, 2, 4, 6, 7, 9, 10],
  altered: [0, 1, 3, 4, 6, 8, 10],
  bebopDominant: [0, 2, 4, 5, 7, 9, 10, 11],
  bebopMajor: [0, 2, 4, 5, 7, 8, 9, 11],
  wholeTone: [0, 2, 4, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  halfWhole: [0, 1, 3, 4, 6, 7, 9, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  doubleHarmonic: [0, 1, 4, 5, 7, 8, 11],
  hungarianMinor: [0, 2, 3, 6, 7, 8, 11],
  neapolitanMinor: [0, 1, 3, 5, 7, 8, 11],
  neapolitanMajor: [0, 1, 3, 5, 7, 9, 11],
  persian: [0, 1, 4, 5, 6, 8, 11],
  hirajoshi: [0, 2, 3, 7, 8],
  inSen: [0, 1, 5, 7, 10],
  yo: [0, 2, 5, 7, 9],
};

export const SCALE_LABELS = {
  major: 'Major',
  minor: 'Minor',
  harmonicMinor: 'Harmonic minor',
  melodicMinor: 'Melodic minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  majorPentatonic: 'Major pentatonic',
  minorPentatonic: 'Minor pentatonic',
  blues: 'Minor blues',
  majorBlues: 'Major blues',
  suspendedPentatonic: 'Suspended pent.',
  lydianDominant: 'Lydian dominant',
  altered: 'Altered',
  bebopDominant: 'Bebop dominant',
  bebopMajor: 'Bebop major',
  wholeTone: 'Whole tone',
  diminished: 'Diminished',
  halfWhole: 'Half-whole dim.',
  phrygianDominant: 'Phrygian dominant',
  doubleHarmonic: 'Double harmonic',
  hungarianMinor: 'Hungarian minor',
  neapolitanMinor: 'Neapolitan minor',
  neapolitanMajor: 'Neapolitan major',
  persian: 'Persian',
  hirajoshi: 'Hirajoshi',
  inSen: 'In Sen',
  yo: 'Yo',
};

// How the scale menus group them.
export const SCALE_GROUPS = [
  ['Major and minor', ['major', 'minor', 'harmonicMinor', 'melodicMinor']],
  ['Modes', ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']],
  ['Pentatonic and blues', ['majorPentatonic', 'minorPentatonic', 'blues', 'majorBlues', 'suspendedPentatonic']],
  ['Jazz', ['lydianDominant', 'altered', 'bebopDominant', 'bebopMajor', 'wholeTone', 'diminished', 'halfWhole']],
  ['World', ['phrygianDominant', 'doubleHarmonic', 'hungarianMinor', 'neapolitanMinor', 'neapolitanMajor', 'persian', 'hirajoshi', 'inSen', 'yo']],
];

export function midiToNote(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function noteToMidi(name) {
  const m = /^([A-Ga-g])([#bs]*)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error('Bad note name: ' + name);
  let pc = PC[m[1].toUpperCase()];
  for (const c of m[2]) pc += c === 'b' ? -1 : 1;
  return pc + (Number(m[3]) + 1) * 12;
}

export function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export function pitchClass(name) {
  const m = /^([A-Ga-g])([#b]?)/.exec(name);
  if (!m) return null;
  let pc = PC[m[1].toUpperCase()];
  if (m[2] === '#') pc++;
  if (m[2] === 'b') pc--;
  return (pc + 12) % 12;
}

// Chord qualities as semitone intervals above the root.
const QUALITIES = [
  ['maj9', [0, 4, 7, 11, 14]],
  ['maj7', [0, 4, 7, 11]],
  ['M7', [0, 4, 7, 11]],
  ['m7b5', [0, 3, 6, 10]],
  ['madd9', [0, 3, 7, 14]],
  ['m9', [0, 3, 7, 10, 14]],
  ['m7', [0, 3, 7, 10]],
  ['m6', [0, 3, 7, 9]],
  ['min', [0, 3, 7]],
  ['dim7', [0, 3, 6, 9]],
  ['dim', [0, 3, 6]],
  ['°', [0, 3, 6]],
  ['aug', [0, 4, 8]],
  ['+', [0, 4, 8]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['sus', [0, 5, 7]],
  ['7sus4', [0, 5, 7, 10]],
  ['add9', [0, 4, 7, 14]],
  ['13', [0, 4, 7, 10, 14, 21]],
  ['11', [0, 4, 7, 10, 14, 17]],
  ['9', [0, 4, 7, 10, 14]],
  ['7', [0, 4, 7, 10]],
  ['6', [0, 4, 7, 9]],
  ['5', [0, 7]],
  ['m', [0, 3, 7]],
  ['', [0, 4, 7]],
];

function parseQuality(q) {
  for (const [name, iv] of QUALITIES) if (q === name) return iv;
  return null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Parses "Am7", "F#m7b5", "C/E", or roman numerals ("vi", "bVII", "V7/B") relative to a key.
export function parseChord(symbol, key = { root: 0, scale: 'major' }) {
  const s = symbol.trim();
  if (!s) return null;
  const [main, slash] = s.split('/');
  let root, quality, m;

  if ((m = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/.exec(main))) {
    const degree = ROMAN.indexOf(m[2].toUpperCase());
    const minor = m[2] === m[2].toLowerCase();
    const scale = SCALES.major;
    root = (key.root + scale[degree] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0) + 12) % 12;
    let rest = m[3];
    if (rest.startsWith('°') || rest.startsWith('dim')) quality = rest.startsWith('°7') || rest === 'dim7' ? 'dim7' : 'dim';
    else if (minor) quality = 'm' + rest;
    else quality = rest;
    if (quality === 'm7b5' || quality === 'mø' || quality === 'mø7') quality = 'm7b5';
  } else if ((m = /^([A-Ga-g][#b]?)(.*)$/.exec(main))) {
    root = pitchClass(m[1]);
    quality = m[2];
  } else {
    return null;
  }

  const normalized = quality === 'maj' || quality === 'M' ? '' : quality.replace(/^min(?=\d)/, 'm').replace(/^-/, 'm');
  const intervals = parseQuality(normalized);
  if (!intervals) return null;
  let bass = root;
  if (slash) {
    const b = pitchClass(slash) ?? (parseChord(slash, key)?.root);
    if (b == null) return null;
    bass = b;
  }
  return { symbol: s, root, bass, intervals, minor: intervals[1] === 3 };
}

// "C G | Am F" -> bar-separated chords; chords in one bar share it evenly.
// "%" or "-" repeats the previous chord. Returns [{start, length, chord}] in beats.
export function parseProgression(text, key, beatsPerBar = 4) {
  const bars = text.split('|').map(b => b.trim()).filter(Boolean);
  // No bar lines at all: one chord per bar.
  const groups = bars.length === 1 && !text.includes('|') ? bars[0].split(/\s+/).map(c => [c]) : bars.map(b => b.split(/\s+/));
  const out = [];
  let prev = null;
  groups.forEach((tokens, i) => {
    const len = beatsPerBar / tokens.length;
    tokens.forEach((tok, j) => {
      const chord = tok === '%' || tok === '-' ? prev : parseChord(tok, key);
      if (!chord) throw new Error(`Unknown chord "${tok}"`);
      prev = chord;
      out.push({ start: i * beatsPerBar + j * len, length: len, chord });
    });
  });
  return out;
}

// Repeats/truncates a progression to fill `totalBeats`.
export function fillProgression(prog, totalBeats) {
  if (!prog.length) return [];
  const span = prog[prog.length - 1].start + prog[prog.length - 1].length;
  const out = [];
  for (let off = 0; off < totalBeats; off += span) {
    for (const p of prog) {
      const start = off + p.start;
      if (start >= totalBeats) break;
      out.push({ ...p, start, length: Math.min(p.length, totalBeats - start) });
    }
  }
  return out;
}

export function chordAt(prog, beat) {
  for (let i = prog.length - 1; i >= 0; i--) if (prog[i].start <= beat + 1e-6) return prog[i];
  return prog[0];
}

// Picks the octave of a pitch class closest to `target` midi note.
export function nearest(pc, target) {
  const base = target - ((target - pc) % 12 + 12) % 12;
  return target - base > 6 ? base + 12 : base;
}

// A voicing of `chord` inside [low, high], led smoothly from the previous voicing.
export function voiceChord(chord, prev, { low = 52, high = 76, size = 4 } = {}) {
  const pcs = chord.intervals.map(i => (chord.root + i) % 12);
  const tones = pcs.slice(0, size);
  if (tones.length < size && pcs.length >= 3) tones.push(pcs[0]);
  const center = prev && prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : (low + high) / 2;
  let best = null, bestScore = Infinity;
  // Try each inversion stacked upward from a bottom note near the low end.
  for (let inv = 0; inv < tones.length; inv++) {
    const order = tones.slice(inv).concat(tones.slice(0, inv));
    for (let start = low; start < low + 12; start++) {
      if ((start % 12) !== order[0]) continue;
      const v = [start];
      for (let k = 1; k < order.length; k++) {
        let n = v[k - 1] + 1;
        while (n % 12 !== order[k]) n++;
        v.push(n);
      }
      if (v[v.length - 1] > high) continue;
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      let score = Math.abs(mean - center);
      if (prev && prev.length === v.length) score = v.reduce((a, n, k) => a + Math.abs(n - prev[k]), 0) / v.length;
      if (score < bestScore) { bestScore = score; best = v; }
    }
  }
  return best || pcs.map(pc => nearest(pc, (low + high) / 2)).sort((a, b) => a - b);
}

export function scaleNotes(key) {
  return SCALES[key.scale || 'major'].map(i => (key.root + i) % 12);
}

// The scale a song's piano roll shows: its own choice, or its key. Null when switched off.
export function guideKey({ key, scaleGuide: guide }) {
  if (guide?.scale === 'off') return null;
  return SCALES[guide?.scale] ? { root: guide.root, scale: guide.scale } : key;
}

// Tried in order on each scale note: the first whose notes all belong to the scale is its chord.
const CHORD_SHAPES = [
  { suffix: '', intervals: [0, 4, 7], quality: 'major' },
  { suffix: 'm', intervals: [0, 3, 7], quality: 'minor' },
  { suffix: 'dim', intervals: [0, 3, 6], quality: 'dim', mark: '°' },
  { suffix: 'aug', intervals: [0, 4, 8], quality: 'aug', mark: '+' },
  { suffix: 'sus4', intervals: [0, 5, 7], quality: 'sus' },
  { suffix: 'sus2', intervals: [0, 2, 7], quality: 'sus' },
  { suffix: '5', intervals: [0, 7], quality: 'power' },
];
// What a seventh or ninth on top of each triad is called.
const SEVENTHS = {
  major: { 11: 'maj7', 10: '7', 9: '6' },
  minor: { 11: 'mMaj7', 10: 'm7', 9: 'm6' },
  dim: { 10: 'm7b5', 9: 'dim7' },
  aug: { 11: 'augMaj7', 10: 'aug7' },
  sus: { 11: 'maj7', 10: '7' },
};
const NINTHS = { maj7: 'maj9', 7: '9', m7: 'm9', mMaj7: 'mMaj9', 6: '6/9', m6: 'm6/9' };
const NUMERALS = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
// Scale degrees going round by fifths, starting from the home chord.
const FIFTHS_ORDER = [0, 4, 1, 5, 2, 6, 3];

// Adds the seventh (and ninth) the scale offers to a triad, as far as `size` notes.
function extendChord(shape, pcs, root, size) {
  const has = i => pcs.includes((root + i) % 12);
  const names = SEVENTHS[shape.quality];
  let { intervals, suffix } = shape;
  if (size < 4 || !names) return { intervals, suffix };
  const seventh = [11, 10, 9].find(i => has(i) && names[i]);
  if (seventh == null) return { intervals, suffix };
  const name = names[seventh];
  intervals = [...intervals, seventh];
  // sus chords name the suspension after the seventh: G7sus4.
  suffix = shape.quality === 'sus' ? name + suffix : name;
  if (size < 5) return { intervals, suffix };
  const ninth = [14, 13, 15].find(has);
  if (ninth == null) return { intervals, suffix };
  intervals = [...intervals, ninth];
  suffix = ninth === 14 && NINTHS[name] && shape.quality !== 'sus' ? NINTHS[name] : `${suffix}(${{ 14: '9', 13: 'b9', 15: '#9' }[ninth]})`;
  return { intervals, suffix };
}

// The chords a scale contains, ready to lay out on the wheel. `size` asks for that many notes in each
// (3 triads, 4 sevenths, 5 ninths), as far as the scale allows; scale notes with no chord are left out.
export function scaleChords(key, size = 3) {
  const pcs = scaleNotes(key);
  const chords = [];
  for (const step of SCALES[key.scale || 'major']) {
    const root = (key.root + step) % 12;
    const shape = CHORD_SHAPES.find(s => s.intervals.every(i => pcs.includes((root + i) % 12)));
    if (!shape) continue;
    const lower = shape.quality === 'minor' || shape.quality === 'dim';
    const { intervals, suffix } = extendChord(shape, pcs, root, size);
    chords.push({
      root,
      intervals,
      quality: shape.quality,
      name: KEY_NAMES[root] + suffix,
      numeral: (lower ? NUMERALS[step].replace(/[IV]+/, m => m.toLowerCase()) : NUMERALS[step]) + (shape.mark || ''),
    });
  }
  return goesByFifths(key, chords) ? FIFTHS_ORDER.map(i => chords[i]) : chords;
}

// Only a seven-note scale with a chord on every note can go round the wheel by fifths.
export function goesByFifths(key, chords) {
  return SCALES[key.scale || 'major'].length === 7 && chords.length === 7;
}

// The chord's notes with its root as close to `target` as the piano's range allows.
export function chordPitches(chord, target, low = 21, high = 108) {
  let root = nearest(chord.root, target);
  while (root + chord.intervals[chord.intervals.length - 1] > high) root -= 12;
  while (root < low) root += 12;
  return chord.intervals.map(i => root + i);
}

// The ways a chord can be drawn. Rhythms are a 4/4 bar of 16ths: C a strong chord, c a soft one, b the
// root an octave down, - holds the last hit, . is a rest. Other bar lengths use the bar's first part.
export const ARPEGGIOS = ['up', 'down', 'updown'];
export const CHORD_PATTERNS = [
  { id: 'block', label: 'Held chord' },
  { id: 'quarters', group: 'Rhythm', label: 'Steady beats', steps: 'C-..c-..C-..c-..' },
  { id: 'eighths', group: 'Rhythm', label: 'Driving eighths', steps: 'C.c.c.c.C.c.c.c.' },
  { id: 'pop', group: 'Rhythm', label: 'Pop pulse', steps: 'C--c--c-C--c--c-' },
  { id: 'ballad', group: 'Rhythm', label: 'Ballad', steps: 'b---c---c---c---' },
  { id: 'oompah', group: 'Rhythm', label: 'Oom-pah', steps: 'b-..c-..b-..c-..' },
  { id: 'offbeat', group: 'Rhythm', label: 'Off-beats', steps: '..c...c...c...c.' },
  { id: 'syncopated', group: 'Rhythm', label: 'Syncopated', steps: 'C--c--c---c-c---' },
  { id: 'funk', group: 'Rhythm', label: 'Funk stabs', steps: 'C.c..c.cC..c.c..' },
  { id: 'up', group: 'Arpeggio', label: 'Up' },
  { id: 'down', group: 'Arpeggio', label: 'Down' },
  { id: 'updown', group: 'Arpeggio', label: 'Up and down' },
];
const STEP = 0.25, GATE = 0.9;

// One bar of a rhythm after another across `span`, cut off at the end of it.
function rhythmNotes(pitches, steps, span, bar) {
  const count = Math.min(steps.length, Math.round(bar / STEP));
  const low = pitches[0] >= 33 ? pitches[0] - 12 : pitches[0];
  const notes = [];
  for (let at = 0; at < span - 1e-6; at += bar) {
    for (let i = 0; i < count; i++) {
      const hit = steps[i];
      if (hit !== 'C' && hit !== 'c' && hit !== 'b') continue;
      const t = at + i * STEP;
      if (t >= span - 1e-6) break;
      let hold = 1;
      while (i + hold < count && steps[i + hold] === '-') hold++;
      const d = Math.min(hold * STEP * GATE, span - t);
      if (hit === 'b') notes.push({ t, d, n: low, v: 0.85 });
      else for (const n of pitches) notes.push({ t, d, n, v: hit === 'C' ? 0.85 : 0.68 });
    }
  }
  return notes;
}

// Notes (beats from 0) playing the pitches across `span`: held, in a rhythm, or one at a time every `step`.
export function chordNotes(pitches, { style = 'block', span, step = 0.5, velocity = 0.8, bar = 4 }) {
  if (style === 'block') return pitches.map(n => ({ t: 0, d: span, n, v: velocity }));
  const rhythm = CHORD_PATTERNS.find(p => p.id === style)?.steps;
  if (rhythm) return rhythmNotes(pitches, rhythm, span, bar);
  const order = style === 'down' ? [...pitches].reverse()
    : style === 'updown' ? [...pitches, ...pitches.slice(1, -1).reverse()]
      : pitches;
  const notes = [];
  for (let i = 0; i * step < span - 1e-6; i++) {
    notes.push({ t: i * step, d: Math.min(step, span - i * step), n: order[i % order.length], v: velocity });
  }
  return notes;
}

// The scale note closest to `midi` inside the piano's range (a tie goes up).
export function snapToScale(midi, pcs, low = 21, high = 108) {
  for (let d = 0; d < 12; d++) {
    for (const n of [midi + d, midi - d]) {
      if (n >= low && n <= high && pcs.includes(n % 12)) return n;
    }
  }
  return midi;
}

// The next scale note up (dir 1) or down (dir -1), or `midi` if there is none in range.
export function stepInScale(midi, pcs, dir, low = 21, high = 108) {
  for (let n = midi + dir; n >= low && n <= high; n += dir) if (pcs.includes(n % 12)) return n;
  return midi;
}
