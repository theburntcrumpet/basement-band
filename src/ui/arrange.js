// The arrangement: ruler, cycle range, track headers, lanes and regions.

import { icon } from './icons.js';
import { h, $, drag, contextMenu, canvas2d, palette } from './dom.js';
import { AUTO_PARAMS, AUTO_PARAM, curve, valueAt, staticValue, normalize } from '../engine/automation.js';
import { sections } from '../arrangement.js';
import { store, uid, TRACK_COLORS, resizeRegion, trimClipStart, clipStartLimit } from '../state.js';
import { meter } from '../music/meter.js';
import { getInstrument } from '../engine/instruments.js';
import { sourceSpb } from '../engine/engine.js';
import { peaks } from '../engine/wav.js';

const HEADER_W = 230;
const PEAKS_PER_SEC = 200;
const peakMaps = new WeakMap();
// Waveform peaks at a fixed resolution, computed once per recording.
function peakMap(buf) {
  if (!peakMaps.has(buf)) peakMaps.set(buf, peaks(buf, Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SEC))));
  return peakMaps.get(buf);
}
const CYCLE_STRIP_H = 15;
const CAT_ICONS = { 'My Instruments': '🎼', Plugins: '🎛️', Keyboards: '🎹', Bass: '🎸', Guitar: '🎸', Strings: '🎻', Brass: '🎺', Woodwinds: '🎷', Mallets: '🔔', Synth: '🎛️', 'Drum Kits': '🥁' };

export function trackIcon(track) {
  if (track.type === 'audio') return '🎤';
  return CAT_ICONS[getInstrument(track.instrument).cat] || '🎹';
}

