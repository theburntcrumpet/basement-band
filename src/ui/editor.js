// Bottom-pane editor: piano roll for instruments, step grid for drums, waveform for audio.
//
// Tools: Pointer (select, move, resize; drag on empty space to box-select; double-click to add),
// Pencil (draw notes; paints hits on drums), Eraser (click or sweep to delete), Box (marquee select).
// Selection is a set of note objects, so it survives notes being added, removed or reordered.

import { icon } from './icons.js';
import { h, drag, canvas2d, toast, palette } from './dom.js';
import { store, trimClipStart } from '../state.js';
import { kitPieces } from '../engine/instruments.js';
import { DRUM_NAMES } from '../music/band.js';
import { isBlackKey, midiToNote, scaleNotes, snapToScale, stepInScale, guideKey, nearest, chordPitches, chordNotes, SCALES, SCALE_LABELS, SCALE_GROUPS, KEY_NAMES } from '../music/theory.js';
import { peaks } from '../engine/wav.js';
import { meter, barBeat } from '../music/meter.js';
import { sourceSpb } from '../engine/engine.js';

const KEYS_W = 64;
// Drum rows top to bottom: percussion and cymbals up top, kick at the bottom like a drum chart.
const DRUM_ORDER = [75, 63, 70, 56, 55, 53, 51, 49, 46, 44, 42, 48, 45, 41, 39, 40, 37, 38, 36];
const RULER_H = 18;
const SCALE_MARK_W = 4;
const MIN_CLIP_SECONDS = 0.05;

export const TOOLS = [
  { id: 'pointer', icon: 'pointer', label: 'Pointer', key: '1', tip: 'Select and move notes; drag either end to resize. Drag on empty space to select several; double-click to add a note.' },
  { id: 'pencil', icon: 'pencil', label: 'Pencil', key: '2', tip: 'Click to add notes and drag to set their length.' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: '3', tip: 'Click or sweep across notes to delete them.' },
  { id: 'box', icon: 'box', label: 'Box select', key: '4', tip: 'Drag a box to select notes (Shift adds to the selection).' },
];

export class Editor {
  constructor(app, body, tools) {
    this.app = app;
    this.body = body;
    this.tools = tools;
    this.ppb = 90;
    this.snap = 0.25;
    this.tool = 'pointer';
    this.selected = new Set();
    this.lastLength = 0.5;
    this.regionId = null;
    this.centered = null;
    this.hoverRow = null;
    this.activeRow = null;
    // The chord the Pencil draws (from the chord wheel), and how.
    this.chord = null;
    this.chordStyle = 'block';
    this.chordStep = 0.5;
    this.chordSize = 3;
    this.chordLength = null;
  }

  get ctx() {
    const found = this.regionId && store.findRegion(this.regionId);
    return found || null;
  }

  open(regionId) {
    if (regionId !== this.regionId) {
      this.selected.clear();
      this.centered = null;
    }
    this.regionId = regionId;
  }

  setTool(id) {
    this.tool = id;
    if (id !== 'pencil') this.chord = null;
    this.render();
    this.app.library.chordsChanged();
  }

  // Null puts the Pencil back to drawing single notes.
  armChord(chord) {
    this.chord = chord;
    if (chord) this.tool = 'pencil';
    this.render();
    this.app.library.chordsChanged();
  }

  // The scale shown on the piano roll: the song's key unless the song picks another. Null when off.
  get scale() {
    if (this.drums) return null;
    const key = guideKey(store.project);
    return key && { root: key.root, pcs: scaleNotes(key) };
  }

  // Where a note drawn on this row lands: the nearest scale note while drawing is locked to the scale.
  inScale(midi) {
    const scale = store.project.scaleGuide?.lock && this.scale;
    return scale ? snapToScale(midi, scale.pcs) : midi;
  }

  setScaleGuide(change) {
    store.update(p => { p.scaleGuide = { ...p.scaleGuide, ...change }; });
  }

  // The scale menus, shared by the piano roll's toolbar and the chord wheel. The root is null when the
  // scale follows the song's key.
  scalePicker() {
    const { key, scaleGuide: guide } = store.project;
    const chosen = SCALES[guide?.scale] ? guide.scale : guide?.scale === 'off' ? 'off' : 'song';
    const scaleSel = h('select', {
      class: 'scale-select',
      title: 'Highlight a scale on the piano roll',
      onchange: e => this.setScaleGuide({ scale: e.target.value, root: guide?.root ?? key.root }),
    }, [
      h('option', { value: 'song', selected: chosen === 'song' }, `Song key (${KEY_NAMES[key.root]} ${SCALE_LABELS[key.scale || 'major'].toLowerCase()})`),
      h('option', { value: 'off', selected: chosen === 'off' }, 'Off'),
      ...SCALE_GROUPS.map(([label, ids]) => h('optgroup', { label }, ids.map(id => h('option', { value: id, selected: chosen === id }, SCALE_LABELS[id])))),
    ]);
    const rootSel = SCALES[chosen] ? h('select', {
      class: 'scale-root',
      title: 'Root note of the scale',
      onchange: e => this.setScaleGuide({ root: Number(e.target.value) }),
    }, KEY_NAMES.map((name, i) => h('option', { value: i, selected: i === guide.root }, name))) : null;
    return [rootSel, scaleSel];
  }

