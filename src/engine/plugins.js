// Plugin instruments (VST3, plus LV2 on Linux), hosted by the native helper.
//
// The helper renders each plugin a little ahead of the audio clock and the audio streams into the
// track through the bb-stream worklet. Song notes don't go through Tone's scheduler (it only hands
// events over ~50 ms early, too late to render ahead); each plugin works out its own notes from the
// song, the tempo map and the cycle, anchored to where playback started.

import { expandRegion } from './engine.js';
import { secAt, beatAt, bpmAt, secBetween } from '../music/tempo.js';

const Tone = window.Tone;
export const PLUGIN_CAT = 'Plugins';

// How far ahead of the audio clock plugins render (also the extra latency when playing live).
const AHEAD = { low: 0.03, balanced: 0.05, stable: 0.12 };
const CHUNK = 128;

// ------------------------------------------------------------------ registry (from the scan)

let defs = new Map();
let scanState = { available: false, scanned: false, failed: [] };
let readyResolve;
export const pluginsReady = new Promise(r => { readyResolve = r; });
const listeners = new Set();
export const onPluginsChanged = fn => listeners.add(fn);

function defFor(p) {
  return {
    id: 'plugin:' + p.id, name: p.name, cat: PLUGIN_CAT, type: 'plugin', desc: p,
    manufacturer: p.manufacturer, format: p.format, bundled: !!p.bundled, isInstrument: p.isInstrument, volume: 0,
  };
}

// Finds plugins (quick when nothing changed: results are cached by file).
export async function scanPlugins() {
  try {
    const res = await window.host?.plugins?.scan();
    if (res) {
      defs = new Map(res.plugins.map(p => [`plugin:${p.id}`, defFor(p)]));
      scanState = { available: res.available, scanned: true, failed: res.failed || [] };
    }
  } catch (err) {
    console.warn('Plugin scan failed', err);
  } finally {
    readyResolve();
    listeners.forEach(fn => fn());
  }
  return scanState;
}

export const pluginStatus = () => scanState;
export const pluginList = () => [...defs.values()].sort((a, b) => (b.bundled - a.bundled) || a.name.localeCompare(b.name));

export function getPluginDef(id) {
  if (!id?.startsWith('plugin:')) return null;
  return defs.get(id) || { id, name: 'Missing plugin', cat: PLUGIN_CAT, type: 'plugin', missing: true, volume: 0 };
}

// ------------------------------------------------------------------ the helper connection

class Bridge extends EventTarget {
  constructor() {
    super();
    this.req = 0;
    this.seq = 0;
    this.nextInst = 1;
    this.waiting = new Map();   // req -> {resolve, reject}
    this.renders = new Map();   // seq -> callback(l, r)
    this.started = false;
  }

  start() {
    if (this.started || !window.host?.plugins) return;
    this.started = true;
    window.host.plugins.onMessage(m => this.onMessage(m));
  }

  call(cmd, props = {}) {
    this.start();
    const req = ++this.req;
    return new Promise((resolve, reject) => {
      this.waiting.set(req, { resolve, reject });
      window.host.plugins.send({ cmd, req, ...props });
    });
  }

  send(cmd, props = {}) {
    this.start();
    window.host?.plugins.send({ cmd, ...props });
  }

  // events: [{offset, bytes: [status, d1, d2]}], sorted by offset.
  render(inst, frames, events, info, cb) {
    const seq = ++this.seq;
    const buf = new ArrayBuffer(36 + events.length * 8);
    const v = new DataView(buf);
    v.setUint32(0, seq, true);
    v.setUint32(4, inst, true);
    v.setUint32(8, frames, true);
    v.setFloat64(12, info.bpm, true);
    v.setFloat64(20, info.ppq, true);
    v.setUint8(28, info.playing ? 1 : 0);
    v.setUint32(32, events.length, true);
    events.forEach((e, i) => {
      const o = 36 + i * 8;
      v.setUint32(o, e.offset, true);
      v.setUint8(o + 4, e.bytes[0]);
      v.setUint8(o + 5, e.bytes[1] ?? 0);
      v.setUint8(o + 6, e.bytes[2] ?? 0);
    });
    this.renders.set(seq, cb);
    window.host.plugins.render(new Uint8Array(buf));
  }

