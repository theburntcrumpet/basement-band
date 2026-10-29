// The built-in sound library: sampled instruments, synth presets and drum kits.
// createInstrument() builds in whatever Tone context is current, so the same code serves
// live playback and offline export.

import { INSTRUMENT_NOTES, PIANO_NOTES, VELOCITY_LAYERS, TR808_NAMES, FREESOUND_FX, SONICPI_FX } from './sample-manifest.js';
import { noteToMidi, midiToNote } from '../music/theory.js';
import { getUserDef, loadUserInstrument, USER_CAT } from './user-instruments.js';
import { MultiSampler } from './multisampler.js';
import { getPluginDef } from './plugins.js';

const Tone = window.Tone;
const SAMPLE_ROOT = 'samples/';

const notes = dir => (dir === 'piano' ? PIANO_NOTES : INSTRUMENT_NOTES[dir].split(' '));

// Sampled source: a folder of notes, optionally limited to a midi range when layering folders.
const src = (dir, lo = 0, hi = 127) => ({ dir, lo, hi });

export const CATEGORIES = ['Keyboards', 'Bass', 'Guitar', 'Strings', 'Brass', 'Woodwinds', 'Mallets', 'Synth', 'Drum Kits'];

export const INSTRUMENTS = [
  // Keyboards
  { id: 'grand-piano', name: 'Grand Piano', cat: 'Keyboards', type: 'sampler', sources: [src('piano')], release: 1.2, volume: 3.5 },
  { id: 'electric-piano', name: 'Electric Piano', cat: 'Keyboards', type: 'synth', preset: 'ep', volume: 8 },
  { id: 'tonewheel-organ', name: 'Tonewheel Organ', cat: 'Keyboards', type: 'synth', preset: 'organ', volume: -10.5 },
  { id: 'church-organ', name: 'Pipe Organ', cat: 'Keyboards', type: 'sampler', sources: [src('organ')], release: 0.6, volume: -5 },
  { id: 'harmonium', name: 'Harmonium', cat: 'Keyboards', type: 'sampler', sources: [src('harmonium')], release: 0.4, volume: -5 },
  { id: 'clav', name: 'Funky Clav', cat: 'Keyboards', type: 'synth', preset: 'clav', volume: -9 },
  // Bass
  { id: 'electric-bass', name: 'Electric Bass', cat: 'Bass', type: 'sampler', sources: [src('bass-electric')], release: 0.15, volume: -1 },
  { id: 'upright-bass', name: 'Upright Bass', cat: 'Bass', type: 'sampler', sources: [src('contrabass')], release: 0.25, volume: -2.5 },
  { id: 'synth-bass', name: 'Analog Bass', cat: 'Bass', type: 'synth', preset: 'synthBass', volume: -5.5 },
  { id: 'sub-bass', name: 'Sub Bass', cat: 'Bass', type: 'synth', preset: 'subBass', volume: -10.5 },
  // Guitar
  { id: 'acoustic-guitar', name: 'Acoustic Guitar', cat: 'Guitar', type: 'sampler', sources: [src('guitar-acoustic')], release: 0.6, volume: -1.5 },
  { id: 'nylon-guitar', name: 'Nylon Guitar', cat: 'Guitar', type: 'sampler', sources: [src('guitar-nylon')], release: 0.6, volume: -3 },
  { id: 'clean-guitar', name: 'Clean Electric', cat: 'Guitar', type: 'sampler', sources: [src('guitar-electric')], release: 0.3, volume: 1.5, fx: 'chorus' },
  { id: 'crunch-guitar', name: 'Crunch Guitar', cat: 'Guitar', type: 'sampler', sources: [src('guitar-electric')], release: 0.2, volume: -5.5, fx: 'amp' },
  // Strings
  { id: 'strings', name: 'String Section', cat: 'Strings', type: 'sampler', sources: [src('contrabass', 0, 35), src('cello', 36, 54), src('violin', 55)], attack: 0.08, release: 0.8, volume: -6 },
  { id: 'violin', name: 'Violin', cat: 'Strings', type: 'sampler', sources: [src('violin')], attack: 0.03, release: 0.6, volume: -5 },
  { id: 'cello', name: 'Cello', cat: 'Strings', type: 'sampler', sources: [src('cello')], attack: 0.03, release: 0.6, volume: -6 },
  { id: 'harp', name: 'Harp', cat: 'Strings', type: 'sampler', sources: [src('harp')], release: 1.5, volume: -5.5 },
  // Brass
  { id: 'brass', name: 'Brass Section', cat: 'Brass', type: 'sampler', sources: [src('tuba', 0, 40), src('trombone', 41, 57), src('trumpet', 58)], release: 0.3, volume: -5 },
  { id: 'trumpet', name: 'Trumpet', cat: 'Brass', type: 'sampler', sources: [src('trumpet')], release: 0.3, volume: -6 },
  { id: 'trombone', name: 'Trombone', cat: 'Brass', type: 'sampler', sources: [src('trombone')], release: 0.3, volume: -7 },
  { id: 'french-horn', name: 'French Horn', cat: 'Brass', type: 'sampler', sources: [src('french-horn')], release: 0.5, volume: -7.5 },
  { id: 'tuba', name: 'Tuba', cat: 'Brass', type: 'sampler', sources: [src('tuba')], release: 0.3, volume: -7 },
  // Woodwinds
  { id: 'saxophone', name: 'Tenor Sax', cat: 'Woodwinds', type: 'sampler', sources: [src('saxophone')], release: 0.3, volume: -7 },
  { id: 'flute', name: 'Flute', cat: 'Woodwinds', type: 'sampler', sources: [src('flute')], release: 0.4, volume: -4 },
  { id: 'clarinet', name: 'Clarinet', cat: 'Woodwinds', type: 'sampler', sources: [src('clarinet')], release: 0.3, volume: -7 },
  { id: 'bassoon', name: 'Bassoon', cat: 'Woodwinds', type: 'sampler', sources: [src('bassoon')], release: 0.3, volume: -5 },
  // Mallets
  { id: 'xylophone', name: 'Xylophone', cat: 'Mallets', type: 'sampler', sources: [src('xylophone')], release: 1, volume: -2 },
  { id: 'vibes', name: 'Vibraphone', cat: 'Mallets', type: 'synth', preset: 'vibes', volume: 7 },
  { id: 'bells', name: 'Glass Bells', cat: 'Mallets', type: 'synth', preset: 'bells', volume: 0 },
  // Synth
  { id: 'warm-pad', name: 'Warm Pad', cat: 'Synth', type: 'synth', preset: 'warmPad', volume: -5.5 },
  { id: 'glass-pad', name: 'Dream Pad', cat: 'Synth', type: 'synth', preset: 'glassPad', volume: -1 },
  { id: 'saw-lead', name: 'Saw Lead', cat: 'Synth', type: 'synth', preset: 'sawLead', volume: -7.5 },
  { id: 'square-lead', name: 'Square Lead', cat: 'Synth', type: 'synth', preset: 'squareLead', volume: -15.5 },
  { id: 'pluck', name: 'Pluck', cat: 'Synth', type: 'synth', preset: 'pluck', volume: 4 },
  { id: 'chip', name: '8-Bit', cat: 'Synth', type: 'synth', preset: 'chip', volume: -12 },
  // Drum kits
  { id: 'kit-rock', name: 'Rock Kit', cat: 'Drum Kits', type: 'kit', kit: 'rock', volume: -2 },
  { id: 'kit-lofi', name: 'Lo-Fi Kit', cat: 'Drum Kits', type: 'kit', kit: 'rock', fx: 'lofi', volume: -1 },
  { id: 'kit-808', name: '808 Kit', cat: 'Drum Kits', type: 'kit', kit: '808', volume: -3 },
  { id: 'kit-electro', name: 'Electro Kit', cat: 'Drum Kits', type: 'kit', kit: 'synth', volume: 0 },
];

