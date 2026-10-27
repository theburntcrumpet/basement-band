// Notes, scales, chord symbols and chord progressions. Pure functions, no audio.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

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