  onMessage(m) {
    if (m.type === 'A') {
      const ab = m.data instanceof ArrayBuffer ? m.data : m.data.buffer.slice(m.data.byteOffset, m.data.byteOffset + m.data.byteLength);
      const head = new Uint32Array(ab, 0, 4);
      const [seq, , frames] = head;
      const cb = this.renders.get(seq);
      this.renders.delete(seq);
      cb?.(new Float32Array(ab, 16, frames), new Float32Array(ab, 16 + frames * 4, frames));
    } else if (m.type === 'J') {
      const j = m.json;
      if (j.req != null && this.waiting.has(j.req)) {
        const w = this.waiting.get(j.req);
        this.waiting.delete(j.req);
        if (j.ok) w.resolve(j); else w.reject(new Error(j.error || 'Plugin error'));
      } else if (j.event) {
        this.dispatchEvent(new CustomEvent(j.event, { detail: j }));
      }
    } else if (m.type === 'exit') {
      for (const w of this.waiting.values()) w.reject(new Error('The plugin helper stopped'));
      this.waiting.clear();
      this.renders.clear();
      this.dispatchEvent(new CustomEvent('crash', { detail: m }));
    } else if (m.type === 'progress') {
      this.dispatchEvent(new CustomEvent('progress', { detail: m }));
    }
  }

  async load(def, { state, rate, block = 2048, offline = false }) {
    const inst = this.nextInst++;
    const res = await this.call('load', { inst, xml: def.desc.xml, state: state || '', rate, block, offline });
    return { inst, ...res };
  }
}

export const bridge = new Bridge();

// ------------------------------------------------------------------ song notes for one track

const noteOn = (n, v) => [0x90, n, Math.max(1, Math.min(127, Math.round(v * 127)))];
const noteOff = n => [0x80, n, 0];

// Note on/off events of a track in song beats, sorted (offs before ons at the same moment).
export function trackEvents(track, until = Infinity) {
  const out = [];
  for (const r of track.regions) {
    if (r.start >= until) continue;
    for (const n of expandRegion(r)) {
      out.push({ b: n.t, on: true, n: n.n, v: n.v });
      out.push({ b: Math.min(n.t + n.d, until), on: false, n: n.n });
    }
  }
  return out.sort((a, b) => a.b - b.b || a.on - b.on);
}

const firstAtOrAfter = (events, beat) => {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].b < beat - 1e-9) lo = mid + 1; else hi = mid; }
  return lo;
};

// Turns song notes into frame-stamped MIDI for windows of the audio clock.
//   anchor: {frame, beat}: the song is at `beat` when the clock reaches `frame`
export class SongCursor {
  constructor(project, track, anchor, sampleRate, cycle = null) {
    this.sr = sampleRate;
    this.anchor = anchor;
    this.held = new Set();
    this.update(project, track, cycle);
  }

  update(project, track, cycle = null) {
    this.project = project;
    this.events = trackEvents(track);
    this.cycle = cycle && this.anchor.beat < cycle.end - 1e-9 ? cycle : null;
  }

  // Pieces of song time covered by clock frames [f0, f1): {fa, fb, ta, tb (song seconds), wraps}.
  pieces(f0, f1) {
    const { frame, beat } = this.anchor, sr = this.sr, p = this.project;
    if (f1 <= frame) return [];
    const base = secAt(p, beat);
    let s = (Math.max(f0, frame) - frame) / sr;
    const s1 = (f1 - frame) / sr;
    const c = this.cycle;
    if (!c) return [{ fa: frame + s * sr, fb: f1, ta: base + s, tb: base + s1, wraps: false }];
    const first = secAt(p, c.end) - base, cs = secAt(p, c.start), period = secBetween(p, c.start, c.end);
    if (period <= 1e-6) return [];
    const out = [];
    while (s < s1 - 1e-12) {
      const k = s < first ? 0 : 1 + Math.floor((s - first) / period + 1e-9);
      const passStart = k === 0 ? 0 : first + (k - 1) * period;
      const passEnd = k === 0 ? first : first + k * period;
      const t = k === 0 ? base + s : cs + (s - passStart);
      const end = Math.min(s1, passEnd);
      out.push({ fa: frame + s * sr, fb: frame + end * sr, ta: t, tb: t + (end - s), wraps: end >= passEnd - 1e-12 });
      s = end;
    }
    return out;
  }