export const INSTRUMENT_BY_ID = Object.fromEntries(INSTRUMENTS.map(i => [i.id, i]));
// Built-in sounds first, then the user's own (SoundFonts, SFZ, sample folders).
export const getInstrument = id => INSTRUMENT_BY_ID[id] || getUserDef(id) || getPluginDef(id) || INSTRUMENT_BY_ID['grand-piano'];
export const isKit = id => getInstrument(id).type === 'kit' || !!getInstrument(id).isKit;

// ------------------------------------------------------------------ drum kit maps

const ROCK_MAP = {
  36: 'Kick', 35: 'Kick', 37: 'SideStick', 38: 'Snare', 40: 'SnareRimshot', 41: 'TomFloor', 43: 'TomFloor',
  45: 'Tom2', 47: 'Tom2', 48: 'Tom1', 50: 'Tom1', 42: 'HatClosed', 44: 'HatPedal', 46: 'HatOpen',
  49: 'Crash', 57: 'Crash', 51: 'Ride', 59: 'Ride', 53: 'Bell', 55: 'Splash', 56: 'Cowbell',
};
const ROCK_SINGLE = { 39: 'drums-rock/HandClap.wav', 70: 'drums-808/808_Shaker.flac', 63: 'drums-808/808_Conga.flac', 75: 'drums-808/808_Clave.flac' };
const TR808_MAP = {
  36: '808_Kick_Long', 35: '808_Kick_Short', 38: '808_Snare_1', 40: '808_Snare_2', 39: '808_Clap', 37: '808_Clave',
  41: '808_Tom_Low', 43: '808_Tom_Low', 45: '808_Tom_Mid', 47: '808_Tom_Mid', 48: '808_Tom_Hi', 50: '808_Tom_Hi',
  42: '808_Hat_Closed', 44: '808_Hat_Pedal', 46: '808_Hat_Open', 49: '808_Cymbal', 51: '808_Cymbal', 53: '808_Cowbell',
  55: '808_Cymbal', 56: '808_Cowbell', 70: '808_Shaker', 63: '808_Conga', 75: '808_Clave',
};
const HAT_CHOKERS = new Set([42, 44]);

