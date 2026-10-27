// The session band: style definitions and generators for drums, bass, keys, guitar, pads and arps.
// Patterns sit on a 16th-note grid (16 steps per 4/4 bar, 12 per 3/4 or 6/8, ...).
// Generated notes are {t, d, n, v} with t/d in quarter-note beats.

import { parseProgression, fillProgression, chordAt, voiceChord, nearest } from './theory.js';
import { meter } from './meter.js';

export const DRUM = {
  KICK: 36, STICK: 37, SNARE: 38, CLAP: 39, RIM: 40, FLOOR_TOM: 41, HAT: 42, PEDAL_HAT: 44,
  LOW_TOM: 45, OPEN_HAT: 46, HIGH_TOM: 48, CRASH: 49, RIDE: 51, RIDE_BELL: 53, SPLASH: 55,
  COWBELL: 56, CONGA: 63, SHAKER: 70, CLAVE: 75,
};

export const DRUM_NAMES = {
  36: 'Kick', 37: 'Side Stick', 38: 'Snare', 39: 'Clap', 40: 'Rimshot', 41: 'Floor Tom', 42: 'Hi-Hat',
  44: 'Pedal Hat', 45: 'Low Tom', 46: 'Open Hat', 48: 'High Tom', 49: 'Crash', 51: 'Ride', 53: 'Ride Bell',
  55: 'Splash', 56: 'Cowbell', 63: 'Conga', 70: 'Shaker', 75: 'Clave',
};

export const PARTS = ['drums', 'bass', 'keys', 'guitar', 'pad', 'arp'];
export const PART_LABELS = { drums: 'Drums', bass: 'Bass', keys: 'Keys', guitar: 'Guitar', pad: 'Pad', arp: 'Arp' };