  // MIDI for clock frames [f0, f1) as [{frame, bytes}].
  collect(f0, f1) {
    const out = [];
    const p = this.project;
    for (const piece of this.pieces(f0, f1)) {
      const ba = beatAt(p, piece.ta), bb = beatAt(p, piece.tb);
      for (let i = firstAtOrAfter(this.events, ba); i < this.events.length && this.events[i].b < bb - 1e-9; i++) {
        const e = this.events[i];
        const frame = Math.floor(piece.fa + (secAt(p, e.b) - piece.ta) * this.sr);
        if (e.on) { this.held.add(e.n); out.push({ frame, bytes: noteOn(e.n, e.v) }); }
        else if (this.held.has(e.n)) { this.held.delete(e.n); out.push({ frame, bytes: noteOff(e.n) }); }
      }
      // The cycle jumps back: let go of everything still held.
      if (piece.wraps) out.push(...this.release(Math.max(f0, Math.floor(piece.fb) - 1)));
    }
    return out;
  }

  release(frame) {
    const out = [...this.held].map(n => ({ frame, bytes: noteOff(n) }));
    this.held.clear();
    return out;
  }

  position(frame) {
    const piece = this.pieces(frame, frame + 1)[0];
    if (!piece) return null;
    const beat = beatAt(this.project, piece.ta);
    return { beat, bpm: bpmAt(this.project, beat) };
  }
}

// ------------------------------------------------------------------ a live plugin instrument

// Same interface as the built-in instruments (output, play, noteOn, noteOff, stopAll, dispose), but
// song notes come from setPlayback() rather than the transport (selfScheduled).
export class PluginInstrument {
  static async create(def, { state = null, title = '', mode = 'balanced' } = {}) {
    const ctx = Tone.getContext();
    const loaded = await bridge.load(def, { state, rate: ctx.sampleRate });
    return new PluginInstrument(def, loaded, { title, mode });
  }