export class Arrange {
  constructor(app) {
    this.app = app;
    this.scroll = $('#arrange-scroll');
    this.inner = $('#arrange-inner');
    this.ruler = $('#ruler');
    this.tracksEl = $('#tracks');
    this.playheadEl = $('#playhead');
    this.empty = $('#arrange-empty');
    this.loading = new Set();
    this.meterEls = new Map();

    this.scroll.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const ui = store.ui;
      const rect = this.scroll.getBoundingClientRect();
      const beatAtMouse = (e.clientX - rect.left - HEADER_W + this.scroll.scrollLeft) / ui.zoom;
      ui.zoom = Math.max(4, Math.min(120, ui.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.render();
      this.scroll.scrollLeft = beatAtMouse * ui.zoom - (e.clientX - rect.left - HEADER_W);
    }, { passive: false });

    this.ruler.addEventListener('mousedown', e => this.rulerDown(e));
    this.ruler.addEventListener('contextmenu', e => {
      e.preventDefault();
      const bar = this.meter.barBeats;
      const beat = Math.max(bar, Math.round(this.beatFromClientX(e.clientX) / bar) * bar);
      contextMenu(e.clientX, e.clientY, [{ label: `Add tempo change at bar ${Math.round(beat / bar) + 1}…`, action: () => this.app.addTempoChangeAt(beat) }]);
    });
    this.ruler.addEventListener('mousemove', e => this.cycleHover(e));
    this.empty.addEventListener('click', e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action) this.app.quickStart(action);
    });
    $('#btn-add-track').addEventListener('click', () => this.app.newTrackDialog());
  }

  get zoom() { return store.ui.zoom; }

  get meter() { return meter(store.project.timeSig); }

  // Zoomed in: snap to the counted beat (quarter, or eighth in x/8); zoomed out: whole bars.
  snapUnit() {
    const m = this.meter;
    return this.zoom >= 18 ? Math.min(1, m.pulse) : m.barBeats;
  }

  snap(beats, fine) {
    const u = fine ? 0.25 : this.snapUnit();
    return Math.round(beats / u) * u;
  }

  totalBeats() {
    const p = store.project;
    let end = p.bars * this.meter.barBeats;
    for (const t of p.tracks) for (const r of t.regions) end = Math.max(end, r.start + r.length + 16);
    return end;
  }

  beatFromClientX(x) {
    const rect = this.ruler.getBoundingClientRect();
    return Math.max(0, (x - rect.left) / this.zoom);
  }

  // ------------------------------------------------------------ rendering

  render() {
    const p = store.project;
    const width = this.totalBeats() * this.zoom;
    this.inner.style.width = HEADER_W + width + 'px';
    this.empty.classList.toggle('hidden', p.tracks.length > 0);
    this.renderRuler(width);
    this.renderArrangement(width);
    this.meterEls.clear();
    this.autoCanvases = [];
    this.tracksEl.replaceChildren(...p.tracks.flatMap((t, i) => {
      const row = this.renderTrack(t, i, width);
      return store.ui.autoLanes?.has(t.id) ? [row, this.renderAutomationLane(t, width)] : [row];
    }));
    this.setPlayhead(store.ui.playhead);
  }

  renderRuler(width) {
    const p = store.project;
    const z = this.zoom;
    this.ruler.style.width = width + 'px';
    const items = [];
    const m = this.meter;
    const barPx = m.barBeats * z;
    const every = barPx < 24 ? 8 : barPx < 48 ? 4 : barPx < 80 ? 2 : 1;
    const bars = Math.ceil(width / barPx);
    for (let b = 0; b < bars; b++) {
      if (b % every === 0) items.push(h('div', { class: 'bar-tick', style: { left: b * barPx + 'px' } }, String(b + 1)));
      if (m.pulse * z >= 7) for (let q = 1; q < m.num; q++) items.push(h('div', { class: 'beat-tick', style: { left: (b * m.barBeats + q * m.pulse) * z + 'px' } }));
    }
    const c = p.cycle;
    const range = h('div', {
      class: 'cycle-range' + (c.on ? ' on' : ''),
      style: { left: c.start * z + 'px', width: Math.max(4, (c.end - c.start) * z) + 'px' },
      title: 'Cycle range: click to toggle; drag the middle to move it or an edge to resize',
    });
    items.push(h('div', { class: 'cycle-strip' }, range));
    // Tempo changes: click to edit, drag to move (by bars), right-click to remove.
    for (const change of p.tempoChanges || []) {
      const marker = h('div', { class: 'tempo-marker', style: { left: change.beat * z + 'px' }, title: 'Tempo change: click to edit, drag to move, right-click to remove' }, `♩ ${change.bpm}`);
      marker.addEventListener('mousedown', e => this.tempoMarkerDown(e, change));
      marker.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this.app.removeTempoChange(change); });
      items.push(marker);
    }
    this.ruler.replaceChildren(...items);
  }

  renderTrack(track, index, width) {
    const selected = store.ui.selectedTrack === track.id;
    const meter = h('div', { class: 'track-meter' }, h('div'));
    this.meterEls.set(track.id, meter.firstChild);
    const nameEl = h('div', { class: 'track-name', title: track.name }, track.name, this.loading.has(track.id) ? h('span', { class: 'loading-dot' }, '●') : null);
    const header = h('div', { class: 'track-header' },
      h('div', { class: 'track-icon', style: { boxShadow: `inset 0 0 0 2px ${TRACK_COLORS[track.type]}55` } }, trackIcon(track)),
      nameEl,
      h('div', { class: 'track-buttons' },
        h('button', { class: 'mute' + (track.mute ? ' on' : ''), title: 'Mute', onclick: e => { e.stopPropagation(); store.update(() => { track.mute = !track.mute; }); } }, 'M'),
        h('button', { class: 'solo' + (track.solo ? ' on' : ''), title: 'Solo', onclick: e => { e.stopPropagation(); store.update(() => { track.solo = !track.solo; }); } }, 'S'),
        h('button', { class: 'auto' + (store.ui.autoLanes?.has(track.id) ? ' on' : '') + (track.automation && Object.values(track.automation).some(c => c.length) ? ' has' : ''), title: 'Automation: change volume, pan, effects or EQ over time', onclick: e => { e.stopPropagation(); this.toggleAutomation(track); } }, 'A'),
        track.type === 'audio' ? h('button', { class: 'monitor' + (this.app.monitorTrack === track.id ? ' on' : ''), title: 'Monitor input (hear yourself through this track)', onclick: e => { e.stopPropagation(); this.app.toggleMonitor(track); } }, icon('headphones')) : null,
      ),
      h('div', { class: 'track-mix' },
        h('input', {
          type: 'range', min: -40, max: 6, step: 0.5, value: track.volume, title: 'Volume',
          onmousedown: () => store.beginGesture(),
          oninput: e => { track.volume = Number(e.target.value); this.app.engine.sync(store.project); },
          onchange: () => store.endGesture(),
          ondblclick: () => store.update(() => { track.volume = -4; }),
        }),
        meter,
      ),
    );
    header.addEventListener('mousedown', () => this.selectTrack(track.id));
    nameEl.addEventListener('dblclick', () => this.rename(track, nameEl));
    header.addEventListener('dblclick', e => {
      // The name renames, and the buttons and slider are for quick repeated clicks.
      if (!e.target.closest('.track-name, button, input')) this.app.openTrack(track);
    });
    header.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.selectTrack(track.id);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename', action: () => this.rename(track, nameEl) },
        { label: 'Duplicate Track', action: () => this.app.duplicateTrack(track) },
        '-',
        { label: 'Delete Track', key: 'Ctrl+⌫', action: () => this.app.deleteTrack(track) },
      ]);
    });

    const lane = h('div', { class: 'lane', style: { width: width + 'px' } });
    lane.append(this.laneGrid(width));
    for (const region of track.regions) lane.append(this.renderRegion(track, region));
    lane.addEventListener('mousedown', e => {
      if (e.target !== lane && !e.target.classList.contains('lane-grid')) return;
      this.selectTrack(track.id);
      store.ui.selectedRegions.clear();
      this.app.refresh();
      // A second click's target has been replaced by the refresh, so no dblclick event ever arrives.
      if (e.detail !== 2) return;
      if (track.type === 'audio') return this.app.openTrack(track);
      const bar = this.meter.barBeats;
      const beat = Math.floor(this.beatFromClientX(e.clientX) / bar) * bar;
      this.app.createEmptyRegion(track, beat);
    });
    this.setupDrop(lane, track);

    return h('div', { class: 'track' + (selected ? ' selected' : ''), dataset: { id: track.id } }, header, lane);
  }

  laneGrid(width) {
    const z = this.zoom;
    const bar = this.meter.barBeats;
    const step = bar * z < 48 ? bar * 4 : bar;
    const bg = `repeating-linear-gradient(to right, #ffffff10 0 1px, transparent 1px ${step * z}px)`;
    return h('div', { class: 'lane-grid', style: { width: width + 'px', background: bg } });
  }

  renderRegion(track, region) {
    const z = this.zoom;
    const selected = store.ui.selectedRegions.has(region.id);
    const color = region.gen && track.type === 'drums' ? TRACK_COLORS.drums : TRACK_COLORS[track.type];
    const w = Math.max(6, region.length * z);
    const el = h('div', {
      class: 'region' + (selected ? ' selected' : ''),
      style: { left: region.start * z + 'px', width: w + 'px', background: color },
      dataset: { id: region.id },
      title: region.gen ? 'Generated – double-click to edit, Smart Controls to re-roll' : '',
    });
    el.append(h('div', { class: 'label' }, region.name || track.name));
    const cv = h('canvas');
    el.append(cv);
    const loopLen = region.loopLength || region.length;
    const phase = track.type === 'audio' ? region.phase || 0 : 0;
    for (let b = loopLen - phase; b < region.length - 1e-6; b += loopLen) if (b > 1e-6) el.append(h('div', { class: 'loop-mark', style: { left: b * z + 'px' } }));
    el.append(h('div', { class: 'handle-loop' }), h('div', { class: 'handle-resize' }));
    if (track.type === 'audio') el.append(h('div', { class: 'handle-start', title: 'Drag to trim the start of the clip' }));
    requestAnimationFrame(() => this.drawRegion(cv, track, region, w));

    el.addEventListener('mousedown', e => this.regionDown(e, track, region));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!store.ui.selectedRegions.has(region.id)) {
        store.ui.selectedRegions.clear();
        store.ui.selectedRegions.add(region.id);
        this.app.refresh();
      }
      this.app.regionMenu(e.clientX, e.clientY, track, region);
    });
    return el;
  }

  drawRegion(cv, track, region, w) {
    const height = 66 - 6 - 2 - 15;
    const ctx = canvas2d(cv, w, height);
    ctx.clearRect(0, 0, w, height);
    const z = this.zoom;
    if (track.type === 'audio') {
      const buf = this.app.engine.audioPool.get(region.audioId);
      if (!buf) return;
      const spb = sourceSpb(region, store.project); // the recording's own seconds per beat
      const loop = region.loopLength || region.length;
      const phase = region.phase || 0;
      const map = peakMap(buf);
      ctx.fillStyle = '#0d2238aa';
      const mid = height / 2;
      for (let x = 0; x < w; x++) {
        // Position within the current loop pass; past the end of the recording it's silence.
        const into = (x / z + phase) % loop;
        const t = (region.offset || 0) + into * spb;
        const v = t < buf.duration ? map[Math.floor(t * PEAKS_PER_SEC)] || 0 : 0;
        ctx.fillRect(x, mid - v * mid, 1, Math.max(1, v * height));
      }
      return;
    }
    const notes = region.notes || [];
    if (!notes.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    const range = Math.max(12, hi - lo + 1);
    const pad = (range - (hi - lo + 1)) / 2;
    const rowH = (height - 4) / range;
    ctx.fillStyle = '#0b1a0ecc';
    const loopLen = region.loopLength || region.length;
    for (let off = 0; off < region.length; off += loopLen) {
      for (const n of notes) {
        if (n.t >= loopLen || off + n.t >= region.length) continue;
        const x = (off + n.t) * z;
        const y = 2 + (hi + pad - n.n) * rowH;
        ctx.fillRect(x, y, Math.max(1.5, Math.min(n.d, loopLen - n.t) * z - 1), Math.max(1.5, rowH - 0.5));
      }
    }
  }

  // A live, growing clip on the track being recorded: MIDI notes as they're played, or the
  // incoming audio's level. It is replaced by the real region when recording stops.
  updateRecording(rec, pos, engine) {
    const lane = this.tracksEl.querySelector(`.track[data-id="${rec.trackId}"] .lane`);
    if (!lane) return;
    let el = lane.querySelector('.region.recording');
    if (!el) {
      el = h('div', { class: 'region recording' }, h('div', { class: 'label' }, '● Recording'), h('canvas'));
      lane.append(el);
    }
    const z = this.zoom;
    const bar = this.meter.barBeats;
    const start = rec.kind === 'midi' ? Math.floor(rec.start / bar) * bar : rec.start;
    const end = Math.max(start + 0.25, rec.maxPos ?? pos);
    const w = (end - start) * z;
    el.style.left = start * z + 'px';
    el.style.width = w + 'px';
    const height = 66 - 6 - 2 - 15;
    const ctx = canvas2d(el.querySelector('canvas'), w, height);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = '#3a0d0bcc';
    if (rec.kind === 'midi') {
      const notes = [...rec.notes, ...[...rec.open].map(([n, o]) => ({ n, t: o.t, d: Math.max(0.05, pos - o.t) }))];
      if (!notes.length) return;
      const lo = Math.min(...notes.map(n => n.n)), hi = Math.max(...notes.map(n => n.n));
      const range = Math.max(12, hi - lo + 1);
      const rowH = (height - 4) / range;
      const top = hi + (range - (hi - lo + 1)) / 2;
      for (const n of notes) ctx.fillRect((n.t - start) * z, 2 + (top - n.n) * rowH, Math.max(2, n.d * z - 1), Math.max(1.5, rowH - 0.5));
      return;
    }
    const spb = 60 / store.project.bpm;
    const peakBar = (x, cw, d) => {
      if (x + cw < 0) return;
      let peak = 0;
      for (let k = 0; k < d.length; k += 8) peak = Math.max(peak, Math.abs(d[k]));
      ctx.fillRect(Math.max(0, x), height / 2 - (peak * height) / 2, Math.max(1, cw), Math.max(1, peak * height));
    };
    if (engine.recording?.native) {
      // Recording through the native engine: chunks are on the device clock, where the song started
      // at startedFrame (known once the count-in is over).
      const s = engine.nativeState, dev = engine.native.device;
      if (!dev || s.startedFrame < 0) return;
      const latency = (dev.inputLatency || 0) + (dev.outputLatency || 0);
      for (const c of engine.native.chunks || []) {
        const x = (s.startedBeat + (c.first - latency - s.startedFrame) / dev.rate / spb - start) * z;
        peakBar(x, (c.data.length / dev.rate / spb) * z, c.data);
      }
      return;
    }
    const chunks = engine.recording?.chunks;
    const started = engine.startedAt;
    if (!chunks?.length || !started) return;
    // Place each captured chunk at its capture time; audio from the count-in falls left of the clip.
    const rate = window.Tone.getContext().sampleRate;
    for (const c of chunks) {
      const d = c.data[0];
      const x = (started.beat + (c.frame / rate - started.time) / spb - start) * z;
      peakBar(x, (d.length / rate / spb) * z, d);
    }
  }

  clearRecording() {
    this.tracksEl.querySelectorAll('.region.recording').forEach(el => el.remove());
  }

  // ------------------------------------------------------------ arrangement (song sections)

  renderArrangement(width) {
    const lane = $('#arr-lane');
    lane.style.width = width + 'px';
    const z = this.zoom;
    const secs = sections(store.project);
    lane.replaceChildren(...(secs.length ? secs.map(sec => {
      const el = h('div', {
        class: 'section-block' + (store.ui.selectedSection === sec.id ? ' selected' : ''),
        style: { left: sec.start * z + 'px', width: Math.max(8, (sec.end - sec.start) * z - 2) + 'px', background: sec.color },
        title: `${sec.name}: click to jump here, double-click to rename, right-click for more, drag the left edge to move`,
      }, h('span', {}, sec.name), h('div', { class: 'section-edge' }));
      el.addEventListener('mousedown', e => this.sectionDown(e, sec));
      el.addEventListener('contextmenu', e => { e.preventDefault(); this.app.sectionMenu(e.clientX, e.clientY, sec); });
      return el;
    }) : [h('div', { class: 'arr-hint' }, 'Mark the parts of your song (Intro, Verse, Chorus…) with ＋ to duplicate, delete or loop them.')]));
  }

  sectionDown(e, sec) {
    if (e.button !== 0) return;
    store.ui.selectedSection = sec.id;
    const marker = store.project.markers.find(m => m.id === sec.id);
    const edge = e.target.classList.contains('section-edge') || e.offsetX < 6;
    if (!edge) {
      this.app.seek(sec.start);
      this.app.refresh();
      if (e.detail === 2) this.app.renameSection(sec); // (the refresh rules out a dblclick listener)
      return;
    }
    // Dragging the left edge moves where the section starts (the previous one grows or shrinks).
    const bar = this.meter.barBeats, start = marker.start;
    store.beginGesture();
    drag(e, dx => { marker.start = Math.max(0, Math.round((start + dx / this.zoom) / bar) * bar); this.app.refresh(); }, () => store.endGesture());
  }

  // ------------------------------------------------------------ automation lanes

  toggleAutomation(track) {
    const lanes = (store.ui.autoLanes ||= new Set());
    if (lanes.has(track.id)) lanes.delete(track.id); else lanes.add(track.id);
    this.app.refresh();
  }

  autoParamOf(track) {
    return (store.ui.autoParam ||= {})[track.id] || Object.keys(track.automation || {}).find(k => track.automation[k].length) || 'volume';
  }

  renderAutomationLane(track, width) {
    const key = this.autoParamOf(track);
    const spec = AUTO_PARAM[key];
    const select = h('select', {
      class: 'auto-select',
      onchange: e => { store.ui.autoParam[track.id] = e.target.value; this.app.refresh(); },
      onmousedown: e => e.stopPropagation(),
    }, AUTO_PARAMS.map(p => h('option', { value: p.key, selected: p.key === key }, (curve(track, p.key).length ? '● ' : '') + p.label)));
    const clear = h('button', {
      class: 'text small-text', title: `Remove all ${spec.label} automation`, disabled: !curve(track, key).length,
      onclick: () => store.update(() => { delete track.automation[key]; }),
    }, 'Clear');
    const header = h('div', { class: 'auto-header' }, h('span', { class: 'auto-label' }, 'Automation'), select, clear);
    const cv = h('canvas', { class: 'auto-canvas' });
    const lane = h('div', { class: 'auto-area', style: { width: width + 'px' } }, cv);
    this.autoCanvases.push({ cv, track, key, width });
    requestAnimationFrame(() => this.drawAutomation(cv, track, key, width));
    cv.addEventListener('mousedown', e => this.autoDown(e, cv, track, key, width));
    cv.addEventListener('dblclick', e => this.autoDelete(e, cv, track, key));
    cv.addEventListener('contextmenu', e => { e.preventDefault(); this.autoDelete(e, cv, track, key); });
    cv.addEventListener('mousemove', e => { cv.style.cursor = this.autoHit(e, cv, track, key) >= 0 ? 'grab' : 'crosshair'; });
    return h('div', { class: 'auto-lane', dataset: { id: track.id } }, header, lane);
  }

  autoGeom(cv, key) {
    const spec = AUTO_PARAM[key];
    const ht = cv.clientHeight || 54, pad = 6;
    return {
      y: v => pad + (1 - (v - spec.min) / (spec.max - spec.min)) * (ht - pad * 2),
      v: y => Math.max(spec.min, Math.min(spec.max, spec.min + (1 - (y - pad) / (ht - pad * 2)) * (spec.max - spec.min))),
      ht,
    };
  }

  drawAutomation(cv, track, key, width) {
    const c = palette();
    const z = this.zoom;
    const g = this.autoGeom(cv, key);
    const ctx = canvas2d(cv, width, g.ht);
    ctx.clearRect(0, 0, width, g.ht);
    const bar = this.meter.barBeats;
    ctx.strokeStyle = c.lineSoft || '#8884';
    for (let b = 0; b * z < width; b += bar) { ctx.beginPath(); ctx.moveTo(Math.round(b * z) + 0.5, 0); ctx.lineTo(Math.round(b * z) + 0.5, g.ht); ctx.stroke(); }
    const points = curve(track, key);
    ctx.font = '11px system-ui, sans-serif';
    if (!points.length) {
      const y = g.y(staticValue(track, key));
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = c.faint;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.faint;
      ctx.fillText(`Click to add ${AUTO_PARAM[key].label.toLowerCase()} automation`, 8 + this.scroll.scrollLeft, Math.min(g.ht - 6, y + 14));
      return;
    }
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, g.y(points[0].v));
    for (const p of points) ctx.lineTo(p.t * z, g.y(p.v));
    ctx.lineTo(width, g.y(points[points.length - 1].v));
    ctx.stroke();
    ctx.lineWidth = 1;
    for (const p of points) {
      ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.arc(p.t * z, g.y(p.v), 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  autoHit(e, cv, track, key) {
    const r = cv.getBoundingClientRect(), g = this.autoGeom(cv, key);
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return curve(track, key).findIndex(p => Math.abs(p.t * this.zoom - x) < 7 && Math.abs(g.y(p.v) - y) < 7);
  }

  autoDown(e, cv, track, key, width) {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect(), g = this.autoGeom(cv, key);
    const at = ev => ({ t: Math.max(0, this.snap((ev.clientX - r.left) / this.zoom, ev.shiftKey)), v: g.v(ev.clientY - r.top) });
    store.beginGesture();
    track.automation ||= {};
    const points = (track.automation[key] ||= []);
    let i = this.autoHit(e, cv, track, key);
    let point;
    if (i >= 0) point = points[i];
    else {
      point = at(e);
      points.push(point);
    }
    track.automation[key] = normalize(points);
    const show = () => {
      this.drawAutomation(cv, track, key, width);
      this.app.engine.sync(store.project);
    };
    show();
    drag(e, (_dx, _dy, ev) => {
      Object.assign(point, at(ev));
      track.automation[key] = normalize(track.automation[key]);
      show();
    }, () => { store.endGesture(); this.app.refresh(); });
  }

  autoDelete(e, cv, track, key) {
    const i = this.autoHit(e, cv, track, key);
    if (i < 0) return;
    store.update(() => {
      track.automation[key].splice(i, 1);
      if (!track.automation[key].length) delete track.automation[key];
    });
  }

  setPlayhead(beats) {
    this.playheadEl.style.left = HEADER_W + beats * this.zoom + 'px';
  }

  follow(beats) {
    const x = beats * this.zoom;
    const view = this.scroll.clientWidth - HEADER_W;
    if (x > this.scroll.scrollLeft + view - 40 || x < this.scroll.scrollLeft) this.scroll.scrollLeft = Math.max(0, x - 40);
  }

  updateMeters() {
    for (const [id, el] of this.meterEls) {
      const v = this.app.engine.meterDb(id);
      el.style.height = Math.max(0, Math.min(100, (v + 48) * (100 / 48))) + '%';
    }
  }

  setLoading(trackId, on) {
    if (on) this.loading.add(trackId); else this.loading.delete(trackId);
    const el = this.tracksEl.querySelector(`.track[data-id="${trackId}"] .track-name`);
    if (!el) return;
    el.querySelector('.loading-dot')?.remove();
    if (on) el.append(h('span', { class: 'loading-dot' }, '●'));
  }

  // ------------------------------------------------------------ interactions

  selectTrack(id) {
    if (store.ui.selectedTrack === id) return;
    store.ui.selectedTrack = id;
    this.app.refresh();
  }

  rename(track, nameEl) {
    const input = h('input', { value: track.name });
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = commit => {
      if (commit && input.value.trim()) store.update(() => { track.name = input.value.trim(); });
      else this.render();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }

  tempoMarkerDown(e, change) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const bar = this.meter.barBeats, start = change.beat;
    store.beginGesture();
    drag(e, dx => {
      change.beat = Math.max(bar, Math.round((start + dx / this.zoom) / bar) * bar);
      this.app.refresh();
    }, (_ev, moved) => {
      store.endGesture();
      if (!moved) this.app.editTempoChange(change);
    });
  }

  // The top band of the ruler holds the cycle range; below it, click or drag to move the playhead.
  rulerDown(e) {
    if (e.clientY - this.ruler.getBoundingClientRect().top < CYCLE_STRIP_H) return this.cycleDown(e);
    const seek = x => this.app.seek(this.snap(this.beatFromClientX(x), true));
    seek(e.clientX);
    drag(e, (_dx, _dy, ev) => seek(ev.clientX));
  }

  // What a press at this beat in the cycle strip would do: draw a new range, move it, or drag an edge.
  // While cycle is off, any drag draws a fresh range (so the dim old range never gets in the way).
  cycleMode(beat) {
    const { on, start, end } = store.project.cycle;
    if (!on) return 'new';
    const edge = 7 / this.zoom;
    if (Math.abs(beat - start) <= edge) return 'start';
    if (Math.abs(beat - end) <= edge) return 'end';
    if (beat > start && beat < end) return 'move';
    return 'new';
  }

  cycleHover(e) {
    const inStrip = e.clientY - this.ruler.getBoundingClientRect().top < CYCLE_STRIP_H;
    const mode = inStrip ? this.cycleMode(this.beatFromClientX(e.clientX)) : 'seek';
    this.ruler.style.cursor = { start: 'ew-resize', end: 'ew-resize', move: 'grab', new: 'crosshair', seek: 'pointer' }[mode];
  }

  cycleDown(e) {
    const p = store.project;
    const anchor = this.beatFromClientX(e.clientX);
    const mode = this.cycleMode(anchor);
    const { start, end } = p.cycle;
    // Cycle ranges snap to bars (or beats when zoomed right in); Shift snaps to sixteenths.
    const unit = fine => (fine ? 0.25 : this.zoom >= 60 ? this.meter.pulse : this.meter.barBeats);
    const nearest = (b, fine) => Math.round(b / unit(fine)) * unit(fine);
    store.beginGesture();
    drag(e, (_dx, _dy, ev) => {
      const b = this.beatFromClientX(ev.clientX);
      const u = unit(ev.shiftKey);
      if (mode === 'move') {
        const d = nearest(b - anchor, ev.shiftKey);
        p.cycle.start = Math.max(0, start + d);
        p.cycle.end = p.cycle.start + (end - start);
      } else if (mode === 'start') {
        p.cycle.start = Math.max(0, Math.min(nearest(b, ev.shiftKey), p.cycle.end - u));
      } else if (mode === 'end') {
        p.cycle.end = Math.max(nearest(b, ev.shiftKey), p.cycle.start + u);
      } else {
        // A new range covers every unit the drag touched, in either direction.
        p.cycle.start = Math.floor(Math.min(anchor, b) / u) * u;
        p.cycle.end = Math.max(p.cycle.start + u, Math.ceil(Math.max(anchor, b) / u) * u);
      }
      p.cycle.on = true;
      this.app.refresh();
    }, (_ev, moved) => {
      // A click (no drag) on the range toggles cycle on/off.
      if (!moved && (mode !== 'new' || (anchor >= start && anchor < end))) p.cycle.on = !p.cycle.on;
      store.endGesture();
    });
  }

  regionDown(e, track, region) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ui = store.ui;
    const sel = ui.selectedRegions;
    if (e.shiftKey) {
      if (sel.has(region.id)) sel.delete(region.id); else sel.add(region.id);
    } else if (!sel.has(region.id)) {
      sel.clear();
      sel.add(region.id);
    }
    ui.selectedTrack = track.id;
    this.app.refresh();
    // Checked here, not with a dblclick listener: the refresh above replaces this element, so the
    // browser never sends one.
    if (e.detail === 2 && !e.shiftKey) return this.app.openTrack(track, region.id);

    const classes = e.target.classList;
    const mode = classes.contains('handle-resize') ? 'resize' : classes.contains('handle-loop') ? 'loop' : classes.contains('handle-start') ? 'start' : 'move';
    const tracks = store.project.tracks;
    const picked = [...sel].map(id => store.findRegion(id)).filter(Boolean);
    const orig = picked.map(({ track: t, region: r }) => ({ r, t, start: r.start, length: r.length, loopLength: r.loopLength, notes: r.notes, offset: r.offset, base: { ...r }, ti: tracks.indexOf(t) }));
    let copied = false;

    const anchor = orig.find(o => o.r === region) || orig[0];
    drag(e, (dx, dy, ev) => {
      store.beginGesture();
      // Snap where the clicked region lands (not how far it moved), so off-grid clips can reach the grid.
      const d = this.snap(anchor.start + dx / this.zoom, ev.shiftKey) - anchor.start;
      if (mode === 'move') {
        if (ev.altKey && !copied) {
          // Option-drag copies: leave clones at the original spot.
          copied = true;
          for (const o of orig) o.t.regions.push({ ...JSON.parse(JSON.stringify(o.r)), id: uid() });
        }
        const rowDelta = Math.round(dy / 66);
        for (const o of orig) {
          o.r.start = Math.max(0, o.start + d);
          const target = tracks[Math.max(0, Math.min(tracks.length - 1, o.ti + rowDelta))];
          const current = tracks.find(t => t.regions.includes(o.r));
          if (target && target !== current && (target.type === 'audio') === (o.t.type === 'audio')) {
            current.regions.splice(current.regions.indexOf(o.r), 1);
            target.regions.push(o.r);
          }
        }
      } else if (mode === 'start') {
        const minLen = this.snapUnit() >= this.meter.barBeats ? this.meter.pulse : 0.25;
        for (const o of orig) {
          if (o.t.type !== 'audio') continue;
          const earliest = clipStartLimit(o.base, store.project);
          const start = Math.max(earliest, Math.min(o.start + o.length - minLen, this.snap(o.start + dx / this.zoom, ev.shiftKey)));
          trimClipStart(o.r, start, store.project, o.base);
        }
      } else {
        for (const o of orig) {
          const minLen = this.snapUnit() >= this.meter.barBeats ? this.meter.pulse : 0.25;
          // Snap the region's end to the grid; audio past the end of the recording is silence.
          const len = Math.max(minLen, this.snap(o.start + o.length + dx / this.zoom, ev.shiftKey) - o.start);
          if (o.t.type === 'audio') {
            const looped = (o.loopLength || o.length) < o.length - 1e-6;
            o.r.length = len;
            // Resizing an unlooped clip changes what one pass holds; looping repeats it.
            if (mode === 'resize' && !looped) o.r.loopLength = len;
            else o.r.loopLength = o.loopLength || o.length;
          } else if (mode === 'resize') {
            resizeRegion(o.r, len, store.project, { notes: o.notes, length: o.length, loopLength: o.loopLength });
          } else {
            o.r.length = len;
          }
        }
      }
      this.app.refresh();
    }, () => store.endGesture());
  }

  setupDrop(lane, track) {
    lane.addEventListener('dragover', e => {
      if (!this.app.canDrop(e, track)) return;
      e.preventDefault();
      lane.classList.add('drop-target');
    });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop-target'));
    lane.addEventListener('drop', e => {
      lane.classList.remove('drop-target');
      e.preventDefault();
      const beat = Math.max(0, Math.round(this.beatFromClientX(e.clientX) / this.snapUnit()) * this.snapUnit());
      this.app.handleDrop(e, track, beat);
    });
  }
}

// Drops onto the empty space below the tracks create a new track.
export function setupBackgroundDrop(app) {
  const scroll = $('#arrange');
  scroll.addEventListener('dragover', e => {
    if (e.target.closest('.lane')) return;
    if (!app.canDrop(e, null)) return;
    e.preventDefault();
  });
  scroll.addEventListener('drop', e => {
    if (e.target.closest('.lane')) return;
    e.preventDefault();
    const rect = $('#ruler').getBoundingClientRect();
    const bar = meter(store.project.timeSig).barBeats;
    const beat = Math.max(0, Math.round((e.clientX - rect.left) / store.ui.zoom / bar) * bar);
    app.handleDrop(e, null, beat);
  });
}
