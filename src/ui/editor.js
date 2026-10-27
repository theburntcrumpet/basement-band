// Bottom-pane editor: piano roll for instruments, step grid for drums, waveform for audio.

import { h, drag, canvas2d, toast } from './dom.js';
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

export class Editor {
  constructor(app, body, tools) {
    this.app = app;
    this.body = body;
    this.tools = tools;
    this.ppb = 90;
    this.snap = 0.25;
    this.selected = new Set();
    this.lastLength = 0.5;
    this.regionId = null;
    this.centered = null;
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
      this.grid = h('canvas', { class: 'editor-canvas' });
      this.playhead = h('div', { style: { position: 'absolute', top: 0, width: '1px', background: '#fff', pointerEvents: 'none', height: '100%' } });
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
      this.keys.addEventListener('mousedown', e => this.keyDown(e));
      this.body.replaceChildren(this.keysWrap, this.wrap);
    }
    this.width = width;
    this.height = rowsH + RULER_H;
    this.drawKeys(track);
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
    const snapSel = h('select', { onchange: e => { this.snap = Number(e.target.value); } },
      [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/8T', 1 / 3], ['1/16T', 1 / 6]].map(([l, v]) => h('option', { value: v, selected: Math.abs(v - this.snap) < 1e-6 }, l)));
    const notes = region.notes.filter((_, i) => this.selected.has(i));
    const vel = notes.length ? notes.reduce((a, n) => a + n.v, 0) / notes.length : 0.8;
    const velSlider = h('input', {
      type: 'range', min: 0.05, max: 1, step: 0.01, value: vel, disabled: !notes.length,
      onmousedown: () => store.beginGesture(),
      oninput: e => { this.editable(region); for (const i of this.selected) region.notes[i].v = Number(e.target.value); this.drawGrid(region); },
      onchange: () => store.endGesture(),
    });
    this.tools.replaceChildren(...[
      h('label', {}, 'Snap', snapSel),
      h('label', {}, 'Velocity', velSlider),
      h('button', { class: 'text', title: 'Quantize selected notes (Q)', onclick: () => this.quantize() }, 'Quantize'),
      !this.drums ? h('button', { class: 'text', title: 'Transpose down an octave', onclick: () => this.transpose(-12) }, '−8va') : null,
      !this.drums ? h('button', { class: 'text', title: 'Transpose up an octave', onclick: () => this.transpose(12) }, '+8va') : null,
      h('span', { style: { color: 'var(--faint)', fontSize: '11px', marginLeft: 'auto' } },
        this.drums ? 'Click to add/remove hits • drag to paint • Alt-drag a hit for velocity' : 'Click to add • drag to move • drag the end to resize • right-click deletes • Shift-drag selects'),
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

  drawKeys(track) {
    const ctx = canvas2d(this.keys, KEYS_W, this.height);
    ctx.fillStyle = '#1f2126';
    ctx.fillRect(0, 0, KEYS_W, this.height);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const midi of this.rows) {
      const y = this.rowY(midi);
      if (this.drums) {
        ctx.fillStyle = '#2a2d34';
        ctx.fillRect(0, y, KEYS_W, this.rowH - 1);
        ctx.fillStyle = '#c9ccd4';
        ctx.fillText(DRUM_NAMES[midi] || String(midi), 6, y + this.rowH / 2);
      }
    }
    if (!this.drums) {
      // White keys first (with a seam under B and E), then black keys on top.
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, RULER_H, KEYS_W, this.rows.length * this.rowH);
      for (const midi of this.rows) {
        const y = this.rowY(midi);
        const pc = midi % 12;
        if (pc === 0 || pc === 5) { ctx.fillStyle = '#9a9a9a'; ctx.fillRect(0, y + this.rowH - 1, KEYS_W, 1); }
        if (isBlackKey(midi)) {
          ctx.fillStyle = '#1a1a1a';
          ctx.fillRect(0, y, KEYS_W * 0.6, this.rowH);
          ctx.fillStyle = '#9a9a9a';
          ctx.fillRect(KEYS_W * 0.6, y + this.rowH / 2, KEYS_W * 0.4, 1);
        }
        if (pc === 0) {
          ctx.fillStyle = '#555';
          ctx.fillText(midiToNote(midi), KEYS_W - 26, y + this.rowH / 2);
        }
      }
    }
    this.keysTrack = track.id;
  }

  drawGrid(region) {
    const ctx = canvas2d(this.grid, this.width, this.height);
    const len = region.loopLength || region.length;
    const ppb = this.ppb;
    const inKey = new Set(scaleNotes(store.project.key));
    ctx.fillStyle = '#23252b';
    ctx.fillRect(0, 0, this.width, this.height);
    // Row shading.
    for (const midi of this.rows) {
      const y = this.rowY(midi);
      if (this.drums) ctx.fillStyle = this.rows.indexOf(midi) % 2 ? '#26292f' : '#2b2e35';
      else ctx.fillStyle = isBlackKey(midi) ? '#202227' : inKey.has(midi % 12) ? '#2d3037' : '#282a30';
      ctx.fillRect(0, y, len * ppb, this.rowH);
      if (!this.drums && midi % 12 === 0) { ctx.fillStyle = '#3a3e47'; ctx.fillRect(0, y + this.rowH - 1, len * ppb, 1); }
    }
    ctx.fillStyle = '#1c1d21';
    ctx.fillRect(len * ppb, RULER_H, this.width - len * ppb, this.height);
    // Beat / bar lines, measured from the song start so they match the timeline.
    const m = meter(store.project.timeSig);
    const onGrid = (pos, unit) => { const r = ((pos % unit) + unit) % unit; return r < 1e-6 || unit - r < 1e-6; };
    const sub = this.snap >= 0.25 ? this.snap : 0.25;
    for (let b = 0; b <= len + 1e-6; b += sub) {
      const x = Math.round(b * ppb) + 0.5;
      const bar = onGrid(region.start + b, m.barBeats), beat = onGrid(region.start + b, m.pulse);
      ctx.strokeStyle = bar ? '#5a5f6b' : beat ? '#3d414b' : '#2f3239';
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, this.height); ctx.stroke();
    }
    // Ruler.
    ctx.fillStyle = '#2a2d34';
    ctx.fillRect(0, 0, this.width, RULER_H);
    ctx.fillStyle = '#9a9eaa';
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
    const color = this.drums ? [231, 180, 60] : [95, 191, 106];
    region.notes.forEach((n, i) => {
      if (!this.rows.includes(n.n)) return;
      const x = n.t * ppb, y = this.rowY(n.n);
      const sel = this.selected.has(i);
      const a = 0.35 + 0.65 * n.v;
      if (this.drums) {
        const w = Math.max(6, Math.min(0.25, n.d) * ppb - 2);
        ctx.fillStyle = sel ? `rgba(255,255,255,${a})` : `rgba(${color},${a})`;
        ctx.fillRect(x + 1, y + 2, w, this.rowH - 4);
      } else {
        const w = Math.max(3, n.d * ppb - 1);
        ctx.fillStyle = sel ? '#ffffff' : `rgba(${color},${a})`;
        ctx.fillRect(x + 0.5, y + 1, w, this.rowH - 2);
        ctx.strokeStyle = '#0008';
        ctx.strokeRect(x + 0.5, y + 1, w, this.rowH - 2);
      }
    });
    if (this.band) {
      const [x0, y0, x1, y1] = this.band;
      ctx.fillStyle = '#ffffff18';
      ctx.strokeStyle = '#ffffff88';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
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
      h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, buf ? `${buf.duration.toFixed(2)} s • ${buf.numberOfChannels === 1 ? 'mono' : 'stereo'}` : 'missing audio'),
    );
    this.wrap = null;
    const cv = h('canvas', { class: 'editor-canvas' });
    this.body.replaceChildren(h('div', { class: 'editor-wrap' }, cv));
    if (!buf) return;
    requestAnimationFrame(() => {
      const w = Math.max(400, this.body.clientWidth - 4), ht = this.body.clientHeight - 6;
      const ctx = canvas2d(cv, w, ht);
      ctx.fillStyle = '#1d2a38';
      ctx.fillRect(0, 0, w, ht);
      const p = peaks(buf, w);
      const off = (region.offset || 0) / buf.duration * w;
      const end = off + region.length * (60 / store.project.bpm) / buf.duration * w;
      ctx.fillStyle = '#4f9be8';
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
      if (n.n === midi && beat >= n.t && beat < n.t + d) return i;
    }
    return -1;
  }

  quant(beat, fine) {
    return fine ? beat : Math.floor(beat / this.snap + 1e-6) * this.snap;
  }

  gridDown(e) {
    if (e.button !== 0) return;
    const found = this.ctx;
    if (!found) return;
    const { track, region } = found;
    const { x, y, beat, midi } = this.point(e);
    const len = region.loopLength || region.length;
    if (y < RULER_H) {
      this.app.seek(region.start + this.quant(beat, e.shiftKey));
      return;
    }
    if (beat >= len) return;
    const hit = this.hitTest(region, beat, midi);

    if (e.shiftKey && hit < 0) {
      // Rubber-band selection.
      this.band = [x, y, x, y];
      drag(e, (dx, dy) => {
        this.band = [x, y, x + dx, y + dy];
        const [b0, b1] = [Math.min(x, x + dx) / this.ppb, Math.max(x, x + dx) / this.ppb];
        const [y0, y1] = [Math.min(y, y + dy), Math.max(y, y + dy)];
        this.selected = new Set(region.notes.map((n, i) => [n, i]).filter(([n]) => {
          const ny = this.rowY(n.n);
          return n.t + n.d > b0 && n.t < b1 && ny + this.rowH > y0 && ny < y1;
        }).map(([, i]) => i));
        this.drawGrid(region);
      }, () => { this.band = null; this.render(); });
      return;
    }

    if (this.drums) {
      store.beginGesture();
      this.editable(region);
      if (hit >= 0 && e.altKey) {
        const n = region.notes[hit];
        const v0 = n.v;
        drag(e, (_dx, dy) => { n.v = Math.max(0.05, Math.min(1, v0 - dy / 150)); this.drawGrid(region); }, () => store.endGesture());
        return;
      }
      const adding = hit < 0;
      if (hit >= 0) region.notes.splice(hit, 1);
      else {
        region.notes.push({ t: this.quant(beat), d: 0.25, n: midi, v: 0.8 });
        this.app.engine.previewNote(track.id, midi, 0.8);
      }
      this.drawGrid(region);
      const row = midi;
      drag(e, (_dx, _dy, ev) => {
        if (!adding) return;
        const p = this.point(ev);
        const t = this.quant(p.beat);
        if (t < 0 || t >= len) return;
        if (!region.notes.some(n => n.n === row && Math.abs(n.t - t) < 1e-6)) {
          region.notes.push({ t, d: 0.25, n: row, v: 0.8 });
          this.drawGrid(region);
        }
      }, () => store.endGesture());
      return;
    }

    store.beginGesture();
    this.editable(region);
    let mode = 'move';
    let index = hit;
    if (hit < 0) {
      // New note, then drag to set its length.
      const note = { t: this.quant(beat), d: this.lastLength, n: midi, v: 0.8 };
      region.notes.push(note);
      index = region.notes.length - 1;
      this.selected = new Set([index]);
      mode = 'create';
    } else {
      const n = region.notes[hit];
      if (!this.selected.has(hit)) this.selected = new Set([hit]);
      if ((n.t + n.d) * this.ppb - x < 7 && n.d * this.ppb > 10) mode = 'resize';
    }
    const base = [...this.selected].map(i => ({ i, ...region.notes[i] }));
    const anchor = region.notes[index];
    this.app.engine.previewNote(track.id, anchor.n, anchor.v);
    this.drawGrid(region);
    let lastPitch = anchor.n;

    drag(e, (dx, _dy, ev) => {
      const p = this.point(ev);
      if (mode === 'create' || mode === 'resize') {
        for (const b of base) {
          const end = this.quant(b.t + b.d + dx / this.ppb + (ev.shiftKey ? 0 : this.snap / 2), ev.shiftKey);
          region.notes[b.i].d = Math.max(ev.shiftKey ? 0.03 : this.snap, Math.min(len - b.t, end - b.t));
        }
        this.lastLength = region.notes[index].d;
      } else {
        const dBeat = this.quant(dx / this.ppb + (ev.shiftKey ? 0 : Math.sign(dx) * this.snap / 2), ev.shiftKey);
        const dPitch = p.midi - this.rowAt(y);
        for (const b of base) {
          const n = region.notes[b.i];
          n.t = Math.max(0, Math.min(len - 0.01, b.t + dBeat));
          n.n = Math.max(21, Math.min(108, b.n + dPitch));
        }
        if (region.notes[index].n !== lastPitch) {
          lastPitch = region.notes[index].n;
          this.app.engine.previewNote(track.id, lastPitch, region.notes[index].v, 0.2);
        }
      }
      this.drawGrid(region);
    }, () => {
      if (mode !== 'create') this.lastLength = region.notes[index]?.d ?? this.lastLength;
      store.endGesture();
    });
  }

  gridDouble(e) {
    if (this.drums) return;
    this.deleteAt(e);
  }

  deleteAt(e) {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const { beat, midi } = this.point(e);
    const hit = this.hitTest(region, beat, midi);
    if (hit < 0) return;
    store.update(() => {
      this.editable(region);
      region.notes.splice(hit, 1);
    });
    this.selected.clear();
  }

  hover(e) {
    const found = this.ctx;
    if (!found || this.drums) return;
    const { x, beat, midi } = this.point(e);
    const hit = this.hitTest(found.region, beat, midi);
    if (hit < 0) { this.grid.style.cursor = 'crosshair'; return; }
    const n = found.region.notes[hit];
    this.grid.style.cursor = (n.t + n.d) * this.ppb - x < 7 ? 'ew-resize' : 'grab';
  }

  keyDown(e) {
    const found = this.ctx;
    if (!found) return;
    const r = this.keys.getBoundingClientRect();
    const midi = this.rowAt(e.clientY - r.top);
    this.app.engine.previewNote(found.track.id, midi, 0.8);
  }

  deleteSelected() {
    const found = this.ctx;
    if (!found || !this.selected.size) return false;
    store.update(() => {
      this.editable(found.region);
      found.region.notes = found.region.notes.filter((_, i) => !this.selected.has(i));
    });
    this.selected.clear();
    return true;
  }

  selectAll() {
    const found = this.ctx;
    if (!found) return;
    this.selected = new Set(found.region.notes.map((_, i) => i));
    this.render();
  }

  quantize() {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const idx = this.selected.size ? [...this.selected] : region.notes.map((_, i) => i);
    store.update(() => {
      this.editable(region);
      for (const i of idx) {
        const n = region.notes[i];
        n.t = Math.round(n.t / this.snap) * this.snap;
        if (!this.drums) n.d = Math.max(this.snap, Math.round(n.d / this.snap) * this.snap);
      }
    });
    toast(`Quantized ${idx.length} notes`);
  }

  transpose(semis) {
    const found = this.ctx;
    if (!found) return;
    const { region } = found;
    const idx = this.selected.size ? [...this.selected] : region.notes.map((_, i) => i);
    store.update(() => {
      this.editable(region);
      for (const i of idx) region.notes[i].n = Math.max(21, Math.min(108, region.notes[i].n + semis));
    });
  }

  nudge(dBeat, dPitch) {
    const found = this.ctx;
    if (!found || !this.selected.size) return false;
    const { region } = found;
    const len = region.loopLength || region.length;
    store.update(() => {
      this.editable(region);
      for (const i of this.selected) {
        const n = region.notes[i];
        n.t = Math.max(0, Math.min(len - 0.01, n.t + dBeat * this.snap));
        n.n = Math.max(21, Math.min(108, n.n + dPitch));
      }
    });
    return true;
  }
}