// midi -> [file per velocity layer, soft to hard]
function kitFiles(kit) {
  const map = {};
  if (kit === 'rock') {
    for (const [n, piece] of Object.entries(ROCK_MAP)) map[n] = VELOCITY_LAYERS.map(l => `drums-rock/${piece}-${l}.wav`);
    for (const [n, f] of Object.entries(ROCK_SINGLE)) map[n] = [f];
  } else if (kit === '808') {
    for (const [n, f] of Object.entries(TR808_MAP)) map[n] = [`drums-808/${f}.flac`];
  }
  return map;
}

// Lists the kit pieces each drum kit can play (used by the drum editor rows).
export function kitPieces(id) {
  const def = getInstrument(id);
  if (def.type === 'user') return def.pieces?.length ? def.pieces : [36, 38, 42, 46, 49];
  if (def.kit === 'synth') return [36, 38, 39, 42, 46, 45, 48, 49];
  return Object.keys(kitFiles(def.kit)).map(Number).filter(n => ![35, 43, 47, 50, 57, 59].includes(n)).sort((a, b) => a - b);
}

// Individual one-shots for the sample browser.
const FX_GROUPS = ['Whooshes', 'Hits & Drops', 'Waves', 'Wind', 'Rain & Thunder', 'Nature', 'Crowd', 'Fire & Vinyl', 'City', 'Drones & Pads'];

export function builtinSamples() {
  const out = [];
  const fx = [...FREESOUND_FX, ...SONICPI_FX];
  for (const group of FX_GROUPS) {
    for (const s of fx.filter(x => x.group === group)) out.push({ group, name: s.name, url: SAMPLE_ROOT + s.file, credit: s.author });
  }
  const rockNames = { Kick: 'Kick', SideStick: 'Side Stick', Snare: 'Snare', SnareRimshot: 'Rimshot', TomFloor: 'Floor Tom', Tom1: 'High Tom', Tom2: 'Low Tom', HatClosed: 'Hi-Hat Closed', HatPedal: 'Hi-Hat Pedal', HatSemiOpen: 'Hi-Hat Half Open', HatOpen: 'Hi-Hat Open', Ride: 'Ride', Bell: 'Ride Bell', Crash: 'Crash', Splash: 'Splash', Cowbell: 'Cowbell' };
  for (const [piece, label] of Object.entries(rockNames)) {
    out.push({ group: 'Rock Kit', name: label, url: `${SAMPLE_ROOT}drums-rock/${piece}-Hard.wav` });
  }
  out.push({ group: 'Rock Kit', name: 'Hand Clap', url: `${SAMPLE_ROOT}drums-rock/HandClap.wav` });
  for (const n of TR808_NAMES) out.push({ group: '808 Kit', name: n.replace('808_', '').replace(/_/g, ' '), url: `${SAMPLE_ROOT}drums-808/${n}.flac` });
  return out;
}

// ------------------------------------------------------------------ buffer loading

const bufferCache = new Map();

export function loadBuffer(url) {
  if (!bufferCache.has(url)) {
    const p = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
      .then(data => Tone.getContext().rawContext.decodeAudioData(data));
    p.catch(() => bufferCache.delete(url));
    bufferCache.set(url, p);
  }
  return bufferCache.get(url);
}

