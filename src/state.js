// Song model and the store (change notifications + undo/redo).

import { generate, STYLES, partInstrument, PART_LABELS } from './music/band.js';
import { getInstrument } from './engine/instruments.js';
import { meter, DEFAULT_TIME_SIG } from './music/meter.js';

export const uid = () => Math.random().toString(36).slice(2, 10);

export const TRACK_COLORS = { instrument: '#5fbf6a', drums: '#e7b43c', audio: '#4f9be8' };

export function newProject() {
  return {
    version: 1,
    name: 'Untitled',
    bpm: 110,
    key: { root: 0, scale: 'major' },
    timeSig: { ...DEFAULT_TIME_SIG },
    bars: 32,
    masterVolume: 0,
    masterFx: { type: 'none' },
    cycle: { on: false, start: 0, end: 16 },
    tracks: [],
  };
}

export function newTrack(type, instrument, name) {
  const inst = type === 'audio' ? null : getInstrument(instrument || (type === 'drums' ? 'kit-rock' : 'grand-piano'));
  return {
    id: uid(),
    type,
    name: name || (type === 'audio' ? 'Audio' : inst.name),
    instrument: inst?.id ?? null,
    volume: type === 'drums' ? -3 : -4,
    pan: 0,
    mute: false,
    solo: false,
    tone: 1,
    drive: 0,
    reverb: type === 'drums' ? 0.12 : 0.22,
    echo: 0,
    fx: { type: 'none' },
    amp: { model: 'off' },
    input: type === 'audio' ? { channel: 'left' } : undefined,
    regions: [],
  };
}

export function newMidiRegion(start, length, notes = [], extra = {}) {
  return { id: uid(), name: '', start, length, loopLength: length, notes, ...extra };
}

export const barBeats = project => meter(project.timeSig).barBeats;

// A region whose notes come from the band generator; it remembers how, so it can be re-rolled.
export function generatedRegion(gen, start, bars, project) {
  const notes = generate(gen, { key: project.key, timeSig: project.timeSig, bars });
  const style = STYLES[gen.style];
  return newMidiRegion(start, bars * barBeats(project), notes, { name: `${style.name} ${PART_LABELS[gen.part]}`, gen: { ...gen } });
}

export function regenerate(region, project) {
  // Partial bars round up; notes past the region's end are simply not played.
  const bars = Math.max(1, Math.ceil((region.loopLength || region.length) / barBeats(project) - 1e-6));
  region.notes = generate(region.gen, { key: project.key, timeSig: project.timeSig, bars });
}

// The notes a region actually plays, with loop repeats written out (positions relative to its start).
export function unrollNotes({ notes = [], length, loopLength }) {
  const loop = loopLength || length;
  if (loop >= length - 1e-6) return notes.map(n => ({ ...n }));
  const out = [];
  for (let off = 0; off < length - 1e-6; off += loop) {
    for (const n of notes) {
      if (n.t >= loop - 1e-6 || off + n.t >= length - 1e-6) continue;
      out.push({ ...n, t: off + n.t, d: Math.min(n.d, length - off - n.t) });
    }
  }
  return out;
}

// Resizing (rather than looping) a region. `base` is the region as it was when the drag began, so
// looped content is unrolled once and nothing is lost if the drag shrinks and then grows again.
// Generated parts write new bars instead, with fills moving to the new end.
export function resizeRegion(region, length, project, base = region) {
  if (!region.gen) region.notes = unrollNotes(base);
  region.length = length;
  region.loopLength = length;
  if (region.gen) regenerate(region, project);
}

