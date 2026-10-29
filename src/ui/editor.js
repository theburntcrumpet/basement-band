// Bottom-pane editor: piano roll for instruments, step grid for drums, waveform for audio.
//
// Tools: Pointer (select, move, resize; drag on empty space to box-select; double-click to add),
// Pencil (draw notes; paints hits on drums), Eraser (click or sweep to delete), Box (marquee select).
// Selection is a set of note objects, so it survives notes being added, removed or reordered.

import { h, drag, canvas2d, toast, palette } from './dom.js';
import { store } from '../state.js';
import { kitPieces } from '../engine/instruments.js';
import { DRUM_NAMES } from '../music/band.js';
import { isBlackKey, midiToNote, scaleNotes } from '../music/theory.js';
import { peaks } from '../engine/wav.js';
import { meter, barBeat } from '../music/meter.js';

const KEYS_W = 64;
// Drum rows top to bottom: percussion and cymbals up top, kick at the bottom like a drum chart.
const DRUM_ORDER = [75, 63, 70, 56, 55, 53, 51, 49, 46, 44, 42, 48, 45, 41, 39, 40, 37, 38, 36];
const RULER_H = 18;

export const TOOLS = [
  { id: 'pointer', icon: '↖', label: 'Pointer', key: '1', tip: 'Select, move and resize notes. Drag on empty space to select several; double-click to add a note.' },
  { id: 'pencil', icon: '✎', label: 'Pencil', key: '2', tip: 'Click to add notes and drag to set their length.' },
  { id: 'eraser', icon: '⌫', label: 'Eraser', key: '3', tip: 'Click or sweep across notes to delete them.' },
  { id: 'box', icon: '⬚', label: 'Box select', key: '4', tip: 'Drag a box to select notes (Shift adds to the selection).' },
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
    this.render();
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
    }, t.icon)));
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
    const info = this.selected.size ? `${this.selected.size} selected` : '';
    this.tools.replaceChildren(...[
      toolButtons,
      h('label', {}, 'Snap', snapSel),
      h('label', {}, 'Velocity', velSlider),
      h('button', { class: 'text', title: 'Quantize selected notes (Q)', onclick: () => this.quantize() }, 'Quantize'),
      !this.drums ? h('button', { class: 'text', title: 'Transpose down an octave', onclick: () => this.transpose(-12) }, '−8va') : null,
      !this.drums ? h('button', { class: 'text', title: 'Transpose up an octave', onclick: () => this.transpose(12) }, '+8va') : null,
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
      if (pc === 0 || strong.has(midi)) {
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
    const inKey = new Set(scaleNotes(store.project.key));
    ctx.fillStyle = c.cvBg;
    ctx.fillRect(0, 0, this.width, this.height);
    // Row shading.
    for (const midi of this.rows) {
      const y = this.rowY(midi);
      if (this.drums) ctx.fillStyle = this.rows.indexOf(midi) % 2 ? c.cvRowA : c.cvRowB;
      else ctx.fillStyle = isBlackKey(midi) ? c.cvRowBlack : inKey.has(midi % 12) ? c.cvRowKey : c.cvRow;
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
    this.tools.replaceChildren(
      h('label', {}, 'Gain', h('input', {
        type: 'range', min: -24, max: 12, step: 0.5, value: region.gain ?? 0,
        onmousedown: () => store.beginGesture(),
        oninput: e => { region.gain = Number(e.target.value); },
        onchange: () => store.endGesture(),
      })),
      h('label', {}, 'Start offset', h('input', {
        type: 'range', min: 0, max: buf ? buf.duration : 0, step: 0.01, value: region.offset || 0,
        onmousedown: () => store.beginGesture(),
        oninput: e => { region.offset = Number(e.target.value); this.renderAudio(track, region); },
        onchange: () => store.endGesture(),
      })),
      h('span', { class: 'editor-hint' }, buf ? `${buf.duration.toFixed(2)} s • ${buf.numberOfChannels === 1 ? 'mono' : 'stereo'}` : 'missing audio'),
    );
    this.wrap = null;
    const cv = h('canvas', { class: 'editor-canvas' });
    this.body.replaceChildren(h('div', { class: 'editor-wrap' }, cv));
    if (!buf) return;
    requestAnimationFrame(() => {
      const c = palette();
      const w = Math.max(400, this.body.clientWidth - 4), ht = this.body.clientHeight - 6;
      const ctx = canvas2d(cv, w, ht);
      ctx.fillStyle = c.cvWaveBg;
      ctx.fillRect(0, 0, w, ht);
      const p = peaks(buf, w);
      const off = (region.offset || 0) / buf.duration * w;
      const end = off + region.length * (60 / store.project.bpm) / buf.duration * w;
      ctx.fillStyle = c.cvWave;
      for (let x = 0; x < w; x++) {
        ctx.globalAlpha = x >= off && x <= end ? 1 : 0.3;
        ctx.fillRect(x, ht / 2 - p[x] * ht / 2, 1, Math.max(1, p[x] * ht));
      }
      ctx.globalAlpha = 1;
    });
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
    const hit = this.hitTest(region, p.beat, p.midi);
    const tool = this.tool;

    if (tool === 'eraser') return this.eraseDrag(e, region);
    if (tool === 'box' || (tool === 'pointer' && !hit)) return this.boxSelect(e, region, p);
    if (tool === 'pencil' && !hit) return this.drums ? this.paintHits(e, found, p) : this.drawNote(e, found, p);
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

  // Pointer/Pencil on a note: select it, then move (Alt copies) or resize from its right edge.
  dragNotes(e, { track, region }, p, hit) {
    if (e.shiftKey) {
      if (this.selected.has(hit)) this.selected.delete(hit); else this.selected.add(hit);
      this.render();
      return;
    }
    if (!this.selected.has(hit)) this.selected = new Set([hit]);
    const len = region.loopLength || region.length;
    const resize = !this.drums && (hit.t + hit.d) * this.ppb - p.x < 7 && hit.d * this.ppb > 10;
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
      if (resize) {
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
        const dPitch = this.drums ? 0 : this.point(ev).midi - base.get(hit).n;
        for (const [n, b] of base) {
          n.t = Math.max(0, Math.min(len - 0.01, b.t + dBeat));
          n.n = Math.max(21, Math.min(108, b.n + dPitch));
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
    const note = { t, d: this.drums ? 0.25 : Math.min(this.lastLength, len - t), n: p.midi, v: 0.8 };
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
    this.setHoverRow(midi);
    if (this.tool === 'eraser') { this.grid.style.cursor = 'not-allowed'; return; }
    if (this.tool === 'box') { this.grid.style.cursor = 'crosshair'; return; }
    const hit = this.hitTest(found.region, beat, midi);
    if (!hit) { this.grid.style.cursor = this.tool === 'pencil' ? 'copy' : 'default'; return; }
    this.grid.style.cursor = !this.drums && (hit.t + hit.d) * this.ppb - x < 7 ? 'ew-resize' : 'grab';
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
    store.update(() => {
      this.editable(region);
      for (const n of this.selected) {
        n.t = Math.max(0, Math.min(len - 0.01, n.t + dBeat * this.snap));
        n.n = Math.max(21, Math.min(108, n.n + dPitch));
      }
    });
    return true;
  }
}