// Resolves to the AudioBuffers an instrument needs: {key: AudioBuffer | AudioBuffer[]}.
export async function loadInstrumentBuffers(id) {
  const def = getInstrument(id);
  if (def.type === 'user') return loadUserInstrument(def, Tone.getContext().rawContext);
  if (def.type === 'sampler') {
    const entries = [];
    for (const s of def.sources) {
      for (const name of notes(s.dir)) {
        const midi = noteToMidi(name);
        if (midi < s.lo || midi > s.hi) continue;
        entries.push([midi, `${SAMPLE_ROOT}${s.dir}/${name}.mp3`]);
      }
    }
    const loaded = await Promise.all(entries.map(([, url]) => loadBuffer(url)));
    return Object.fromEntries(entries.map(([midi], i) => [midiToNote(midi), loaded[i]]));
  }
  if (def.type === 'kit' && def.kit !== 'synth') {
    const files = kitFiles(def.kit);
    const out = {};
    await Promise.all(Object.entries(files).map(async ([n, list]) => {
      out[n] = await Promise.all(list.map(f => loadBuffer(SAMPLE_ROOT + f)));
    }));
    return out;
  }
  return {};
}

// ------------------------------------------------------------------ synth presets

const SYNTHS = {
  ep: () => {
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1, modulationIndex: 2.4,
      oscillator: { type: 'sine' }, modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 2.2, sustain: 0.18, release: 0.9 },
      modulationEnvelope: { attack: 0.002, decay: 0.45, sustain: 0.08, release: 0.6 },
    });
    synth.maxPolyphony = 48;
    return [synth, new Tone.Tremolo(4.2, 0.28).start(), new Tone.Chorus(1.1, 2.5, 0.35).start()];
  },
  organ: () => {
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'custom', partials: [1, 0.85, 0.6, 0.45, 0, 0.3, 0, 0.22] },
      envelope: { attack: 0.006, decay: 0.05, sustain: 1, release: 0.07 },
    });
    return [synth, new Tone.Chorus(5.8, 3, 0.55).start(), new Tone.Filter(5200, 'lowpass')];
  },
  clav: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'pulse', width: 0.25 },
      filter: { type: 'lowpass', rolloff: -24, Q: 4 },
      filterEnvelope: { attack: 0.001, decay: 0.16, sustain: 0.1, release: 0.1, baseFrequency: 500, octaves: 3.2 },
      envelope: { attack: 0.001, decay: 0.6, sustain: 0.2, release: 0.08 },
    });
    return [synth, new Tone.Chorus(2, 1.5, 0.2).start()];
  },
  synthBass: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
      filter: { type: 'lowpass', rolloff: -24, Q: 2.5 },
      filterEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.25, release: 0.2, baseFrequency: 110, octaves: 3.4 },
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.75, release: 0.12 },
    });
    return [synth];
  },
  subBass: () => {
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'custom', partials: [1, 0.18, 0.06] },
      envelope: { attack: 0.008, decay: 0.4, sustain: 0.85, release: 0.25 },
    });
    return [synth, new Tone.Distortion({ distortion: 0.25, wet: 0.25 })];
  },
  vibes: () => {
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 4, modulationIndex: 1.2,
      envelope: { attack: 0.001, decay: 2.4, sustain: 0, release: 1.6 },
      modulationEnvelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.3 },
    });
    return [synth, new Tone.Tremolo(5.5, 0.35).start()];
  },
  bells: () => {
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.5, modulationIndex: 5,
      envelope: { attack: 0.001, decay: 2.6, sustain: 0, release: 2.2 },
      modulationEnvelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.8 },
    });
    return [synth];
  },
  warmPad: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
      filter: { type: 'lowpass', rolloff: -24, Q: 0.6 },
      filterEnvelope: { attack: 1.2, decay: 1.5, sustain: 0.55, release: 2.4, baseFrequency: 280, octaves: 2.6 },
      envelope: { attack: 0.7, decay: 0.6, sustain: 0.85, release: 2.4 },
    });
    return [synth, new Tone.Chorus(0.6, 4, 0.6).start()];
  },
  glassPad: () => {
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2, modulationIndex: 1.6,
      oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
      envelope: { attack: 0.9, decay: 0.5, sustain: 0.85, release: 3 },
      modulationEnvelope: { attack: 1.6, decay: 0.5, sustain: 0.7, release: 3 },
    });
    return [synth, new Tone.Chorus(0.4, 3.5, 0.7).start(), new Tone.FeedbackDelay({ delayTime: 0.42, feedback: 0.35, wet: 0.25 })];
  },
  sawLead: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 18 },
      filter: { type: 'lowpass', rolloff: -24, Q: 1.6 },
      filterEnvelope: { attack: 0.01, decay: 0.35, sustain: 0.5, release: 0.4, baseFrequency: 700, octaves: 3 },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.75, release: 0.3 },
    });
    return [synth];
  },
  squareLead: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'square' },
      filter: { type: 'lowpass', rolloff: -12, Q: 1 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.3, baseFrequency: 1200, octaves: 2 },
      envelope: { attack: 0.004, decay: 0.15, sustain: 0.7, release: 0.2 },
    });
    return [synth, new Tone.Vibrato(5, 0.06)];
  },
  pluck: () => {
    const synth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: { type: 'fatsawtooth', count: 2, spread: 10 },
      filter: { type: 'lowpass', rolloff: -24, Q: 1.2 },
      filterEnvelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.2, baseFrequency: 260, octaves: 4.2 },
      envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.3 },
    });
    return [synth, new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.3, wet: 0.2 })];
  },
  chip: () => {
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.12, sustain: 0.5, release: 0.05 },
    });
    return [synth];
  },
};