// Switches meter while keeping every region on the same bar it started on. Generated regions are
// rewritten in the new meter (same number of bars); recorded notes and audio play as they were.
export function changeTimeSig(project, timeSig, ui) {
  const oldBar = barBeats(project);
  project.timeSig = { ...timeSig };
  const newBar = barBeats(project);
  const toNew = beats => (beats / oldBar) * newBar;
  for (const track of project.tracks) {
    for (const r of track.regions) {
      if (r.gen) {
        const loopBars = Math.max(1, Math.round((r.loopLength || r.length) / oldBar));
        const repeats = Math.max(1, Math.round(r.length / (r.loopLength || r.length)));
        r.loopLength = loopBars * newBar;
        r.length = r.loopLength * repeats;
        regenerate(r, project);
      } else if (track.type !== 'audio' && Math.abs(r.length % oldBar) < 1e-6 && r.loopLength === r.length) {
        // Whole-bar MIDI regions stay whole bars so the notes inside keep room.
        r.length = r.loopLength = Math.max(newBar, Math.ceil(r.length / newBar - 1e-6) * newBar);
      }
      r.start = toNew(r.start);
    }
  }
  project.cycle.start = toNew(project.cycle.start);
  project.cycle.end = Math.max(project.cycle.start + newBar, toNew(project.cycle.end));
  if (ui) ui.playhead = toNew(ui.playhead);
}

export function trackForPart(part, style) {
  const instrument = partInstrument(style, part);
  const t = newTrack(part === 'drums' ? 'drums' : 'instrument', instrument);
  if (part !== 'drums') t.name = `${PART_LABELS[part]} – ${getInstrument(instrument).name}`;
  if (part === 'pad') { t.volume = -9; t.reverb = 0.4; }
  if (part === 'arp') { t.volume = -10; t.echo = 0.25; t.reverb = 0.3; }
  if (part === 'bass') { t.reverb = 0.05; t.volume = -3; }
  return t;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.project = newProject();
    this.filePath = null;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.ui = {
      selectedTrack: null,
      selectedRegions: new Set(),
      editorRegion: null,
      playhead: 0,
      zoom: 26,
    };
  }

  emit(kind = 'change') {
    this.dispatchEvent(new CustomEvent(kind));
  }

  snapshot() {
    return JSON.stringify(this.project);
  }

  // Applies `fn` to the project as one undoable step.
  update(fn) {
    const before = this.gesture ?? this.snapshot();
    fn(this.project);
    if (!this.gesture) this.pushUndo(before);
    this.dirty = true;
    this.emit();
  }

  // Live edits during a drag: mutate freely, then commit once.
  beginGesture() {
    if (!this.gesture) this.gesture = this.snapshot();
  }

  endGesture() {
    if (!this.gesture) return;
    const before = this.gesture;
    this.gesture = null;
    if (before !== this.snapshot()) {
      this.pushUndo(before);
      this.dirty = true;
    }
    this.emit();
  }

  pushUndo(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.project = JSON.parse(this.undoStack.pop());
    this.fixSelection();
    this.emit();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.project = JSON.parse(this.redoStack.pop());
    this.fixSelection();
    this.emit();
  }

  load(project, filePath = null) {
    project.timeSig ??= { ...DEFAULT_TIME_SIG };
    project.masterFx ??= { type: 'none' };
    this.project = project;
    this.filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.ui.selectedTrack = project.tracks[0]?.id ?? null;
    this.ui.selectedRegions.clear();
    this.ui.editorRegion = null;
    this.ui.playhead = 0;
    this.emit('load');
    this.emit();
  }

  fixSelection() {
    const tracks = new Set(this.project.tracks.map(t => t.id));
    if (!tracks.has(this.ui.selectedTrack)) this.ui.selectedTrack = this.project.tracks[0]?.id ?? null;
    const regions = new Set(this.project.tracks.flatMap(t => t.regions.map(r => r.id)));
    for (const id of this.ui.selectedRegions) if (!regions.has(id)) this.ui.selectedRegions.delete(id);
    if (this.ui.editorRegion && !regions.has(this.ui.editorRegion)) this.ui.editorRegion = null;
  }

  track(id) {
    return this.project.tracks.find(t => t.id === id);
  }

  get selectedTrack() {
    return this.track(this.ui.selectedTrack);
  }

  findRegion(id) {
    for (const track of this.project.tracks) {
      const region = track.regions.find(r => r.id === id);
      if (region) return { track, region };
    }
    return null;
  }
}

export const store = new Store();
