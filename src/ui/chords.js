// The chord wheel in the library panel: the chords that belong to a scale, ready to hear and to draw.
//
// Seven-note scales go round by fifths, so neighbours on the wheel sound good together. Picking a
// chord arms the Pencil, which then draws it (as a rhythm or an arpeggio) on the piano roll.

import { h, toast } from './dom.js';
import { store } from '../state.js';
import { guideKey, scaleChords, goesByFifths, chordPitches, chordNotes, CHORD_PATTERNS, ARPEGGIOS, KEY_NAMES, SCALE_LABELS } from '../music/theory.js';
import { meter } from '../music/meter.js';

const SIZE = 240, OUTER = 118, INNER = 52, GAP = 1;
const SIZES = [['Triads', 3], ['7ths', 4], ['9ths', 5]];
const SPEEDS = [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25]];
const MOODS = { major: 'bright', minor: 'darker', dim: 'tense', aug: 'unsettled', sus: 'open', power: 'plain' };

const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
};

const polar = (r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return `${(SIZE / 2 + r * Math.cos(a)).toFixed(2)} ${(SIZE / 2 + r * Math.sin(a)).toFixed(2)}`;
};

function segmentPath(from, to) {
  const large = to - from > 180 ? 1 : 0;
  return `M${polar(OUTER, from)}A${OUTER} ${OUTER} 0 ${large} 1 ${polar(OUTER, to)}L${polar(INNER, to)}A${INNER} ${INNER} 0 ${large} 0 ${polar(INNER, from)}Z`;
}

let previewTimers = [];

// Plays a bar of the chord as it would be drawn, on the track being edited.
function hearChord(app, chord) {
  const { editor, engine } = app;
  const track = editor.ctx?.track || store.selectedTrack;
  if (!track || track.type !== 'instrument') return;
  previewTimers.forEach(clearTimeout);
  const spb = 60 / store.project.bpm;
  const bar = meter(store.project.timeSig).barBeats;
  const notes = chordNotes(chordPitches(chord, 60), { style: editor.chordStyle, span: bar, step: editor.chordStep, bar });
  previewTimers = notes.map(n => setTimeout(() => engine.previewNote(track.id, n.n, n.v, Math.min(n.d, 1) * spb), n.t * spb * 1000));
}

function pickChord(app, chord) {
  const { editor } = app;
  if (editor.chord?.name === chord.name) return editor.armChord(null);
  // Drawing needs the piano roll: bring it up for the selected track if something else is showing.
  const found = editor.ctx;
  const track = found?.track || store.selectedTrack;
  const region = found?.track.type === 'instrument' ? found.region : track?.type === 'instrument' ? track.regions[0] : null;
  if (region) app.openEditor(region.id);
  else toast('Select an instrument track with a region to draw this chord');
  editor.armChord(chord);
  hearChord(app, chord);
}

function renderWheel(app, key, chords) {
  const { editor } = app;
  const step = 360 / chords.length;
  const wheel = svg('svg', { class: 'chord-wheel', viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'group', 'aria-label': 'Chords in this scale' });
  chords.forEach((chord, i) => {
    const from = i * step - step / 2;
    const [x, y] = polar((OUTER + INNER) / 2, i * step).split(' ').map(Number);
    const seg = svg('g', {
      class: `chord-seg${editor.chord?.name === chord.name ? ' on' : ''}${i === 0 ? ' home' : ''}`,
      role: 'button', tabindex: 0, 'data-chord': chord.name, 'aria-label': `${chord.name}, ${chord.numeral}`,
    },
    svg('title', {}, `${chord.name}: ${MOODS[chord.quality]}${i === 0 ? ', the home chord' : ''}`),
    svg('path', { d: segmentPath(from + GAP, from + step - GAP) }),
    svg('text', { x, y: y - 1, class: `chord-name${chord.name.length > 8 ? ' tiny' : chord.name.length > 5 ? ' small' : ''}` }, chord.name),
    svg('text', { x, y: y + 13, class: 'chord-numeral' }, chord.numeral));
    seg.addEventListener('click', () => pickChord(app, chord));
    seg.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      pickChord(app, chord);
    });
    wheel.append(seg);
  });
  wheel.append(
    svg('text', { x: SIZE / 2, y: SIZE / 2 - 2, class: 'chord-centre' }, KEY_NAMES[key.root]),
    svg('text', { x: SIZE / 2, y: SIZE / 2 + 13, class: 'chord-centre-scale' }, SCALE_LABELS[key.scale || 'major']),
  );
  return wheel;
}

function patternMenu(app, editor) {
  const groups = [...new Set(CHORD_PATTERNS.map(p => p.group))];
  const option = ({ id, label }) => h('option', { value: id, selected: id === editor.chordStyle }, label);
  return h('select', {
    class: 'lib-input',
    title: 'What drawing the chord writes',
    onchange: e => { editor.chordStyle = e.target.value; app.library.render(); if (editor.chord) hearChord(app, editor.chord); },
  },
  CHORD_PATTERNS.filter(p => !p.group).map(option),
  groups.filter(Boolean).map(group => {
    const el = h('optgroup', { label: group }, CHORD_PATTERNS.filter(p => p.group === group).map(option));
    return el;
  }));
}

export function renderChordWheel(app) {
  const { editor } = app;
  const project = store.project;
  const key = guideKey(project) ?? project.key;
  const chords = scaleChords(key, editor.chordSize);
  // The armed chord follows the wheel when it changes, and is dropped if its root has left the scale.
  if (editor.chord) {
    const same = chords.find(c => c.root === editor.chord.root);
    if (same?.name !== editor.chord.name) {
      editor.chord = same || null;
      editor.render();
    }
  }
  const [rootSel, scaleSel] = editor.scalePicker();
  const chips = (options, current, set) => h('div', { class: 'chips' }, options.map(([label, value]) => h('button', {
    class: 'chip' + (value === current ? ' on' : ''),
    onclick: () => set(value),
  }, label)));

  return h('div', { class: 'chords-tab' },
    h('div', { class: 'lib-section' },
      h('h4', {}, 'Scale'),
      h('div', { class: 'chord-row' }, rootSel, scaleSel)),
    renderWheel(app, key, chords),
    h('div', { class: 'lib-section' },
      h('h4', {}, 'Notes in each chord'),
      chips(SIZES, editor.chordSize, size => { editor.chordSize = size; app.library.render(); })),
    h('div', { class: 'lib-section' },
      h('h4', {}, 'Draw as'),
      patternMenu(app, editor),
      ARPEGGIOS.includes(editor.chordStyle)
        ? chips(SPEEDS, editor.chordStep, step => { editor.chordStep = step; app.library.render(); if (editor.chord) hearChord(app, editor.chord); })
        : null),
    h('div', { class: 'lib-note' }, editor.chord
      ? `Drag across the piano roll to draw ${editor.chord.name}. Click it again to stop.`
      : goesByFifths(key, chords)
        ? 'Click a chord to hear it, then drag across the piano roll to draw it. Neighbours on the wheel usually sound good together.'
        : 'Click a chord to hear it, then drag across the piano roll to draw it.'),
  );
}