// ------------------------------------------------------------------ instrument wrappers

// Common interface: output, play(midi, durSeconds, time, vel), noteOn, noteOff, stopAll, dispose.
class ToneInstrument {
  constructor(head, chain, volumeDb) {
    this.head = head;
    this.nodes = chain;
    this.output = new Tone.Gain(Tone.dbToGain(volumeDb));
    Tone.connectSeries(head, ...chain.slice(1), this.output);
  }
  play(midi, dur, time, vel) { this.head.triggerAttackRelease(midiToNote(midi), Math.max(0.02, dur), time, vel); }
  noteOn(midi, time, vel) { this.head.triggerAttack(midiToNote(midi), time, vel); }
  noteOff(midi, time) { this.head.triggerRelease(midiToNote(midi), time); }
  stopAll(time) { this.head.releaseAll?.(time); }
  dispose() { this.nodes.forEach(n => n.dispose()); this.output.dispose(); }
}

function samplerFx(kind) {
  if (kind === 'chorus') return [new Tone.Chorus(1.5, 2, 0.25).start()];
  if (kind === 'amp') {
    return [
      new Tone.Filter(180, 'highpass'),
      new Tone.Distortion({ distortion: 0.55, oversample: '2x' }),
      new Tone.Filter({ frequency: 3800, type: 'lowpass', rolloff: -24 }),
    ];
  }
  return [];
}

class DrumKit {
  constructor(def, buffers) {
    this.output = new Tone.Gain(Tone.dbToGain(def.volume));
    this.bus = new Tone.Gain();
    this.extra = [];
    if (def.fx === 'lofi') {
      this.extra = [new Tone.Filter({ frequency: 2600, type: 'lowpass', rolloff: -24 }), new Tone.Distortion({ distortion: 0.2, wet: 0.35 }), new Tone.Filter(70, 'highpass')];
    }
    Tone.connectSeries(this.bus, ...this.extra, this.output);
    this.buffers = buffers;
    this.offline = this.bus.context.isOffline;
    this.openHats = new Set();
    if (def.kit === 'synth') this.synths = makeSynthKit(this.bus);
  }
  play(midi, _dur, time, vel = 0.8) {
    if (this.synths) return this.synths.play(midi, time, vel);
    const layers = this.buffers[midi];
    if (!layers) return;
    const buffer = layers[Math.min(layers.length - 1, Math.floor(vel * layers.length))];
    if (HAT_CHOKERS.has(midi)) {
      this.openHats.forEach(s => { try { s.stop(time); } catch { /* already stopped */ } });
      this.openHats.clear();
    }
    // Pass the context explicitly: during offline export this runs after Tone has switched back to the live context.
    const source = new Tone.ToneBufferSource({ context: this.bus.context, url: buffer, fadeOut: 0.04 }).connect(this.bus);
    // Offline renders fire onended before the audio is rendered, so only clean up live one-shots.
    source.onended = () => { this.openHats.delete(source); if (!this.offline) source.dispose(); };
    const gain = layers.length > 1 ? 0.55 + 0.45 * vel : 0.15 + 0.85 * vel;
    source.start(time, 0, buffer.duration, gain);
    if (midi === 46) this.openHats.add(source);
  }
  noteOn(midi, time, vel) { this.play(midi, 0.25, time, vel); }
  noteOff() {}
  stopAll(time) { this.openHats.forEach(s => { try { s.stop(time); } catch { /* ignore */ } }); }
  dispose() {
    this.synths?.dispose();
    this.extra.forEach(n => n.dispose());
    this.bus.dispose();
    this.output.dispose();
  }
}