  constructor(def, loaded, { title, mode }) {
    this.def = def;
    this.inst = loaded.inst;
    this.hasEditor = loaded.hasEditor;
    this.title = title;
    this.selfScheduled = true;
    const ctx = Tone.getContext();
    this.sr = ctx.sampleRate;
    this.ahead = Math.round((AHEAD[mode] || AHEAD.balanced) * this.sr / CHUNK) * CHUNK;
    this.node = ctx.createAudioWorkletNode('bb-stream', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.output = new Tone.Gain(Tone.dbToGain(def.volume || 0));
    Tone.connect(this.node, this.output);
    this.renderedTo = null;
    this.inflight = 0;
    this.live = [];          // [{frame, bytes}] from playing and previews
    this.liveHeld = new Set();
    this.cursor = null;      // SongCursor while the song plays
    this.underruns = 0;
    this.node.port.onmessage = e => { this.underruns += e.data.late ? 1 : 0; this.pump(e.data.now); };
  }

  pump(now) {
    if (this.disposed) return;
    if (this.renderedTo == null || this.renderedTo < now) {
      if (this.renderedTo != null) this.underruns++;
      this.renderedTo = now + CHUNK;
    }
    const target = now + this.ahead;
    while (this.renderedTo < target && this.inflight < 16) {
      const frames = Math.min(2048, Math.ceil((target - this.renderedTo) / CHUNK) * CHUNK);
      const f0 = this.renderedTo, f1 = f0 + frames;
      const events = this.collect(f0, f1);
      const pos = this.cursor?.position(f0);
      this.inflight++;
      bridge.render(this.inst, frames, events, { bpm: pos?.bpm ?? 120, ppq: pos?.beat ?? 0, playing: !!pos }, (l, r) => {
        this.inflight--;
        if (!this.disposed) this.node.port.postMessage({ frame: f0, l, r });
      });
      this.renderedTo = f1;
    }
  }

  // Events for frames [f0, f1) relative to f0; anything already due plays at the start.
  collect(f0, f1) {
    const due = [];
    const keep = [];
    for (const e of this.live) (e.frame < f1 ? due : keep).push(e);
    this.live = keep;
    if (this.cursor) due.push(...this.cursor.collect(f0, f1));
    return due
      .map((e, i) => ({ offset: Math.max(0, Math.min(f1 - f0 - 1, e.frame - f0)), bytes: e.bytes, i }))
      .sort((a, b) => a.offset - b.offset || a.i - b.i);
  }

  frameOf(time) {
    return Math.round((time ?? Tone.immediate()) * this.sr);
  }

  // ---- the instrument interface (live playing, previews)
  noteOn(midi, time, vel = 0.8) {
    this.liveHeld.add(midi);
    this.live.push({ frame: this.frameOf(time), bytes: noteOn(midi, vel) });
  }

  noteOff(midi, time) {
    this.liveHeld.delete(midi);
    this.live.push({ frame: this.frameOf(time), bytes: noteOff(midi) });
  }

  play(midi, dur, time, vel = 0.8) {
    const at = this.frameOf(time);
    this.live.push({ frame: at, bytes: noteOn(midi, vel) });
    this.live.push({ frame: at + Math.max(1, Math.round(dur * this.sr)), bytes: noteOff(midi) });
  }

  // Sustain pedal (CC64) from the keyboard or a MIDI controller.
  sustain(down, time) {
    this.live.push({ frame: this.frameOf(time), bytes: [0xb0, 64, down ? 127 : 0] });
  }

  stopAll(time) {
    const frame = this.frameOf(time);
    const offs = this.cursor ? this.cursor.release(frame) : [];
    this.cursor = null;
    this.live = [
      ...offs,
      ...[...this.liveHeld].map(n => ({ frame, bytes: noteOff(n) })),
      { frame, bytes: [0xb0, 64, 0] },
      { frame, bytes: [0xb0, 123, 0] },
    ];
    this.liveHeld.clear();
  }

  // ---- song playback
  setPlayback(project, track, anchor, cycle) {
    const offs = this.cursor ? this.cursor.release(Math.round(anchor.frame)) : [];
    this.live.push(...offs);
    this.cursor = new SongCursor(project, track, anchor, this.sr, cycle);
  }

  updateSong(project, track, cycle) {
    this.cursor?.update(project, track, cycle);
  }

  // ---- plugin window and state
  showEditor(title = this.title) {
    return bridge.call('show', { inst: this.inst, title });
  }

  async getState() {
    try { return (await bridge.call('getState', { inst: this.inst })).state; } catch { return null; }
  }

  dispose() {
    this.disposed = true;
    bridge.send('unload', { inst: this.inst });
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.output.dispose();
  }
}

// ------------------------------------------------------------------ export

// Renders a plugin track faster than real time in a fresh copy of the plugin (same settings), for
// mixing into an offline export. Returns an AudioBuffer covering [start, end) plus the tail.
export async function renderPluginTrack(def, state, project, track, { start = 0, end, tail = 2.5, sampleRate }) {
  const total = Math.ceil((secBetween(project, start, end) + tail) * sampleRate);
  const loaded = await bridge.load(def, { state, rate: sampleRate, block: 2048, offline: true });
  const trimmed = { ...track, regions: track.regions.filter(r => r.start < end) };
  const cursor = new SongCursor(project, trimmed, { frame: 0, beat: start }, sampleRate);
  // Notes still sounding when the export range ends are released there (as Stop would).
  cursor.events = trackEvents(trimmed, end);
  const stopFrame = Math.round(secBetween(project, start, end) * sampleRate);
  const out = new AudioBuffer({ length: Math.max(1, total), sampleRate, numberOfChannels: 2 });
  const L = out.getChannelData(0), R = out.getChannelData(1);
  const CH = 8192;
  // If the helper dies mid-export, fail rather than wait forever.
  let onCrash;
  const crashed = new Promise((_, reject) => { onCrash = () => reject(new Error('The plugin helper stopped during export')); });
  bridge.addEventListener('crash', onCrash);
  crashed.catch(() => {});
  try {
    const jobs = [];
    for (let f0 = 0; f0 < total; f0 += CH) {
      const frames = Math.min(CH, total - f0);
      let events = cursor.collect(f0, f0 + frames);
      if (stopFrame >= f0 && stopFrame < f0 + frames) events = events.concat(cursor.release(stopFrame));
      const pos = cursor.position(f0);
      const list = events.map((e, i) => ({ offset: Math.max(0, Math.min(frames - 1, e.frame - f0)), bytes: e.bytes, i })).sort((a, b) => a.offset - b.offset || a.i - b.i);
      jobs.push(new Promise(resolve => bridge.render(loaded.inst, frames, list, { bpm: pos?.bpm ?? project.bpm, ppq: pos?.beat ?? 0, playing: true }, (l, r) => {
        L.set(l, f0);
        R.set(r, f0);
        resolve();
      })));
      // Keep a bounded number of chunks in flight.
      if (jobs.length >= 8) await Promise.race([jobs.shift(), crashed]);
    }
    await Promise.race([Promise.all(jobs), crashed]);
  } finally {
    bridge.removeEventListener('crash', onCrash);
    bridge.send('unload', { inst: loaded.inst });
  }
  return out;
}