// Pattern alphabet (one char per 16th):
//   uppercase = accent, lowercase = normal, 'o'/'m' = ghost/muted, '-' = tie, '.' = rest
//   bass:   R root, 5 fifth, 8 octave, 3 third, 7 seventh, A approach to next chord
//   chords: C chord, D/U down/up strum, b bass note, a/A arpeggio step
// Lists hold variants from simple to busy; complexity picks among them.
export const STYLES = {
  pop: {
    name: 'Pop', bpm: 108, progression: 'I | V | vi | IV', swing: 0,
    parts: ['drums', 'bass', 'keys', 'guitar'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: false,
      grooves: [
        { 36: 'X.......X.......', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.......X.x.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.....x.X.x.....', 38: '....X..o....X...', 42: 'x.xox.xox.xox.xo' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.85, patterns: ['R.......R.......', 'R.......R...R.5.', 'R.R.R.R.R.R.R.RA'] },
    keys: { instrument: 'grand-piano', register: [55, 76], size: 4, gate: 0.95, patterns: ['C-------c-------', 'C---c---C---c---', 'C..c..c.C..c..c.'], lh: 'b-------b-------' },
    guitar: { instrument: 'acoustic-guitar', register: [43, 69], size: 6, gate: 0.9, patterns: ['D-------D-------', 'D...D.U...U.D.U.', 'D.D.D.UDU.UDD.UD'] },
    pad: { instrument: 'strings', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'pluck', register: [60, 84], patterns: ['a.a.a.a.a.a.a.a.'] },
  },
  rock: {
    name: 'Rock', bpm: 124, progression: 'I | bVII | IV | I', swing: 0,
    parts: ['drums', 'bass', 'guitar', 'keys'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: true,
      grooves: [
        { 36: 'X.......X.......', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.......X.X.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.x.....X.X...x.', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.8, patterns: ['R.R.R.R.R.R.R.R.', 'R.R.R.R.R.R.R.R.', 'R.RRR.R.R.RRR.8.'] },
    guitar: { instrument: 'crunch-guitar', power: true, register: [40, 64], size: 3, gate: 0.85, patterns: ['D-------D-------', 'D.m.m.m.D.m.m.m.', 'D.m.m.D.m.m.D.m.'] },
    keys: { instrument: 'tonewheel-organ', register: [55, 76], size: 4, gate: 1, patterns: ['----------------'] },
    pad: { instrument: 'warm-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'saw-lead', register: [60, 84], patterns: ['a.a.a.a.a.a.a.a.'] },
  },
  funk: {
    name: 'Funk', bpm: 100, progression: 'I7 | % | IV7 | %', swing: 0.15,
    parts: ['drums', 'bass', 'keys', 'guitar'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: false,
      grooves: [
        { 36: 'X.....x...X.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.....x...X..x..', 38: '....X..o.o..X..o', 42: 'xoxoxoxoxoxoxoxo' },
        { 36: 'X.x...x...X..x..', 38: '.o..X..o.o.oX..o', 42: 'xoxoxoxox.xoxoxo', 46: '.........x......' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.6, patterns: ['R.....R...R.....', 'R..8..R.5.R...7.', 'R..8..R.5.R8..A.'] },
    keys: { instrument: 'clav', register: [55, 72], size: 3, gate: 0.4, patterns: ['..c...c...c...c.', '..c..c.c..c..c.c', 'C.c..c.c.cc..c.c'] },
    guitar: { instrument: 'clean-guitar', register: [52, 72], size: 3, gate: 0.35, patterns: ['....C.......C...', 'm.m.C.m.m.m.C.m.', 'mmm.Cmm.mmm.Cmmm'] },
    pad: { instrument: 'warm-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'square-lead', register: [60, 84], patterns: ['a.a.a.a.a.a.a.a.'] },
  },
  lofi: {
    name: 'Lo-Fi', bpm: 78, progression: 'IVmaj7 | iii7 | ii7 | Imaj7', swing: 0.55,
    parts: ['drums', 'bass', 'keys'],
    drums: {
      kit: 'kit-lofi', fill: 'none', ride: false,
      grooves: [
        { 36: 'X.........X.....', 38: '....X.......X...', 42: 'x.o.x.o.x.o.x.o.' },
        { 36: 'X.........X..x..', 38: '....X.......X...', 42: 'x.oox.o.x.oox.o.' },
        { 36: 'X..x......X..x..', 38: '....X.......X..o', 42: 'x.oox.oox.oox.oo', 70: '..x...x...x...x.' },
      ],
    },
    bass: { instrument: 'sub-bass', gate: 0.95, patterns: ['R-------R-------', 'R-----..R---5---', 'R-----.RR---5-8-'] },
    keys: { instrument: 'electric-piano', register: [53, 74], size: 4, gate: 0.95, patterns: ['C---------------', 'C-----.c-----...', '.C----.c-----c--'] },
    guitar: { instrument: 'nylon-guitar', register: [48, 72], size: 4, gate: 1, patterns: ['a.a.a.a.a.a.a.a.'] },
    pad: { instrument: 'glass-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'bells', register: [64, 88], patterns: ['a...a...a...a...', 'a..a..a.a..a..a.'] },
  },
  jazz: {
    name: 'Jazz Trio', bpm: 132, progression: 'ii7 | V7 | Imaj7 | VI7', swing: 1, swingUnit: 8,
    parts: ['drums', 'bass', 'keys'],
    drums: {
      kit: 'kit-rock', fill: 'jazz', ride: false, quiet: 0.75,
      grooves: [
        { 51: 'X...X.x.X...X.x.', 44: '....x.......x...', 36: 'o...o...o...o...' },
        { 51: 'X...X.x.X...X.x.', 44: '....x.......x...', 36: 'o...o...o...o...', 38: '......o.......o.' },
        { 51: 'X...X.x.X...X.x.', 44: '....x.......x...', 36: 'o.......o.....o.', 38: '..o...o...o...o.' },
      ],
    },
    bass: { instrument: 'upright-bass', gate: 0.9, walk: true, patterns: ['W'] },
    keys: { instrument: 'grand-piano', register: [52, 70], size: 4, gate: 0.6, patterns: ['C.....c.........', '...c.....c......', 'C.....c.....c...', '..c...c.......c.'] },
    guitar: { instrument: 'clean-guitar', register: [50, 70], size: 4, gate: 0.5, patterns: ['C...c...C...c...'] },
    pad: { instrument: 'strings', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'vibes', register: [60, 84], patterns: ['a...a...a...a...'] },
  },
  house: {
    name: 'House', bpm: 124, progression: 'vi | IV | I | V', swing: 0,
    parts: ['drums', 'bass', 'pad', 'arp'],
    drums: {
      kit: 'kit-808', fill: 'elec', ride: false,
      grooves: [
        { 36: 'X...X...X...X...', 39: '....X.......X...', 46: '..x...x...x...x.' },
        { 36: 'X...X...X...X...', 39: '....X.......X...', 46: '..x...x...x...x.', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X...X...X...X...', 39: '....X.......X..o', 46: '..x...x...x...x.', 42: 'xxx.xxx.xxx.xxx.', 70: 'xoxoxoxoxoxoxoxo' },
      ],
    },
    bass: { instrument: 'synth-bass', gate: 0.5, patterns: ['..R...R...R...R.', '..R.R.R...R.R.R.', '..R.R.8...R.5.R8'] },
    keys: { instrument: 'electric-piano', register: [55, 74], size: 4, gate: 0.4, patterns: ['..C...C...C...C.'] },
    guitar: { instrument: 'clean-guitar', register: [52, 72], size: 3, gate: 0.3, patterns: ['..C...C...C...C.'] },
    pad: { instrument: 'warm-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'pluck', register: [60, 86], patterns: ['a.a.a.a.a.a.a.a.', 'aaaaaaaaaaaaaaaa'] },
  },
  ballad: {
    name: 'Ballad', bpm: 72, progression: 'I | vi | IV | V', swing: 0,
    parts: ['drums', 'bass', 'keys', 'pad'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: false, quiet: 0.7,
      grooves: [
        { 36: 'X.......X.......', 37: '....x.......x...', 42: 'o.o.o.o.o.o.o.o.' },
        { 36: 'X.......X.x.....', 37: '....x.......x...', 42: 'o.o.o.o.o.o.o.o.' },
        { 36: 'X.......X.x.....', 38: '....X.......X...', 42: 'x.o.x.o.x.o.x.o.' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.95, patterns: ['R---------------', 'R-------R---5---', 'R-------R---5-A-'] },
    keys: { instrument: 'grand-piano', register: [60, 79], size: 4, gate: 1, patterns: ['a.a.a.a.a.a.a.a.', 'a.a.a.a.a.a.a.a.'], lh: 'b-------b-------' },
    guitar: { instrument: 'nylon-guitar', register: [48, 72], size: 4, gate: 1, patterns: ['a.a.a.a.a.a.a.a.'] },
    pad: { instrument: 'strings', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'harp', register: [60, 88], patterns: ['a.a.a.a.a.a.a.a.'] },
  },
  reggae: {
    name: 'Reggae', bpm: 76, progression: 'I | IV | I | V', swing: 0.3,
    parts: ['drums', 'bass', 'guitar', 'keys'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: false,
      grooves: [
        { 36: '........X.......', 40: '........X.......', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: '........X.......', 40: '........X.......', 42: 'x.xox.x.x.xox.x.' },
        { 36: '........X.......', 40: '........X.....o.', 42: 'xoxoxoxoxoxoxoxo' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.7, patterns: ['R.......5.......', '...R..R.5...3.R.', 'R..R..R.5..53.R.'] },
    guitar: { instrument: 'clean-guitar', register: [55, 72], size: 3, gate: 0.25, patterns: ['....C.......C...'] },
    keys: { instrument: 'tonewheel-organ', register: [55, 72], size: 3, gate: 0.3, patterns: ['..c...c...c...c.', '..cc..cc..cc..cc'] },
    pad: { instrument: 'warm-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'bells', register: [60, 84], patterns: ['a...a...a...a...'] },
  },
  country: {
    name: 'Country', bpm: 112, progression: 'I | IV | V | I', swing: 0.1,
    parts: ['drums', 'bass', 'guitar', 'keys'],
    drums: {
      kit: 'kit-rock', fill: 'rock', ride: false,
      grooves: [
        { 36: 'X.......X.......', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.......X.......', 38: 'o.oXo.oXo.oXo.oX', 42: '................' },
        { 36: 'X.....x.X.......', 38: 'o.oXo.oXo.oXo.oX', 42: '................', 70: 'x.x.x.x.x.x.x.x.' },
      ],
    },
    bass: { instrument: 'electric-bass', gate: 0.8, patterns: ['R.......5.......', 'R.......5.......', 'R...5...R...5.A.'] },
    guitar: { instrument: 'acoustic-guitar', register: [48, 69], size: 5, gate: 0.6, patterns: ['b...D...b...D...', 'b...D.U.b...D.U.'] },
    keys: { instrument: 'grand-piano', register: [60, 79], size: 3, gate: 0.5, patterns: ['..c...c...c...c.'] },
    pad: { instrument: 'harmonium', register: [55, 76], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'harp', register: [60, 84], patterns: ['a.a.a.a.a.a.a.a.'] },
  },
  synthwave: {
    name: 'Synthwave', bpm: 100, progression: 'vi | IV | I | V', swing: 0,
    parts: ['drums', 'bass', 'pad', 'arp'],
    drums: {
      kit: 'kit-electro', fill: 'elec', ride: false,
      grooves: [
        { 36: 'X.......X.......', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.......X.X.....', 38: '....X.......X...', 42: 'x.x.x.x.x.x.x.x.' },
        { 36: 'X.......X.X.....', 38: '....X.......X...', 42: 'xxxxxxxxxxxxxxxx' },
      ],
    },
    bass: { instrument: 'synth-bass', gate: 0.7, patterns: ['R.R.R.R.R.R.R.R.', 'R.R.R.R.R.R.R.R.', 'R.8.R.8.R.8.R.8.'] },
    keys: { instrument: 'electric-piano', register: [55, 74], size: 4, gate: 0.9, patterns: ['C-------C-------'] },
    guitar: { instrument: 'clean-guitar', register: [52, 72], size: 4, gate: 0.4, patterns: ['C.......C.......'] },
    pad: { instrument: 'glass-pad', register: [55, 79], size: 4, patterns: ['----------------'] },
    arp: { instrument: 'saw-lead', register: [60, 84], patterns: ['a.a.a.a.a.a.a.a.', 'aaaaaaaaaaaaaaaa'] },
  },
};

// Grooves for meters other than 4/4. Styles keep their own sound, kit voices and feel;
// these supply where the beats fall. Drum keys use 38 for the backbeat and 42 for timekeeping,
// which adaptGroove() swaps for each style's own voices (rimshot, clap, ride...).
export const METER_GROOVES = {
  '2/4': {
    drums: [
      { 36: 'X.......', 38: '....X...', 42: 'x.x.x.x.' },
      { 36: 'X.....x.', 38: '....X...', 42: 'x.x.x.x.' },
      { 36: 'X.x...x.', 38: '....X..o', 42: 'xoxoxoxo' },
    ],
    bass: ['R.......', 'R...5...', 'R.R.5.5A'],
    comp: ['....C...', '..c...c.', 'C.c.C.c.'],
    arp: ['a.a.a.a.'],
    lh: 'b...b...',
  },
  '3/4': {
    drums: [
      { 36: 'X...........', 38: '....x...x...', 42: 'x...x...x...' },
      { 36: 'X.......x...', 38: '....X.......', 42: 'x.x.x.x.x.x.' },
      { 36: 'X.....x...x.', 38: '....X..o..o.', 42: 'xoxoxoxoxoxo' },
    ],
    bass: ['R...........', 'R.......5...', 'R...5...8.A.'],
    comp: ['....c...c...', 'C...c...c...', 'C..c..c.c..c'],
    arp: ['a.a.a.a.a.a.'],
    lh: 'b...........',
  },
  '5/4': {
    drums: [
      { 36: 'X...........X.......', 38: '........X.......X...', 42: 'x.x.x.x.x.x.x.x.x.x.' },
      { 36: 'X.....x.....X.......', 38: '........X.......X...', 42: 'x.x.x.x.x.x.x.x.x.x.' },
      { 36: 'X.....x.....X...x...', 38: '........X..o....X..o', 42: 'xoxoxoxoxoxoxoxoxoxo' },
    ],
    bass: ['R...........5.......', 'R.......5...R...5...', 'R...5...8...R...5.A.'],
    comp: ['C...........c.......', 'C.......c...C.......', 'C...c...c...C...c...'],
    arp: ['a.a.a.a.a.a.a.a.a.a.'],
    lh: 'b...........b.......',
  },
  '6/8': {
    drums: [
      { 36: 'X...........', 38: '......X.....', 42: 'x.x.x.x.x.x.' },
      { 36: 'X...x.......', 38: '......X.....', 42: 'x.x.x.x.x.x.' },
      { 36: 'X...x...x...', 38: '......X...o.', 42: 'x.xox.x.xox.' },
    ],
    bass: ['R.....5.....', 'R...R.5.....', 'R...R.5...A.'],
    comp: ['C.....c.....', 'C...c.c...c.', 'C.c.c.C.c.c.'],
    arp: ['a.a.a.a.a.a.'],
    lh: 'b.....b.....',
  },
  '7/8': {
    drums: [
      { 36: 'X.......X.....', 38: '....X.....X...', 42: 'x.x.x.x.x.x.x.' },
      { 36: 'X.......X.x...', 38: '....X.....X...', 42: 'x.x.x.x.x.x.x.' },
      { 36: 'X.x.....X.x...', 38: '....X..o..X.o.', 42: 'xoxoxoxoxoxoxo' },
    ],
    bass: ['R.......5.....', 'R...R...5.....', 'R...R...5...A.'],
    comp: ['C...c...c.....', 'C...c...c.c...', 'C.c.c.c.c.c.c.'],
    arp: ['a.a.a.a.a.a.a.'],
    lh: 'b.......b.....',
  },
  '9/8': {
    drums: [
      { 36: 'X...........X.....', 38: '......X...........', 42: 'x.x.x.x.x.x.x.x.x.' },
      { 36: 'X...x.......X...x.', 38: '......X...........', 42: 'x.x.x.x.x.x.x.x.x.' },
      { 36: 'X...x.......X...x.', 38: '......X...o.....o.', 42: 'x.xox.x.xox.x.xox.' },
    ],
    bass: ['R.....5.....R.....', 'R...R.5.....R...5.', 'R...R.5...5.R...A.'],
    comp: ['C.....c.....c.....', 'C...c.C...c.C...c.', 'C.c.c.C.c.c.C.c.c.'],
    arp: ['a.a.a.a.a.a.a.a.a.'],
    lh: 'b.....b.....b.....',
  },
  '12/8': {
    drums: [
      { 36: 'X...........X...........', 38: '......X...........X.....', 42: 'x.x.x.x.x.x.x.x.x.x.x.x.' },
      { 36: 'X...........X...x.......', 38: '......X...........X.....', 42: 'x.x.x.x.x.x.x.x.x.x.x.x.' },
      { 36: 'X...x.......X...x.......', 38: '......X...o.......X...o.', 42: 'x.xox.x.xox.x.xox.x.xox.' },
    ],
    bass: ['R...........5...........', 'R.....R.....5.....5.....', 'R...R.R...R.5...5.5...A.'],
    comp: ['C.....c.....C.....c.....', 'C...c.C...c.C...c.C...c.', 'C.c.c.C.c.c.C.c.c.C.c.c.'],
    arp: ['a.a.a.a.a.a.a.a.a.a.a.a.'],
    lh: 'b...........b...........',
  },
};

// Swaps the generic backbeat/timekeeper voices for the ones this style actually uses.
function adaptGroove(groove, styleDrums) {
  const first = styleDrums.grooves[0];
  const backbeat = [38, 39, 40, 37].find(k => k in first) ?? 38;
  const keeper = 42 in first ? 42 : 51 in first ? 51 : 42;
  const out = {};
  for (const [k, pat] of Object.entries(groove)) {
    const n = Number(k) === 38 ? backbeat : Number(k) === 42 ? keeper : Number(k);
    out[n] = pat;
  }
  return out;
}

// The part definition to use for a meter: the style's own in 4/4, adapted grooves otherwise.
export function partDef(style, part, ts) {
  const m = meter(ts);
  if (m.label === '4/4') return style[part];
  const g = METER_GROOVES[m.label];
  const def = style[part];
  if (!g) throw new Error(`Unsupported time signature ${m.label}`);
  if (part === 'drums') return { ...def, grooves: g.drums.map(gr => adaptGroove(gr, def)) };
  if (part === 'bass') return { ...def, walk: def.walk && m.den === 4, patterns: g.bass };
  if (part === 'pad') return { ...def, patterns: ['-'.repeat(m.steps)] };
  if (part === 'arp') return { ...def, patterns: g.arp };
  return { ...def, patterns: g.comp, lh: def.lh ? g.lh : undefined };
}

export const PROGRESSION_PRESETS = [
  ['Four chords (I V vi IV)', 'I | V | vi | IV'],
  ['Ballad (I vi IV V)', 'I | vi | IV | V'],
  ['Sad pop (vi IV I V)', 'vi | IV | I | V'],
  ['Blues (12 bar)', 'I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7'],
  ['Rock (I bVII IV I)', 'I | bVII | IV | I'],
  ['Jazz ii-V-I', 'ii7 | V7 | Imaj7 | VI7'],
  ['Lo-fi (IVmaj7 iii7 ii7 Imaj7)', 'IVmaj7 | iii7 | ii7 | Imaj7'],
  ['Pachelbel', 'I V | vi iii | IV I | IV V'],
  ['Epic (vi V IV V)', 'vi | V | IV | V'],
  ['Andalusian', 'vi | V | IV | III'],
  ['Funk vamp', 'I7 | % | IV7 | %'],
  ['50s doo-wop', 'I | vi | IV | V'],
];

// Deterministic PRNG so a region regenerates identically from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function velocityOf(ch) {
  if (ch === ch.toUpperCase() && /[A-Z]/.test(ch)) return 0.92;
  if (ch === 'o' || ch === 'm') return 0.42;
  return 0.72;
}

function swingOffset(step, style) {
  const amount = style.swing || 0;
  if (!amount) return 0;
  if (style.swingUnit === 8) return step % 4 === 2 ? amount * (1 / 6) : step % 4 === 3 ? amount * (1 / 12) : 0;
  return step % 2 === 1 ? amount * (1 / 12) : 0;
}

function pickPattern(list, complexity, bar, rand) {
  const idx = clamp(Math.round(complexity * (list.length - 1)), 0, list.length - 1);
  // Occasionally borrow the neighbouring variant so loops don't sound copy-pasted.
  if (list.length > 1 && bar % 2 === 1 && rand() < 0.35) {
    const alt = idx === list.length - 1 ? idx - 1 : idx + 1;
    return list[alt];
  }
  return list[idx];
}

function patternBar(pattern, bar, steps) {
  const bars = Math.max(1, Math.floor(pattern.length / steps));
  return pattern.slice((bar % bars) * steps, (bar % bars) * steps + steps).padEnd(steps, '.');
}

// ---------------------------------------------------------------- drums

function drumFill(kind, steps, rand, barSteps) {
  // Returns [{step, n, v}] covering the last `steps` sixteenths of a bar.
  const out = [];
  if (kind === 'none') return out;
  const start = barSteps - steps;
  if (kind === 'elec') {
    for (let s = start; s < barSteps; s++) out.push({ step: s, n: DRUM.SNARE, v: 0.45 + 0.5 * (s - start) / steps });
    return out;
  }
  const toms = [DRUM.SNARE, DRUM.HIGH_TOM, DRUM.LOW_TOM, DRUM.FLOOR_TOM];
  const every = kind === 'jazz' ? 2 : 1;
  for (let s = start, k = 0; s < barSteps; s += every, k++) {
    const stage = Math.floor((k * every * toms.length) / steps);
    let n = toms[Math.min(stage, toms.length - 1)];
    if (rand() < 0.2) n = DRUM.SNARE;
    out.push({ step: s, n, v: clamp(0.6 + 0.35 * (s - start) / steps + (rand() - 0.5) * 0.1, 0.3, 1) });
    if (kind !== 'jazz' && s === barSteps - 1 && rand() < 0.5) out.push({ step: s, n: DRUM.KICK, v: 0.8 });
  }
  return out;
}

// The Drummer. The style's groove sets the feel; the two pad axes then rearrange it per bar:
//   complexity: strips down to a bare pulse (simple) or adds ghost notes, syncopated kicks,
//               16th hats, open-hat lifts and longer, more frequent fills (complex)
//   intensity:  walks through the kit: side stick, closed hats and feathered kick (soft) up to
//               open hats or ride, crashes, rimshots and pushes into the next bar (loud)
export function generateDrums({ style, bars, complexity = 0.5, intensity = 0.5, seed = 1, fills = true, timeSig }) {
  const m = meter(timeSig);
  const def = partDef(style, 'drums', timeSig);
  const jazz = def.fill === 'jazz';
  const electronic = def.kit === 'kit-808' || def.kit === 'kit-electro';
  const rand = rng(seed);
  const notes = [];
  const C = complexity, I = intensity;
  const scale = (def.quiet || 1) * (0.55 + 0.5 * I);
  const pulse = Math.round(m.pulse * 4);              // steps per counted beat (4, or 2 in x/8)
  const phrase = C > 0.9 ? 2 : C > 0.45 ? 4 : 8;
  const first = def.grooves[0];
  const keeper = 51 in first && !(42 in first) ? DRUM.RIDE : DRUM.HAT;
  const backbeat = [38, 39, 40, 37].find(k => k in first) ?? DRUM.SNARE;

  for (let bar = 0; bar < bars; bar++) {
    const posInPhrase = bar % phrase;
    const lastOfPhrase = posInPhrase === phrase - 1 || bar === bars - 1;
    // Bars leading into a fill lean a little busier.
    const busy = Math.max(0, Math.min(1, C + (lastOfPhrase ? 0.12 : 0) + (rand() - 0.5) * 0.1));
    const groove = pickPattern(def.grooves, busy, bar, rand);
    const grid = new Map();
    for (const [key, pat] of Object.entries(groove)) grid.set(Number(key), [...patternBar(pat, bar, m.steps)]);
    const row = n => {
      if (!grid.has(n)) grid.set(n, Array(m.steps).fill('.'));
      return grid.get(n);
    };
    const hasHit = s => [...grid.values()].some(r => r[s] !== '.' && r[s] !== '-');

    // --- complexity: simplify ---
    if (C < 0.4) {
      const keepEvery = C < 0.15 ? pulse * (m.compound ? 3 : 1) : pulse;
      for (const [n, r] of grid) {
        for (let s = 0; s < m.steps; s++) {
          if (r[s] === '.' || r[s] === '-') continue;
          if (r[s] === 'o') r[s] = '.';
          // The jazz ride pattern *is* the groove; only the very simplest setting thins it.
          else if (n === keeper && (!jazz || C < 0.15)) { if (s % keepEvery) r[s] = '.'; }
          else if (n === DRUM.SHAKER || n === DRUM.OPEN_HAT) { if (s % (pulse * 2)) r[s] = '.'; }
          else if (n === DRUM.KICK && C < 0.2 && s % pulse && r[s] !== 'X') r[s] = '.';
        }
      }
    }

    // --- complexity: embellish ---
    const amount = Math.max(0, (busy - 0.35) / 0.65);
    if (amount > 0) {
      const kick = row(DRUM.KICK), snare = row(backbeat), hats = row(keeper);
      for (let s = 0; s < m.steps; s++) {
        const onBeat = s % pulse === 0;
        const eighthOff = !onBeat && s % 2 === 0;
        const sixteenth = s % 2 === 1;
        // Ghost notes on the snare between the backbeats.
        if (snare[s] === '.' && (sixteenth || eighthOff) && snare[(s + 1) % m.steps] !== 'X' && rand() < amount * 0.32) snare[s] = 'o';
        // Syncopated kicks, avoiding the backbeat.
        if (kick[s] === '.' && snare[s] !== 'X' && snare[s] !== 'x') {
          if (eighthOff && rand() < amount * 0.3) kick[s] = 'x';
          else if (sixteenth && C > 0.7 && rand() < amount * 0.12) kick[s] = 'x';
        }
        // Fill in the timekeeper's 16ths (not over the jazz ride's swing pattern).
        if (!jazz && hats[s] === '.' && sixteenth && rand() < amount * 0.55) hats[s] = 'o';
      }
      // Open-hat lift on an offbeat before a backbeat.
      if (keeper === DRUM.HAT && rand() < amount * 0.7) {
        const spots = [];
        for (let s = 2; s < m.steps; s += 2) if (s % pulse && snare[(s + 2) % m.steps] === 'X') spots.push(s);
        const s = spots[Math.floor(rand() * spots.length)];
        if (s != null) { hats[s] = '.'; row(DRUM.OPEN_HAT)[s] = 'x'; }
      }
      // Busy players add percussion colour.
      if (C > 0.8 && !jazz) {
        const perc = row(electronic ? DRUM.SHAKER : DRUM.COWBELL);
        for (let s = 0; s < m.steps; s += electronic ? 1 : pulse) if (rand() < (electronic ? 0.6 : 0.35) * amount) perc[s] = s % pulse ? 'o' : 'x';
      }
    }

    // --- intensity: choose the kit voices ---
    if (I < 0.3 && !jazz) {
      // Soft: side stick, quieter feathered kick, pedal hat on the beats.
      if (grid.has(backbeat) && backbeat === DRUM.SNARE) { grid.set(DRUM.STICK, grid.get(backbeat).map(c => (c === 'o' ? '.' : c))); grid.delete(backbeat); }
      const kick = row(DRUM.KICK);
      for (let s = 0; s < m.steps; s++) if (kick[s] !== '.' && s % pulse) kick[s] = I < 0.15 ? '.' : 'o';
      if (I < 0.15 && C < 0.5 && keeper === DRUM.HAT) { grid.set(DRUM.PEDAL_HAT, row(DRUM.HAT).map((c, s) => (c !== '.' && s % pulse === 0 ? 'x' : '.'))); grid.delete(DRUM.HAT); }
    }
    if (I > 0.65 && !jazz) {
      const loudness = (I - 0.65) / 0.35;
      // The timekeeper opens up: ride for styles that use one, washy open hats on offbeats otherwise.
      if (keeper === DRUM.HAT && grid.has(DRUM.HAT)) {
        if (def.ride && loudness > 0.3) { grid.set(DRUM.RIDE, grid.get(DRUM.HAT)); grid.delete(DRUM.HAT); }
        else {
          const hats = grid.get(DRUM.HAT), open = row(DRUM.OPEN_HAT);
          for (let s = 0; s < m.steps; s++) if (hats[s] !== '.' && s % pulse && s % 2 === 0 && rand() < loudness * 0.6) { hats[s] = '.'; open[s] = 'x'; }
        }
      }
      // Backbeat gets bigger: rimshots on acoustic kits, a clap layer on electronic ones.
      if (loudness > 0.5 && grid.has(backbeat)) {
        const bb = grid.get(backbeat);
        if (electronic) row(DRUM.CLAP).forEach((_, s, r) => { if (bb[s] === 'X') r[s] = 'X'; });
        else if (backbeat === DRUM.SNARE) { const rim = row(DRUM.RIM); bb.forEach((c, s) => { if (c === 'X') { rim[s] = 'X'; bb[s] = '.'; } }); }
      }
      // Push into the next bar with a kick on the last offbeat.
      const kick = row(DRUM.KICK);
      if (rand() < loudness * 0.7 && kick[m.steps - 2] === '.') kick[m.steps - 2] = 'x';
    }

    // --- fills ---
    const fillBar = fills && def.fill !== 'none' && bars > 1 && lastOfPhrase;
    const fillLen = C < 0.25 ? 2 : C < 0.55 ? 4 : C < 0.85 ? 6 : 8;
    const fillSteps = fillBar ? Math.min(fillLen, Math.floor(m.steps / 2)) : 0;

    for (const [n, r] of grid) {
      for (let s = 0; s < m.steps; s++) {
        const ch = r[s];
        if (ch === '.' || ch === '-') continue;
        if (fillSteps && s >= m.steps - fillSteps && n !== DRUM.KICK) continue;
        const v = clamp(velocityOf(ch) * scale + (rand() - 0.5) * 0.08, 0.06, 1);
        notes.push({ t: bar * m.barBeats + s / 4 + swingOffset(s, style) + (rand() - 0.5) * 0.008, d: 0.25, n, v });
      }
    }
    if (fillSteps) {
      // Soft fills stay on the snare; loud ones travel round the toms.
      const kind = I < 0.3 && def.fill === 'rock' ? 'elec' : def.fill;
      for (const f of drumFill(kind, fillSteps, rand, m.steps)) {
        notes.push({ t: bar * m.barBeats + f.step / 4 + swingOffset(f.step, style), d: 0.25, n: f.n, v: clamp(f.v * scale, 0.1, 1) });
      }
    }
    // Cymbal on the downbeat after a fill; loud players crash more often.
    const afterFill = bar > 0 && fills && def.fill !== 'none' && posInPhrase === 0;
    const everyOther = I > 0.85 && bar % 2 === 0;
    if ((afterFill && I > 0.3) || (bar === 0 && I > 0.6) || (everyOther && bar > 0)) {
      notes.push({ t: bar * m.barBeats, d: 0.25, n: jazz ? DRUM.RIDE_BELL : DRUM.CRASH, v: clamp(0.85 * scale, 0.3, 1) });
    }
    if (!hasHit(0) && !notes.some(n => Math.abs(n.t - bar * m.barBeats) < 1e-6)) {
      notes.push({ t: bar * m.barBeats, d: 0.25, n: DRUM.KICK, v: clamp(0.7 * scale, 0.2, 1) });
    }
  }
  return notes.map(n => ({ ...n, t: Math.max(0, n.t) })).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- bass

function chordTone(chord, ch, low) {
  const root = nearest(chord.bass, low + 6);
  const r = root < low ? root + 12 : root;
  switch (ch.toUpperCase()) {
    case '5': return r + 7;
    case '8': return r + 12;
    case '3': return r + chord.intervals[1];
    case '7': return r + (chord.intervals[3] ?? 10);
    default: return r;
  }
}

function walkingBass(chords, bars, rand, low, barBeats) {
  const notes = [];
  const total = Math.round(bars * barBeats);
  for (let beat = 0; beat < total; beat++) {
    const cur = chordAt(chords, beat);
    const next = chordAt(chords, beat + 1);
    const root = chordTone(cur.chord, 'R', low);
    let n;
    const pos = beat - cur.start;
    if (pos === 0) n = root;
    else if (next !== cur || beat === total - 1) {
      const target = chordTone(next.chord, 'R', low);
      n = target + (rand() < 0.5 ? -1 : 1);
    } else {
      const tones = cur.chord.intervals.slice(1, 4).map(i => root + i);
      n = tones[Math.floor(rand() * tones.length)];
      if (n > low + 19) n -= 12;
    }
    notes.push({ t: beat, d: 0.9, n, v: clamp(0.7 + (rand() - 0.5) * 0.15 + (pos === 0 ? 0.12 : 0), 0.3, 1) });
  }
  return notes;
}

// ---------------------------------------------------------------- comping (keys, guitar, pad, arp, bass)

// Turns patterns into onsets with lengths, splitting at chord changes.
function rhythmEvents(patterns, chords, bars, complexity, rand, m) {
  const events = [];
  let open = null;
  for (let bar = 0; bar < bars; bar++) {
    const line = patternBar(pickPattern(patterns, complexity, bar, rand), bar, m.steps);
    for (let s = 0; s < m.steps; s++) {
      const beat = bar * m.barBeats + s / 4;
      const ch = line[s];
      const cur = chordAt(chords, beat);
      const changed = open && cur !== open.chordRef;
      if (ch === '.') { open = null; continue; }
      if (ch === '-' && open && !changed) { open.len += 1; continue; }
      const char = ch === '-' ? (open ? (open.char === 'a' ? 'a' : open.char.toLowerCase()) : 'C') : ch;
      open = { bar, step: s, beat, len: 1, char, chordRef: cur };
      events.push(open);
    }
  }
  return events;
}

function powerChord(chord, low) {
  const r = nearest(chord.bass, low + 5);
  const root = r < low ? r + 12 : r;
  return [root, root + 7, root + 12];
}

export function generateBass({ style, chords, bars, complexity = 0.5, intensity = 0.5, seed = 1, timeSig }) {
  const m = meter(timeSig);
  const def = partDef(style, 'bass', timeSig);
  const rand = rng(seed + 7);
  const low = def.low || 28;
  if (def.walk) return walkingBass(chords, bars, rand, low, m.barBeats);
  const loud = 0.75 + 0.3 * intensity;
  const events = rhythmEvents(def.patterns, chords, bars, complexity, rand, m);
  return events.map((e, i) => {
    let n;
    if (e.char.toUpperCase() === 'A') {
      const nextChord = chordAt(chords, e.beat + 0.5).chord;
      n = chordTone(nextChord, 'R', low) - 1;
    } else {
      n = chordTone(e.chordRef.chord, /^[R5837]$/i.test(e.char) ? e.char : 'R', low);
    }
    const next = events[i + 1];
    const maxLen = next ? (next.beat - e.beat) : e.len / 4;
    return {
      t: e.beat + swingOffset(e.step, style),
      d: Math.max(0.1, Math.min(e.len / 4, maxLen) * def.gate),
      n,
      v: clamp(velocityOf(e.char) * loud + (rand() - 0.5) * 0.08, 0.2, 1),
    };
  });
}

export function generateChords({ style, part, chords, bars, complexity = 0.5, intensity = 0.5, seed = 1, timeSig }) {
  const m = meter(timeSig);
  const def = partDef(style, part, timeSig);
  const rand = rng(seed + PARTS.indexOf(part) * 101);
  const [low, high] = def.register || [55, 76];
  const loud = 0.65 + 0.35 * intensity;
  const events = rhythmEvents(def.patterns, chords, bars, complexity, rand, m);
  const notes = [];
  let prevVoicing = null;
  let arpIndex = 0;
  let arpChord = null;

  events.forEach((e, i) => {
    const chord = e.chordRef.chord;
    const voicing = def.power ? powerChord(chord, low) : voiceChord(chord, prevVoicing, { low, high, size: def.size || 4 });
    prevVoicing = voicing;
    const next = events[i + 1];
    const span = next ? next.beat - e.beat : e.len / 4;
    const dur = Math.max(0.08, Math.min(e.len / 4, span) * (def.gate ?? 1));
    const t0 = e.beat + swingOffset(e.step, style);
    const vel = clamp(velocityOf(e.char) * loud, 0.15, 1);
    const ch = e.char;

    if (ch === 'a' || ch === 'A') {
      if (arpChord !== e.chordRef) { arpChord = e.chordRef; arpIndex = 0; }
      const tones = [...voicing, ...voicing.map(n => n + 12)].filter(n => n <= high + 12);
      const up = arpIndex % (tones.length * 2 - 2 || 1);
      const idx = up < tones.length ? up : tones.length * 2 - 2 - up;
      arpIndex++;
      const arpDur = part === 'arp' ? Math.min(dur, 0.24) : Math.max(dur, 0.5);
      notes.push({ t: t0, d: arpDur, n: tones[idx], v: clamp(vel * (0.85 + rand() * 0.15), 0.1, 1) });
      return;
    }
    if (ch === 'b') {
      notes.push({ t: t0, d: dur, n: nearest(chord.bass, low - 7), v: vel });
      return;
    }
    if (ch === 'm') {
      voicing.slice(-3).forEach(n => notes.push({ t: t0, d: 0.08, n, v: 0.35 }));
      return;
    }
    // Strummed chords (guitar) stagger their notes; keys hit together.
    const strum = part === 'guitar' ? (ch === 'U' || ch === 'u' ? -0.03 : 0.04) : 0;
    const order = strum < 0 ? [...voicing].reverse().slice(0, 4) : voicing;
    order.forEach((n, k) => {
      notes.push({
        t: t0 + Math.abs(strum) * k * 0.5,
        d: Math.max(0.08, dur - Math.abs(strum) * k * 0.5),
        n,
        v: clamp(vel * (strum < 0 ? 0.8 : 1) + (rand() - 0.5) * 0.06, 0.1, 1),
      });
    });
  });

  // Piano left hand.
  if (def.lh && part === 'keys') {
    const lhEvents = rhythmEvents([def.lh], chords, bars, 0, rand, m);
    lhEvents.forEach((e, i) => {
      const next = lhEvents[i + 1];
      const span = next ? next.beat - e.beat : e.len / 4;
      notes.push({ t: e.beat, d: span * 0.95, n: nearest(e.chordRef.chord.bass, 41), v: clamp(0.62 * loud, 0.2, 1) });
    });
  }
  return notes.sort((a, b) => a.t - b.t || a.n - b.n);
}

// One entry point used by the session band, loops and Drummer regeneration.
// gen = {style, part, progression, complexity, intensity, seed, fills}
export function generate(gen, { key, bars, timeSig }) {
  const m = meter(timeSig);
  let style = STYLES[gen.style] || STYLES.pop;
  // Compound meters (x/8) already swing in threes; keep their sixteenths straight.
  if (m.den === 8) style = { ...style, swing: 0 };
  const opts = { style, bars, timeSig, complexity: gen.complexity ?? 0.5, intensity: gen.intensity ?? 0.5, seed: gen.seed ?? 1 };
  if (gen.part === 'drums') return generateDrums({ ...opts, fills: gen.fills !== false });
  const chords = fillProgression(parseProgression(gen.progression || style.progression, key, m.barBeats), bars * m.barBeats);
  if (gen.part === 'bass') return generateBass({ ...opts, chords });
  return generateChords({ ...opts, part: gen.part, chords });
}

export function partInstrument(styleId, part) {
  const style = STYLES[styleId] || STYLES.pop;
  return part === 'drums' ? style.drums.kit : style[part].instrument;
}