function makeSynthKit(out) {
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.045, octaves: 7, envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.2 } }).connect(out);
  const snareNoise = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.18, sustain: 0 } });
  const snareFilter = new Tone.Filter(1800, 'bandpass');
  snareNoise.chain(snareFilter, out);
  const snareBody = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, envelope: { attack: 0.001, decay: 0.12, sustain: 0 } }).connect(out);
  const clap = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.003, decay: 0.22, sustain: 0 } });
  const clapFilter = new Tone.Filter(1200, 'bandpass');
  clap.chain(clapFilter, out);
  const hat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.06, release: 0.01 }, harmonicity: 5.1, modulationIndex: 32, resonance: 6000, octaves: 1.5 }).connect(out);
  const openHat = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.4, release: 0.1 }, harmonicity: 5.1, modulationIndex: 32, resonance: 5000, octaves: 1.5 }).connect(out);
  const tom = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.4, sustain: 0 } }).connect(out);
  const crash = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 1.4, release: 0.5 }, harmonicity: 5.1, modulationIndex: 40, resonance: 4000, octaves: 1.5 }).connect(out);
  hat.volume.value = -18; openHat.volume.value = -20; crash.volume.value = -22;
  snareNoise.volume.value = -6; clap.volume.value = -4; snareBody.volume.value = -8;
  const all = [kick, snareNoise, snareFilter, snareBody, clap, clapFilter, hat, openHat, tom, crash];
  return {
    play(midi, time, vel) {
      switch (midi) {
        case 35: case 36: kick.triggerAttackRelease('C1', 0.3, time, vel); break;
        case 37: case 38: case 40: snareNoise.triggerAttackRelease(0.15, time, vel); snareBody.triggerAttackRelease('G2', 0.1, time, vel * 0.8); break;
        case 39: clap.triggerAttackRelease(0.2, time, vel); break;
        case 42: case 44: openHat.triggerRelease(time); hat.triggerAttackRelease(400, 0.05, time, vel); break;
        case 46: openHat.triggerAttackRelease(400, 0.35, time, vel); break;
        case 41: case 43: tom.triggerAttackRelease('A1', 0.3, time, vel); break;
        case 45: case 47: tom.triggerAttackRelease('D2', 0.3, time, vel); break;
        case 48: case 50: tom.triggerAttackRelease('G2', 0.3, time, vel); break;
        case 49: case 51: case 55: case 57: crash.triggerAttackRelease(300, 1, time, vel * 0.8); break;
        default: hat.triggerAttackRelease(600, 0.03, time, vel * 0.6);
      }
    },
    dispose() { all.forEach(n => n.dispose()); },
  };
}

// Builds a playable instrument in the current Tone context from preloaded buffers.
export function createInstrument(id, buffers = {}) {
  const def = getInstrument(id);
  if (def.type === 'plugin') throw new Error('Plugins are loaded by the engine (PluginInstrument)');
  if (def.type === 'user') return new MultiSampler(buffers, def.volume);
  if (def.type === 'kit') return new DrumKit(def, buffers);
  if (def.type === 'sampler') {
    const sampler = new Tone.Sampler({ urls: buffers, attack: def.attack || 0, release: def.release ?? 0.5, curve: 'exponential' });
    return new ToneInstrument(sampler, [sampler, ...samplerFx(def.fx)], def.volume);
  }
  const chain = SYNTHS[def.preset]();
  return new ToneInstrument(chain[0], chain, def.volume);
}

// Sampled instruments whose files failed to load fall back to a synth of the same family.
export function fallbackFor(id) {
  const def = getInstrument(id);
  if (def.cat === USER_CAT) return def.isKit ? 'kit-electro' : 'electric-piano';
  const cat = def.cat;
  return { Bass: 'synth-bass', Guitar: 'pluck', Strings: 'warm-pad', Brass: 'saw-lead', Woodwinds: 'square-lead', Mallets: 'vibes', 'Drum Kits': 'kit-electro' }[cat] || 'electric-piano';
}