  // Drops selected notes that no longer exist (after undo, or a different region).
  pruneSelection(region) {
    const live = new Set(region.notes);
    for (const n of this.selected) if (!live.has(n)) this.selected.delete(n);
  }

  render() {
    const found = this.ctx;
    if (!found) {
      this.tools.replaceChildren();
      const track = store.selectedTrack;
      const msg = !track
        ? [h('strong', {}, 'No track selected'), h('br'), 'Select a track or region to edit it here.']
        : track.type === 'audio'
          ? [h('strong', {}, `${track.name} has no recordings yet`), h('br'), 'Press R to record, or drag audio onto its lane.']
          : [h('strong', {}, `${track.name} has no regions yet`), h('br'), 'Double-click its lane to create one, or press R to record.'];
      this.body.replaceChildren(h('div', { class: 'editor-placeholder' }, h('div', {}, ...msg)));
      return;
    }
    const { track, region } = found;
    if (track.type === 'audio') return this.renderAudio(track, region);
    this.pruneSelection(region);
    this.drums = track.type === 'drums';
    if (this.drums) {
      const pieces = new Set(kitPieces(track.instrument));
      region.notes.forEach(n => pieces.add(n.n));
      this.rows = [...DRUM_ORDER.filter(n => pieces.delete(n)), ...[...pieces].sort((a, b) => b - a)];
    } else {
      this.rows = Array.from({ length: 88 }, (_, i) => 108 - i);
    }
    this.rowH = this.drums ? 22 : 14;
    this.renderTools(track, region);

    const rowsH = this.rows.length * this.rowH;
    const len = region.loopLength || region.length;
    const width = Math.max(len * this.ppb + 40, 400);

    if (!this.wrap || !this.body.contains(this.wrap)) {
      this.keys = h('canvas', { class: 'editor-canvas' });
      this.grid = h('canvas', { class: 'editor-canvas', tabindex: 0 });
      this.playhead = h('div', { class: 'editor-playhead' });
      // The spacer matches the grid's horizontal scrollbar so both columns can scroll equally far.
      this.keysWrap = h('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: KEYS_W + 'px', overflow: 'hidden' } }, this.keys, h('div', { style: { height: '24px' } }));
      this.wrap = h('div', { class: 'editor-wrap', style: { left: KEYS_W + 'px' } }, h('div', { style: { position: 'relative' } }, this.grid, this.playhead));
      this.wrap.addEventListener('scroll', () => { this.keysWrap.scrollTop = this.wrap.scrollTop; });
      this.wrap.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.ppb = Math.max(20, Math.min(400, this.ppb * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        this.render();
      }, { passive: false });
      this.grid.addEventListener('mousedown', e => this.gridDown(e));
      this.grid.addEventListener('dblclick', e => this.gridDouble(e));
      this.grid.addEventListener('contextmenu', e => { e.preventDefault(); this.deleteAt(e); });
      this.grid.addEventListener('mousemove', e => this.hover(e));
      this.grid.addEventListener('mouseleave', () => this.setHoverRow(null));
      this.keys.addEventListener('mousedown', e => this.keyDown(e));
      this.keys.addEventListener('mousemove', e => this.setHoverRow(this.rowAt(e.clientY - this.keys.getBoundingClientRect().top)));
      this.keys.addEventListener('mouseleave', () => this.setHoverRow(null));
      this.body.replaceChildren(this.keysWrap, this.wrap);
    }
    this.width = width;
    this.height = rowsH + RULER_H;
    this.drawKeys();
    this.drawGrid(region);
    // Centre on the notes the first time a region opens.
    if (this.centered !== region.id) {
      this.centered = region.id;
      const notes = region.notes;
      const target = this.drums ? null : notes.length ? notes.reduce((a, n) => a + n.n, 0) / notes.length : 60;
      requestAnimationFrame(() => {
        this.wrap.scrollTop = target == null ? this.wrap.scrollHeight : Math.max(0, this.rowY(Math.round(target)) - this.wrap.clientHeight / 2);
        this.wrap.scrollLeft = 0;
      });
    }
  }

  renderTools(track, region) {
    const toolButtons = h('div', { class: 'tool-group' }, TOOLS.map(t => h('button', {
      class: 'tool small' + (this.tool === t.id ? ' on' : ''),
      title: `${t.label} (${t.key}) — ${t.tip}`,
      onclick: () => this.setTool(t.id),
    }, icon(t.icon))));
    const snapSel = h('select', { onchange: e => { this.snap = Number(e.target.value); this.drawGrid(region); } },
      [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/8T', 1 / 3], ['1/16T', 1 / 6]].map(([l, v]) => h('option', { value: v, selected: Math.abs(v - this.snap) < 1e-6 }, l)));
    const sel = [...this.selected];
    const vel = sel.length ? sel.reduce((a, n) => a + n.v, 0) / sel.length : 0.8;
    const velSlider = h('input', {
      type: 'range', min: 0.05, max: 1, step: 0.01, value: vel, disabled: !sel.length,
      onmousedown: () => store.beginGesture(),
      oninput: e => { this.editable(region); for (const n of this.selected) n.v = Number(e.target.value); this.drawGrid(region); },
      onchange: () => store.endGesture(),
    });
    const guide = store.project.scaleGuide;
    const [rootSel, scaleSel] = this.scalePicker();
    const lock = h('input', {
      type: 'checkbox', checked: !!guide?.lock, disabled: guide?.scale === 'off',
      onchange: e => this.setScaleGuide({ lock: e.target.checked }),
    });
    const info = this.chord && !this.drums ? `Drawing ${this.chord.name}` : this.selected.size ? `${this.selected.size} selected` : '';
    this.tools.replaceChildren(...[
      toolButtons,
      h('label', {}, 'Snap', snapSel),
      h('label', {}, 'Velocity', velSlider),
      h('button', { class: 'text', title: 'Quantize selected notes (Q)', onclick: () => this.quantize() }, 'Quantize'),
      !this.drums ? h('button', { class: 'text', title: 'Transpose down an octave', onclick: () => this.transpose(-12) }, '−8va') : null,
      !this.drums ? h('button', { class: 'text', title: 'Transpose up an octave', onclick: () => this.transpose(12) }, '+8va') : null,
      !this.drums ? h('label', { class: 'scale-control' }, 'Scale', rootSel, scaleSel) : null,
      !this.drums ? h('label', { title: 'New and moved notes land on the scale. Existing notes stay put until you move them.' }, lock, 'Lock') : null,
      h('span', { class: 'editor-hint' }, info || 'Ctrl+C/X/V copy, cut, paste • Ctrl+D duplicate • Alt-drag copies • right-click deletes'),
    ].filter(Boolean));
  }

  rowY(midi) {
    const i = this.rows.indexOf(midi);
    return RULER_H + (i < 0 ? 0 : i) * this.rowH;
  }

  rowAt(y) {
    const i = Math.floor((y - RULER_H) / this.rowH);
    return this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
  }

  setHoverRow(midi) {
    if (midi === this.hoverRow) return;
    this.hoverRow = midi;
    if (this.keys) this.drawKeys();
  }

  // Piano keys (or drum names) on the left. Keys glow for selected notes, and more strongly for
  // the row under the pointer or the note being drawn/dragged.
  drawKeys() {
    if (!this.rows) return;
    const c = palette();
    const ctx = canvas2d(this.keys, KEYS_W, this.height);
    const selectedRows = new Set([...this.selected].map(n => n.n));
    const strong = new Set([this.activeRow, this.hoverRow].filter(v => v != null));
    const scale = this.scale;
    ctx.fillStyle = c.cvKeysBg;
    ctx.fillRect(0, 0, KEYS_W, this.height);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const glow = midi => (strong.has(midi) ? c.cvHl : selectedRows.has(midi) ? c.cvHover : null);
    if (this.drums) {
      for (const midi of this.rows) {
        const y = this.rowY(midi);
        ctx.fillStyle = glow(midi) || c.cvDrumKey;
        ctx.fillRect(0, y, KEYS_W, this.rowH - 1);
        ctx.fillStyle = c.cvDrumText;
        ctx.fillText(DRUM_NAMES[midi] || String(midi), 6, y + this.rowH / 2);
      }
      return;
    }
    // White keys first (with a seam under B and E), then black keys on top.
    ctx.fillStyle = c.cvKeyWhite;
    ctx.fillRect(0, RULER_H, KEYS_W, this.rows.length * this.rowH);
    for (const midi of this.rows) {
      const g = glow(midi);
      if (g && !isBlackKey(midi)) { ctx.fillStyle = g; ctx.fillRect(0, this.rowY(midi), KEYS_W, this.rowH); }
    }
    for (const midi of this.rows) {
      const y = this.rowY(midi);
      const pc = midi % 12;
      if (pc === 0 || pc === 5) { ctx.fillStyle = c.cvKeySeam; ctx.fillRect(0, y + this.rowH - 1, KEYS_W, 1); }
      if (isBlackKey(midi)) {
        ctx.fillStyle = glow(midi) || c.cvKeyBlack;
        ctx.fillRect(0, y, KEYS_W * 0.6, this.rowH);
        ctx.fillStyle = c.cvKeySeam;
        ctx.fillRect(KEYS_W * 0.6, y + this.rowH / 2, KEYS_W * 0.4, 1);
      }
      // Scale notes get a mark on the edge next to the grid, and the root a stronger one and its name.
      const root = scale && pc === scale.root;
      if (scale?.pcs.includes(pc)) {
        ctx.fillStyle = root ? c.cvScaleRoot : c.cvScaleMark;
        ctx.fillRect(KEYS_W - SCALE_MARK_W, y, SCALE_MARK_W, this.rowH);
      }
      if (pc === 0 || root || strong.has(midi)) {
        ctx.fillStyle = c.cvKeyLabel;
        ctx.fillText(midiToNote(midi), KEYS_W - 26, y + this.rowH / 2);
      }
    }
  }

  drawGrid(region) {
    const c = palette();
    const ctx = canvas2d(this.grid, this.width, this.height);
    const len = region.loopLength || region.length;
    const ppb = this.ppb;
    const scale = this.scale;
    ctx.fillStyle = c.cvBg;
    ctx.fillRect(0, 0, this.width, this.height);
    // Row shading.
    for (const midi of this.rows) {
      const y = this.rowY(midi);
      if (this.drums) ctx.fillStyle = this.rows.indexOf(midi) % 2 ? c.cvRowA : c.cvRowB;
      else if (scale?.pcs.includes(midi % 12)) ctx.fillStyle = midi % 12 === scale.root ? c.cvRowRoot : c.cvRowScale;
      else ctx.fillStyle = isBlackKey(midi) ? c.cvRowBlack : c.cvRow;
      ctx.fillRect(0, y, len * ppb, this.rowH);
      if (!this.drums && midi % 12 === 0) { ctx.fillStyle = c.cvOctave; ctx.fillRect(0, y + this.rowH - 1, len * ppb, 1); }
    }
    const row = this.activeRow ?? this.hoverRow;
    if (row != null && this.rows.includes(row)) {
      ctx.fillStyle = c.cvHover;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, this.rowY(row), len * ppb, this.rowH);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = c.cvOutside;
    ctx.fillRect(len * ppb, RULER_H, this.width - len * ppb, this.height);
    // Beat / bar lines, measured from the song start so they match the timeline.
    const m = meter(store.project.timeSig);
    const onGrid = (pos, unit) => { const r = ((pos % unit) + unit) % unit; return r < 1e-6 || unit - r < 1e-6; };
    const sub = this.snap >= 0.25 ? this.snap : 0.25;
    for (let b = 0; b <= len + 1e-6; b += sub) {
      const x = Math.round(b * ppb) + 0.5;
      const bar = onGrid(region.start + b, m.barBeats), beat = onGrid(region.start + b, m.pulse);
      ctx.strokeStyle = bar ? c.cvBar : beat ? c.cvBeat : c.cvSub;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, this.height); ctx.stroke();
    }
    // Ruler.
    ctx.fillStyle = c.cvRuler;
    ctx.fillRect(0, 0, this.width, RULER_H);
    ctx.fillStyle = c.cvRulerText;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const first = Math.ceil(region.start / m.pulse - 1e-6) * m.pulse - region.start;
    for (let b = first; b < len - 1e-6; b += m.pulse) {
      const x = b * ppb;
      const pos = barBeat(region.start + b, store.project.timeSig);
      if (pos.beat === 1) ctx.fillText(String(pos.bar), x + 3, RULER_H / 2);
      else if (m.pulse * ppb > 45) ctx.fillText(`${pos.bar}.${pos.beat}`, x + 3, RULER_H / 2);
    }
    // Notes.
    const color = this.drums ? c.cvDrumNote : c.cvNote;
    for (const n of region.notes) {
      if (!this.rows.includes(n.n)) continue;
      const x = n.t * ppb, y = this.rowY(n.n);
      const sel = this.selected.has(n);
      const a = 0.35 + 0.65 * n.v;
      if (this.drums) {
        const w = Math.max(6, Math.min(0.25, n.d) * ppb - 2);
        ctx.fillStyle = sel ? c.cvNoteSel : `rgba(${color},${a})`;
        ctx.fillRect(x + 1, y + 2, w, this.rowH - 4);
      } else {
        const w = Math.max(3, n.d * ppb - 1);
        ctx.fillStyle = sel ? c.cvNoteSel : `rgba(${color},${a})`;
        ctx.fillRect(x + 0.5, y + 1, w, this.rowH - 2);
        ctx.strokeStyle = c.cvNoteEdge;
        ctx.strokeRect(x + 0.5, y + 1, w, this.rowH - 2);
      }
    }
    if (this.band) {
      const [x0, y0, x1, y1] = this.band;
      ctx.fillStyle = c.cvBand;
      ctx.strokeStyle = c.cvBandEdge;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
  }

  renderAudio(track, region) {
    const buf = this.app.engine.audioPool.get(region.audioId);
    const clip = this.clipWindow(region);
    this.tools.replaceChildren(...[
      h('label', {}, 'Gain', h('input', {
        type: 'range', min: -24, max: 12, step: 0.5, value: region.gain ?? 0,
        onmousedown: () => store.beginGesture(),
        oninput: e => { region.gain = Number(e.target.value); },
        onchange: () => store.endGesture(),
      })),
      region.bpm ? h('label', { title: 'Time-stretch this clip so it stays in time when the song tempo changes' },
        h('input', { type: 'checkbox', checked: region.followTempo !== false, onchange: e => store.update(() => { region.followTempo = e.target.checked; }) }),
        `Follow tempo (recorded at ${Math.round(region.bpm * 10) / 10} bpm)`) : null,
      h('span', { class: 'editor-hint' }, buf
        ? `Plays ${clip.from.toFixed(2)}–${Math.min(clip.to, buf.duration).toFixed(2)} s of ${buf.duration.toFixed(2)} s • ${buf.numberOfChannels === 1 ? 'mono' : 'stereo'} • drag the edges to trim, the middle to slide`
        : 'missing audio'),
    ].filter(Boolean));
    this.wrap = null;
    if (!buf) {
      this.clipView = null;
      this.body.replaceChildren(h('div', { class: 'editor-wrap' }));
      return;
    }
    this.showClip(region, buf, clip);
  }

  // The part of the recording a clip plays, in the recording's own seconds. A looped clip shows one pass.
  clipWindow(region) {
    const spb = sourceSpb(region, store.project);
    const loop = region.loopLength || region.length;
    const looped = loop < region.length - 1e-6;
    const from = (region.offset || 0) + (looped ? 0 : (region.phase || 0) * spb);
    return { spb, looped, from, to: from + (looped ? loop : region.length) * spb };
  }

  // The whole recording, with the part that plays between two handles. The view stays in place while
  // it's dragged (only the shading moves), so dragging is smooth and the waveform isn't redrawn.
  showClip(region, buf, { from, to }) {
    let view = this.clipView;
    if (!view || !this.body.contains(view.root)) {
      const canvas = h('canvas', { class: 'editor-canvas' });
      const shadeLeft = h('div', { class: 'clip-shade' }), shadeRight = h('div', { class: 'clip-shade' });
      const win = h('div', { class: 'clip-window', title: 'Drag to slide which part of the recording plays' },
        h('div', { class: 'clip-handle start', title: 'Drag to trim the start' }),
        h('div', { class: 'clip-handle end', title: 'Drag to trim the end' }));
      const root = h('div', { class: 'clip-view' }, canvas, shadeLeft, shadeRight, win);
      root.addEventListener('mousedown', e => this.clipDown(e));
      this.body.replaceChildren(root);
      view = this.clipView = { root, canvas, shadeLeft, shadeRight, win };
    }
    const at = t => Math.min(100, t / buf.duration * 100);
    view.shadeLeft.style.cssText = `left: 0; width: ${at(from)}%`;
    view.shadeRight.style.cssText = `left: ${at(to)}%; right: 0`;
    view.win.style.cssText = `left: ${at(from)}%; width: ${at(to) - at(from)}%`;
    requestAnimationFrame(() => {
      const w = view.root.clientWidth, ht = view.root.clientHeight;
      if (!w || !ht || (view.drawn === buf && view.w === w && view.ht === ht)) return;
      Object.assign(view, { drawn: buf, w, ht });
      const c = palette();
      const ctx = canvas2d(view.canvas, w, ht);
      ctx.fillStyle = c.cvWaveBg;
      ctx.fillRect(0, 0, w, ht);
      const p = peaks(buf, w);
      ctx.fillStyle = c.cvWave;
      for (let x = 0; x < w; x++) ctx.fillRect(x, ht / 2 - p[x] * ht / 2, 1, Math.max(1, p[x] * ht));
    });
  }

  clipDown(e) {
    const found = this.ctx;
    const classes = e.target.classList;
    const mode = classes.contains('start') ? 'start' : classes.contains('end') ? 'end' : classes.contains('clip-window') ? 'slide' : null;
    if (e.button !== 0 || !found || !mode) return;
    const { region } = found;
    const { duration } = this.app.engine.audioPool.get(region.audioId);
    const rect = this.clipView.root.getBoundingClientRect();
    const base = { ...region };
    const { spb, looped, from, to } = this.clipWindow(region);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const secondsAt = ev => (ev.clientX - rect.left) / rect.width * duration;
    // Keep the handle under the pointer where it was grabbed, so it doesn't jump on the first move.
    const grab = secondsAt(e) - (mode === 'start' ? from : Math.min(to, duration));
    const atPointer = ev => secondsAt(ev) - grab;
    drag(e, (dx, _dy, ev) => {
      store.beginGesture();
      if (mode === 'slide') {
        region.offset = clamp(from + dx / rect.width * duration, 0, duration - MIN_CLIP_SECONDS);
        if (!looped) region.phase = 0;
      } else if (mode === 'end') {
        const beats = (clamp(atPointer(ev), from + MIN_CLIP_SECONDS, duration) - from) / spb;
        region.loopLength = looped ? Math.min(beats, region.length) : beats;
        if (!looped) region.length = beats;
      } else {
        const t = clamp(atPointer(ev), 0, to - MIN_CLIP_SECONDS);
        if (looped) {
          region.offset = t;
          region.loopLength = (to - t) / spb;
        } else {
          // The song position of what's left stays put, so the clip can't start before the song does.
          trimClipStart(region, Math.max(0, base.start + (t - from) / spb), store.project, base);
        }
      }
      this.app.refresh();
    }, () => store.endGesture());
  }

  setPlayhead(beats) {
    const found = this.ctx;
    if (!found || !this.playhead || found.track.type === 'audio') return;
    const { region } = found;
    const rel = beats - region.start;
    const len = region.loopLength || region.length;
    const visible = rel >= 0 && rel < region.length;
    this.playhead.style.display = visible ? 'block' : 'none';
    if (visible) this.playhead.style.left = ((rel % len) * this.ppb) + 'px';
  }

  // ------------------------------------------------------------ editing

  // Generated regions become plain notes on the first manual edit.
  editable(region) {
    if (region.gen) {
      delete region.gen;
      toast('Region converted to editable notes');
    }
  }

  point(e) {
    const r = this.grid.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, beat: x / this.ppb, midi: this.rowAt(y) };
  }

  hitTest(region, beat, midi) {
    for (let i = region.notes.length - 1; i >= 0; i--) {
      const n = region.notes[i];
      const d = this.drums ? Math.max(6 / this.ppb, Math.min(0.25, n.d)) : n.d;
      if (n.n === midi && beat >= n.t && beat < n.t + d) return n;
    }
    return null;
  }

  quant(beat, fine) {
    return fine ? beat : Math.floor(beat / this.snap + 1e-6) * this.snap;
  }

  gridDown(e) {
    if (e.button !== 0) return;
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const p = this.point(e);
    const len = region.loopLength || region.length;
    if (p.y < RULER_H) {
      this.app.seek(region.start + this.quant(p.beat, e.shiftKey));
      return;
    }
    if (p.beat >= len) return;
    let hit = this.hitTest(region, p.beat, p.midi);
    const tool = this.tool;
    if (tool === 'pencil' && this.chord && !this.drums) return this.drawChord(e, found, p);

    if (tool === 'eraser') return this.eraseDrag(e, region);
    if (tool === 'box' || (tool === 'pointer' && !hit)) return this.boxSelect(e, region, p);
    if (tool === 'pencil' && !hit) {
      const midi = this.inScale(p.midi);
      hit = this.hitTest(region, p.beat, midi);
      if (!hit) return this.drums ? this.paintHits(e, found, p) : this.drawNote(e, found, { ...p, midi });
    }
    this.dragNotes(e, found, p, hit);
  }

  boxSelect(e, region, { x, y }) {
    const keep = e.shiftKey ? new Set(this.selected) : new Set();
    this.selected = new Set(keep);
    this.band = [x, y, x, y];
    this.drawGrid(region);
    drag(e, (dx, dy) => {
      this.band = [x, y, x + dx, y + dy];
      const [b0, b1] = [Math.min(x, x + dx) / this.ppb, Math.max(x, x + dx) / this.ppb];
      const [y0, y1] = [Math.min(y, y + dy), Math.max(y, y + dy)];
      this.selected = new Set(keep);
      for (const n of region.notes) {
        const d = this.drums ? Math.min(0.25, n.d) : n.d;
        const ny = this.rowY(n.n);
        if (n.t + d > b0 && n.t < b1 && ny + this.rowH > y0 && ny < y1) this.selected.add(n);
      }
      this.drawGrid(region);
    }, () => { this.band = null; this.render(); });
  }

  eraseDrag(e, region) {
    store.beginGesture();
    let erased = 0;
    const eraseAt = ev => {
      const p = this.point(ev);
      const hit = this.hitTest(region, p.beat, p.midi);
      if (!hit) return;
      this.editable(region);
      region.notes.splice(region.notes.indexOf(hit), 1);
      this.selected.delete(hit);
      erased++;
      this.drawGrid(region);
    };
    eraseAt(e);
    drag(e, (_dx, _dy, ev) => eraseAt(ev), () => { store.endGesture(); if (erased) this.render(); });
  }

  // Pencil on drums: click adds a hit, drag paints a row of them.
  paintHits(e, { track, region }, p) {
    store.beginGesture();
    this.editable(region);
    const len = region.loopLength || region.length;
    const row = p.midi;
    const add = t => {
      if (t < 0 || t >= len || region.notes.some(n => n.n === row && Math.abs(n.t - t) < 1e-6)) return;
      region.notes.push({ t, d: 0.25, n: row, v: 0.8 });
    };
    add(this.quant(p.beat));
    this.app.engine.previewNote(track.id, row, 0.8);
    this.activeRow = row;
    this.drawGrid(region);
    this.drawKeys();
    drag(e, (_dx, _dy, ev) => { add(this.quant(this.point(ev).beat)); this.drawGrid(region); }, () => {
      this.activeRow = null;
      store.endGesture();
    });
  }

  // Pencil on the piano roll: a new note, dragged out to its length.
  drawNote(e, { track, region }, p) {
    store.beginGesture();
    this.editable(region);
    const len = region.loopLength || region.length;
    const note = { t: this.quant(p.beat), d: Math.min(this.lastLength, len - this.quant(p.beat)), n: p.midi, v: 0.8 };
    region.notes.push(note);
    this.selected = new Set([note]);
    this.activeRow = note.n;
    this.app.engine.previewNote(track.id, note.n, note.v);
    this.drawGrid(region);
    this.drawKeys();
    drag(e, (dx, _dy, ev) => {
      const end = this.quant(note.t + this.lastLength + dx / this.ppb + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey);
      note.d = Math.max(ev.shiftKey ? 0.03 : this.snap, Math.min(len - note.t, end - note.t));
      this.drawGrid(region);
    }, (_ev, moved) => {
      if (moved) this.lastLength = note.d;
      this.activeRow = null;
      store.endGesture();
    });
  }

  // Pencil with a chord from the wheel: drag out how long it lasts, and it fills that span.
  drawChord(e, { track, region }, p) {
    store.beginGesture();
    this.editable(region);
    const len = region.loopLength || region.length;
    const start = this.quant(p.beat);
    const pitches = chordPitches(this.chord, p.midi);
    let added = [];
    const place = span => {
      const live = new Set(added);
      region.notes = region.notes.filter(n => !live.has(n));
      added = chordNotes(pitches, { style: this.chordStyle, span, step: this.chordStep, bar: meter(store.project.timeSig).barBeats })
        .map(n => ({ ...n, t: n.t + start }))
        .filter(n => !region.notes.some(o => o.n === n.n && Math.abs(o.t - n.t) < 1e-6));
      region.notes.push(...added);
      this.selected = new Set(added);
      this.drawGrid(region);
    };
    place(Math.min(this.chordLength ?? meter(store.project.timeSig).barBeats, len - start));
    for (const n of pitches) this.app.engine.previewNote(track.id, n, 0.7);
    this.activeRow = pitches[0];
    this.drawKeys();
    let span = null;
    drag(e, (_dx, _dy, ev) => {
      const end = this.quant(this.point(ev).beat + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey);
      span = Math.max(ev.shiftKey ? 0.03 : this.snap, Math.min(len - start, end - start));
      place(span);
    }, () => {
      if (span != null) this.chordLength = span;
      this.activeRow = null;
      store.endGesture();
      this.render();
    });
  }

  // Which end of a note the pointer is on, if any. Short notes keep a middle to grab and move them by.
  noteEdge(note, x) {
    const w = note.d * this.ppb;
    if (this.drums || w <= 10) return null;
    const reach = Math.min(7, w / 4), left = note.t * this.ppb;
    if (left + w - x < reach) return 'end';
    return x - left < reach ? 'start' : null;
  }

  // Pointer/Pencil on a note: select it, then move (Alt copies) or resize from either end.
  dragNotes(e, { track, region }, p, hit) {
    if (e.shiftKey) {
      if (this.selected.has(hit)) this.selected.delete(hit); else this.selected.add(hit);
      this.render();
      return;
    }
    if (!this.selected.has(hit)) this.selected = new Set([hit]);
    const len = region.loopLength || region.length;
    const resize = this.noteEdge(hit, p.x);
    const base = new Map([...this.selected].map(n => [n, { t: n.t, d: n.d, n: n.n, v: n.v }]));
    let copied = false;
    let lastPitch = hit.n;
    this.activeRow = hit.n;
    this.app.engine.previewNote(track.id, hit.n, hit.v);
    this.drawGrid(region);
    this.drawKeys();
    store.beginGesture();
    drag(e, (dx, _dy, ev) => {
      this.editable(region);
      if (resize === 'start') {
        // The note's end stays where it is.
        for (const [n, b] of base) {
          const end = b.t + b.d;
          const shortest = Math.min(b.d, ev.shiftKey ? 0.03 : this.snap);
          const start = this.quant(b.t + dx / this.ppb + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey);
          n.t = Math.max(0, Math.min(end - shortest, start));
          n.d = end - n.t;
        }
        this.lastLength = hit.d;
      } else if (resize) {
        for (const [n, b] of base) {
          const end = this.quant(b.t + b.d + dx / this.ppb + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey);
          n.d = Math.max(ev.shiftKey ? 0.03 : this.snap, Math.min(len - b.t, end - b.t));
        }
        this.lastLength = hit.d;
      } else {
        if (ev.altKey && !copied) {
          // Alt-drag: leave copies where the notes started and carry the originals.
          copied = true;
          for (const b of base.values()) region.notes.push({ ...b });
        }
        // Snap the grabbed note's position, and move everything else by the same amount.
        const dBeat = this.quant(base.get(hit).t + dx / this.ppb + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey) - base.get(hit).t;
        const row = this.point(ev).midi;
        const dPitch = this.drums || row === base.get(hit).n ? 0 : this.inScale(row) - base.get(hit).n;
        for (const [n, b] of base) {
          n.t = Math.max(0, Math.min(len - 0.01, b.t + dBeat));
          const pitch = Math.max(21, Math.min(108, b.n + dPitch));
          n.n = dPitch ? this.inScale(pitch) : pitch;
        }
        if (hit.n !== lastPitch) {
          lastPitch = hit.n;
          this.app.engine.previewNote(track.id, hit.n, hit.v, 0.2);
        }
        this.activeRow = hit.n;
        this.drawKeys();
      }
      this.drawGrid(region);
    }, (_ev, moved) => {
      if (moved && !resize) this.lastLength = hit.d;
      this.activeRow = null;
      store.endGesture();
      this.render();
    });
  }

  // Double-click: with the Pointer, adds a note on empty space; otherwise deletes the note clicked.
  gridDouble(e) {
    const found = this.ctx;
    if (!found) return;
    const p = this.point(e);
    const hit = this.hitTest(found.region, p.beat, p.midi);
    if (hit) return this.deleteAt(e);
    if (this.tool !== 'pointer' || p.y < RULER_H) return;
    const { region, track } = found;
    const len = region.loopLength || region.length;
    if (p.beat >= len) return;
    const t = this.quant(p.beat);
    const midi = this.inScale(p.midi);
    if (this.hitTest(region, p.beat, midi)) return;
    const note = { t, d: this.drums ? 0.25 : Math.min(this.lastLength, len - t), n: midi, v: 0.8 };
    store.update(() => { this.editable(region); region.notes.push(note); });
    this.selected = new Set([note]);
    this.app.engine.previewNote(track.id, note.n, note.v);
  }

  deleteAt(e) {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const { beat, midi } = this.point(e);
    const hit = this.hitTest(region, beat, midi);
    if (!hit) return;
    store.update(() => {
      this.editable(region);
      region.notes.splice(region.notes.indexOf(hit), 1);
    });
    this.selected.delete(hit);
  }

  hover(e) {
    const found = this.ctx;
    if (!found) return;
    const { x, beat, midi } = this.point(e);
    const hit = this.hitTest(found.region, beat, midi);
    // The keys show where a new note would land.
    const drawing = this.chord && this.tool === 'pencil' && !this.drums;
    this.setHoverRow(drawing ? nearest(this.chord.root, midi) : hit || this.tool === 'eraser' || this.tool === 'box' ? midi : this.inScale(midi));
    if (this.tool === 'eraser') { this.grid.style.cursor = 'not-allowed'; return; }
    if (this.tool === 'box') { this.grid.style.cursor = 'crosshair'; return; }
    if (!hit || drawing) { this.grid.style.cursor = this.tool === 'pencil' ? 'copy' : 'default'; return; }
    this.grid.style.cursor = this.noteEdge(hit, x) ? 'ew-resize' : 'grab';
  }

  keyDown(e) {
    const found = this.ctx;
    if (!found) return;
    const r = this.keys.getBoundingClientRect();
    const midi = this.rowAt(e.clientY - r.top);
    this.app.engine.previewNote(found.track.id, midi, 0.8);
    this.activeRow = midi;
    this.drawKeys();
    const up = () => { this.activeRow = null; this.drawKeys(); removeEventListener('mouseup', up); };
    addEventListener('mouseup', up);
  }

  // ------------------------------------------------------------ selection commands

  hasSelection() {
    return !!this.ctx && this.selected.size > 0;
  }

  deleteSelected() {
    const found = this.ctx;
    if (!found || !this.selected.size) return false;
    store.update(() => {
      this.editable(found.region);
      found.region.notes = found.region.notes.filter(n => !this.selected.has(n));
    });
    this.selected.clear();
    return true;
  }

  selectAll() {
    const found = this.ctx;
    if (!found) return;
    this.selected = new Set(found.region.notes);
    this.render();
  }

  // Selected notes as a clip: positions relative to the first note.
  copySelection() {
    const notes = [...this.selected];
    if (!notes.length) return null;
    const start = Math.min(...notes.map(n => n.t));
    const end = Math.max(...notes.map(n => n.t + (this.drums ? Math.min(0.25, n.d) : n.d)));
    return { kind: 'notes', notes: notes.map(n => ({ ...n, t: n.t - start })), span: end - start };
  }

  // Puts clip notes into the region at `at` (beats from the region start), growing an unlooped
  // region to fit. Returns the new notes, which become the selection.
  insertNotes(clip, at) {
    const found = this.ctx;
    if (!found) return [];
    const { region } = found;
    const bar = meter(store.project.timeSig).barBeats;
    const fresh = clip.notes.map(n => ({ ...n, t: n.t + at }));
    store.update(() => {
      this.editable(region);
      const looped = (region.loopLength || region.length) < region.length - 1e-6;
      const needed = Math.max(...fresh.map(n => n.t + n.d));
      if (!looped && needed > region.length + 1e-6) {
        region.length = region.loopLength = Math.ceil(needed / bar - 1e-6) * bar;
      }
      const len = region.loopLength || region.length;
      for (const n of fresh) if (n.t < len - 1e-6) region.notes.push(n);
    });
    this.selected = new Set(fresh.filter(n => found.region.notes.includes(n)));
    this.render();
    return [...this.selected];
  }

  // Paste at the playhead (growing an unlooped region to reach it), otherwise at the region's start.
  paste(clip) {
    const found = this.ctx;
    if (!found || clip?.kind !== 'notes') return false;
    const { region } = found;
    const rel = store.ui.playhead - region.start;
    const len = region.loopLength || region.length;
    const looped = len < region.length - 1e-6;
    const at = rel >= 0 && (rel < len || !looped) ? this.quant(rel) : 0;
    const added = this.insertNotes(clip, at);
    toast(`Pasted ${added.length} note${added.length === 1 ? '' : 's'}`);
    return true;
  }

  // Copies of the selection placed straight after it, on the snap grid.
  duplicate() {
    const clip = this.copySelection();
    if (!clip) return false;
    const start = Math.min(...[...this.selected].map(n => n.t));
    const step = Math.max(this.snap, Math.ceil(clip.span / this.snap - 1e-6) * this.snap);
    this.insertNotes(clip, start + step);
    return true;
  }

  quantize() {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const notes = this.selected.size ? [...this.selected] : region.notes;
    store.update(() => {
      this.editable(region);
      for (const n of notes) {
        n.t = Math.round(n.t / this.snap) * this.snap;
        if (!this.drums) n.d = Math.max(this.snap, Math.round(n.d / this.snap) * this.snap);
      }
    });
    toast(`Quantized ${notes.length} notes`);
  }

  transpose(semis) {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const notes = this.selected.size ? [...this.selected] : region.notes;
    store.update(() => {
      this.editable(region);
      for (const n of notes) n.n = Math.max(21, Math.min(108, n.n + semis));
    });
  }

  nudge(dBeat, dPitch) {
    const found = this.ctx;
    if (!found || !this.selected.size) return false;
    const { region } = found;
    const len = region.loopLength || region.length;
    // Locked to a scale, the arrow keys walk its notes; octaves still move by octaves.
    const scale = store.project.scaleGuide?.lock && Math.abs(dPitch) === 1 && this.scale;
    store.update(() => {
      this.editable(region);
      for (const n of this.selected) {
        n.t = Math.max(0, Math.min(len - 0.01, n.t + dBeat * this.snap));
        n.n = scale ? stepInScale(n.n, scale.pcs, dPitch) : Math.max(21, Math.min(108, n.n + dPitch));
      }
    });
    return true;
  }
}
