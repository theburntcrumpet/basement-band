// Playing songs through the native engine (native/plugin-host/Source/Song.h): turns the song into
// the form the helper plays, and uploads the decoded samples its instruments use. The helper then
// does what scheduleProject() and the instrument classes do in the app's own engine.

import { bridge } from './plugins.js';
import { getInstrument, nativeParts } from './instruments.js';
import { noteToMidi } from '../music/theory.js';
import { meter } from '../music/meter.js';
import { expandRegion, isMuted } from './engine.js';

// ------------------------------------------------------------------ samples

const sampleIds = new WeakMap();   // AudioBuffer -> id
const uploaded = new Set();        // ids the running helper has
let nextId = 1;
bridge.addEventListener('crash', () => uploaded.clear());

function sampleId(buffer) {
  if (!sampleIds.has(buffer)) sampleIds.set(buffer, `s${nextId++}`);
  return sampleIds.get(buffer);
}

// Sends a decoded buffer to the helper once ('S' frame: id, rate, channels, frames, planar float32).
function upload(buffer) {
  const id = sampleId(buffer);
  if (uploaded.has(id)) return id;
  const idBytes = new TextEncoder().encode(id);
  const channels = Math.min(2, buffer.numberOfChannels), frames = buffer.length;
  const bytes = new Uint8Array(4 + idBytes.length + 16 + channels * frames * 4);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, idBytes.length, true);
  bytes.set(idBytes, 4);
  const o = 4 + idBytes.length;
  v.setFloat64(o, buffer.sampleRate, true);
  v.setUint32(o + 8, channels, true);
  v.setUint32(o + 12, frames, true);
  for (let c = 0; c < channels; c++) bytes.set(new Uint8Array(buffer.getChannelData(c).slice().buffer), o + 16 + c * frames * 4);
  window.host.plugins.upload(bytes);
  uploaded.add(id);
  return id;
}

// ------------------------------------------------------------------ instruments

// What the helper should play for an instrument, given its loaded buffers (as the app's engine
// loads them); null when the native engine can't play it yet.
const partsCache = new Map();
const partsFor = id => {
  if (!partsCache.has(id)) partsCache.set(id, nativeParts(id));
  return partsCache.get(id);
};

export function nativeInstrument(id, buffers) {
  const def = getInstrument(id);
  const parts = partsFor(id);
  if (!parts) return null;
  if (def.type === 'sampler') {
    const zones = {};
    for (const [note, buffer] of Object.entries(buffers || {})) zones[noteToMidi(note)] = upload(buffer);
    return { kind: 'sampler', zones, attack: def.attack || 0, release: def.release ?? 0.5, curve: 'exponential', ...parts };
  }
  if (def.type === 'user') {
    // SoundFont/SFZ/folder regions as the loader normalised them, each pointing at its uploaded sample.
    const regions = (buffers?.regions || []).filter(r => r.buffer).map(r => ({ ...r, buffer: undefined, sample: upload(r.buffer) }));
    return { ...parts, regions, initialSwitch: buffers?.initialSwitch ?? null, cc: buffers?.cc || {} };
  }
  if (def.type === 'kit') {
    const pieces = {};
    for (const [midi, layers] of Object.entries(buffers || {})) pieces[midi] = layers.map(upload);
    return { kind: 'kit', pieces, ...parts };
  }
  return parts;   // synth presets need no samples
}

// ------------------------------------------------------------------ the song

// project + each track's loaded instrument {id, buffers} -> the song the helper plays.
export function songForNative(project, instruments, { metronome = false } = {}) {
  const m = meter(project.timeSig);
  return {
    bpm: project.bpm,
    tempoChanges: project.tempoChanges || [],
    cycle: project.cycle || { on: false, start: 0, end: 4 },
    masterVolume: project.masterVolume ?? 0,
    metronome,
    meter: { num: m.num, pulse: m.pulse, compound: m.compound },
    tracks: project.tracks.filter(t => t.type !== 'audio').map(t => {
      const loaded = instruments.get(t.id);
      return {
        id: t.id,
        volume: t.volume ?? -4, pan: t.pan ?? 0, tone: t.tone ?? 1, drive: t.drive || 0,
        reverb: t.reverb || 0, echo: t.echo || 0, eqLow: t.eqLow || 0, eqMid: t.eqMid || 0, eqHigh: t.eqHigh || 0,
        mute: isMuted(project, t),
        instrument: loaded ? nativeInstrument(loaded.id, loaded.buffers) : null,
        notes: t.regions.flatMap(r => expandRegion(r)).map(n => [n.t, n.d, n.n, n.v]),
      };
    }),
  };
}

// Renders a range of the song offline in the helper (for export and checks): an AudioBuffer.
export async function renderNative(song, { start, end, tail = 2.5, sampleRate }) {
  const res = await bridge.call('song:render', { song, start, end, tail, rate: sampleRate });
  const bin = atob(res.output);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const all = new Float32Array(bytes.buffer);
  const out = new AudioBuffer({ length: res.frames, sampleRate, numberOfChannels: 2 });
  out.copyToChannel(all.subarray(0, res.frames), 0);
  out.copyToChannel(all.subarray(res.frames, res.frames * 2), 1);
  return out;
}
