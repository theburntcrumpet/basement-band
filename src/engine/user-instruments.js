// Instruments the user brings: SoundFonts, SFZ files and folders of samples.
//
// Each library entry is a *source* ({kind, path, ...}) that expands into one or more instrument
// definitions. Loading a definition produces the regions a MultiSampler plays. A future
// plugin host (VST3/CLAP) would be another source kind with its own loader and player.

import { parseSf2, isDrumPreset } from './formats/soundfont.js';
import { parseSfz } from './formats/sfz.js';
import { audioMeta } from './formats/audiometa.js';
import { defaultRegion, ccDefaults } from './formats/region.js';

export const USER_CAT = 'My Instruments';
export const INSTRUMENT_FILE = /\.(sf2|sfz)$/i;

const defs = new Map();      // id -> instrument definition
let library = [];            // source entries from settings, in display order

const basename = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const stripExt = n => n.replace(/\.[^.]+$/, '');

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function instrumentId(entry, preset) {
  const base = `user:${hash(entry.path)}`;
  return preset ? `${base}:${preset.bank}:${preset.program}` : base;
}

function defsForEntry(entry) {
  const common = { cat: USER_CAT, type: 'user', volume: 0, sourceName: entry.name };
  if (entry.kind === 'sf2') {
    return entry.presets.map(p => ({
      ...common,
      id: instrumentId(entry, p),
      name: p.name,
      isKit: p.bank === 128,
      pieces: p.pieces,
      source: { kind: 'sf2', path: entry.path, bank: p.bank, program: p.program },
    }));
  }
  return [{
    ...common,
    id: instrumentId(entry),
    name: entry.name,
    isKit: !!entry.kit,
    pieces: entry.pieces,
    source: { kind: entry.kind, path: entry.path },
  }];
}

// Replaces the library (from settings) and registers every instrument it provides.
export function setLibrary(entries) {
  library = entries || [];
  for (const e of library) for (const d of defsForEntry(e)) defs.set(d.id, d);
}

export const getLibrary = () => library;
export const getUserDef = id => defs.get(id);
export const entryDefs = entry => defsForEntry(entry).map(d => defs.get(d.id) || d);

// Songs carry the definitions they use so they still open (and say what is missing) elsewhere.
export function registerDefs(map = {}) {
  for (const [id, d] of Object.entries(map)) if (!defs.has(id)) defs.set(id, { ...d, id, cat: USER_CAT, type: 'user' });
}

export function exportDefs(ids) {
  const out = {};
  for (const id of ids) {
    const d = defs.get(id);
    if (d) out[id] = { name: d.name, isKit: d.isKit, pieces: d.pieces, source: d.source, sourceName: d.sourceName };
  }
  return out;
}

// ------------------------------------------------------------------ file access

const files = new Map();
const readBytes = path => {
  if (!files.has(path)) {
    const p = window.host.readFile(path);
    p.catch(() => files.delete(path));
    files.set(path, p);
  }
  return files.get(path);
};
const readText = async path => new TextDecoder().decode(await window.host.readFile(path));

const sf2Cache = new Map();
function loadSf2(path) {
  if (!sf2Cache.has(path)) {
    const p = readBytes(path).then(parseSf2);
    p.catch(() => sf2Cache.delete(path));
    sf2Cache.set(path, p);
  }
  return sf2Cache.get(path);
}

const decoded = new Map();
function decodeFile(path, ctx) {
  if (!decoded.has(path)) {
    const p = window.host.readFile(path).then(async bytes => {
      const meta = audioMeta(bytes);
      const buffer = await ctx.decodeAudioData(bytes);
      return { buffer, meta };
    });
    p.catch(() => decoded.delete(path));
    decoded.set(path, p);
  }
  return decoded.get(path);
}

// ------------------------------------------------------------------ import-time inspection

// Reads a file or folder once and describes it for the library. kind: 'sf2' | 'sfz' | 'folder'.
export async function inspect(kind, path) {
  if (kind === 'sf2') {
    const sf = await loadSf2(path);
    const presets = sf.presets.map(p => {
      const out = { ...p };
      if (isDrumPreset(p)) out.pieces = keysOf(sf.regions(p.bank, p.program));
      return out;
    });
    if (!presets.length) throw new Error('This SoundFont has no presets');
    return { kind, path, name: sf.name || stripExt(basename(path)), presets };
  }
  if (kind === 'sfz') {
    const parsed = await parseSfz(await readText(path), { path, readText });
    if (!parsed.regions.length) throw new Error('No playable regions found in this SFZ');
    const kit = looksLikeKit(parsed.regions, path);
    return { kind, path, name: stripExt(basename(path)), kit, pieces: kit ? keysOf(parsed.regions) : undefined };
  }
  const plan = await folderPlan(path);
  if (!plan.regions.length) throw new Error('No audio files found in this folder');
  return { kind: 'folder', path, name: basename(path), kit: plan.kit, pieces: plan.kit ? keysOf(plan.regions) : undefined };
}

function keysOf(regions) {
  const keys = new Set();
  for (const r of regions) for (let k = Math.max(r.lokey, 27); k <= Math.min(r.hikey, 87); k++) keys.add(k);
  return [...keys].sort((a, b) => a - b);
}

function looksLikeKit(regions, path) {
  if (/drum|kit|perc/i.test(basename(path))) return true;
  const single = regions.filter(r => r.lokey === r.hikey && (r.keytrack === 0 || r.loop.mode === 'one_shot'));
  return single.length / regions.length > 0.6;
}

// ------------------------------------------------------------------ folders of samples

const NOTE_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
const KIT_WORDS = [
  [/kick|\bbd\b|bassdrum/i, 36], [/snare|\bsd\b/i, 38], [/clap/i, 39], [/rim|stick/i, 37],
  [/open.?h|ohh|hat.?open/i, 46], [/pedal|phh/i, 44], [/hat|hh|chh/i, 42], [/crash/i, 49], [/ride/i, 51],
  [/floor|tom.?(low|lo|1)\b/i, 41], [/tom.?(hi|high|3)\b/i, 48], [/tom/i, 45], [/splash/i, 55],
  [/cowbell/i, 56], [/tamb/i, 54], [/shak/i, 70], [/conga/i, 63], [/clave/i, 75],
];

export function noteFromName(name) {
  const base = stripExt(name);
  const matches = [...base.matchAll(/(?:^|[^a-z0-9#])([a-g])(#|b|s)?(-?[0-8])(?![0-9])/gi)];
  if (matches.length) {
    const m = matches[matches.length - 1];
    let pc = NOTE_PC[m[1].toLowerCase()];
    if (m[2] === '#' || m[2] === 's') pc++;
    if (m[2] === 'b') pc--;
    return pc + (Number(m[3]) + 1) * 12;
  }
  const num = /(?:^|\D)(\d{2,3})(?:\D|$)/.exec(base);
  if (num && Number(num[1]) >= 21 && Number(num[1]) <= 108) return Number(num[1]);
  return null;
}

function layerRank(name) {
  const base = stripExt(name).toLowerCase();
  const dyn = /(?:^|[^a-z])(ppp|pp|p|mp|mf|f|ff|fff)(?:[^a-z]|$)/.exec(base);
  if (dyn) return DYNAMICS.indexOf(dyn[1]);
  const v = /v(?:el)?[_-]?(\d+)/.exec(base);
  return v ? Number(v[1]) : 0;
}

// Pure planning from a file list, so it can be tested: melodic map or drum kit.
export function planFromFiles(list) {
  const named = list.map(f => ({ ...f, note: noteFromName(f.name) }));
  const melodic = named.filter(f => f.note != null).length >= Math.max(1, named.length * 0.5);
  const regions = [];
  if (melodic) {
    const byNote = new Map();
    for (const f of named.filter(f => f.note != null)) {
      if (!byNote.has(f.note)) byNote.set(f.note, []);
      byNote.get(f.note).push(f);
    }
    const roots = [...byNote.keys()].sort((a, b) => a - b);
    roots.forEach((root, i) => {
      const lo = i === 0 ? 0 : Math.floor((roots[i - 1] + root) / 2) + 1;
      const hi = i === roots.length - 1 ? 127 : Math.floor((root + roots[i + 1]) / 2);
      const layers = byNote.get(root).sort((a, b) => layerRank(a.name) - layerRank(b.name));
      layers.forEach((f, j) => {
        const r = defaultRegion();
        Object.assign(r, { sample: f.path, lokey: lo, hikey: hi, root });
        r.lovel = Math.floor((j * 127) / layers.length) + 1;
        r.hivel = Math.floor(((j + 1) * 127) / layers.length);
        r.env.release = 0.25;
        regions.push(r);
      });
    });
    return { kit: false, regions };
  }
  // Drum kit: name keywords pick the GM note; leftovers fill from 60 upward. Repeats round-robin.
  const pieces = new Map();
  let next = 60;
  for (const f of [...named].sort((a, b) => a.name.localeCompare(b.name))) {
    const hit = KIT_WORDS.find(([re]) => re.test(f.name));
    const key = hit ? hit[1] : next++;
    if (!pieces.has(key)) pieces.set(key, []);
    pieces.get(key).push(f);
  }
  for (const [key, group] of pieces) {
    group.forEach((f, j) => {
      const r = defaultRegion();
      Object.assign(r, { sample: f.path, lokey: key, hikey: key, root: key, keytrack: 0 });
      r.loop.mode = 'one_shot';
      if (group.length > 1) { r.seqLength = group.length; r.seqPosition = j + 1; }
      regions.push(r);
    });
  }
  return { kit: true, regions };
}

async function folderPlan(path) {
  const list = await window.host.scanFolder(path);
  return planFromFiles(list);
}

// ------------------------------------------------------------------ loading for playback

// Resolves to {regions (with buffers and seconds), initialSwitch, cc} for a MultiSampler.
export async function loadUserInstrument(def, ctx) {
  const src = def.source;
  if (src.kind === 'sf2') {
    const sf = await loadSf2(src.path);
    const regions = sf.regions(src.bank, src.program);
    const buffers = new Map();
    const bufferFor = r => {
      const key = `${r.sample}:${r.slice.startShift}:${r.slice.endShift}`;
      if (!buffers.has(key)) {
        const { data, rate } = sf.sampleData(r.sample, r.slice.startShift, r.slice.endShift);
        const buf = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: Math.max(3000, rate), numberOfChannels: 1 });
        buf.copyToChannel(data, 0);
        buffers.set(key, buf);
      }
      return buffers.get(key);
    };
    return { regions: regions.map(r => finalize(r, bufferFor(r), null)), initialSwitch: null, cc: ccDefaults() };
  }
  let parsed;
  if (src.kind === 'sfz') parsed = await parseSfz(await readText(src.path), { path: src.path, readText });
  else parsed = { ...(await folderPlan(src.path)), initialSwitch: null, cc: ccDefaults() };

  const samples = [...new Set(parsed.regions.map(r => r.sample))];
  const loaded = new Map();
  let failed = 0;
  // A few at a time keeps memory spikes and IPC traffic reasonable for big libraries.
  const queue = [...samples];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const path = queue.shift();
      try { loaded.set(path, await decodeFile(path, ctx)); } catch (err) { failed++; console.warn('Sample failed:', path, err); }
    }
  }));
  if (!loaded.size) throw new Error(`None of the ${samples.length} samples could be loaded`);
  const regions = parsed.regions.filter(r => loaded.has(r.sample)).map(r => {
    const { buffer, meta } = loaded.get(r.sample);
    return finalize(r, buffer, meta);
  });
  return { regions, initialSwitch: parsed.initialSwitch, cc: parsed.cc, failed };
}

// Converts frame-based fields to seconds against the decoded buffer.
function finalize(r, buffer, meta) {
  const rate = (meta && meta.rate) || r.sampleRate || buffer.sampleRate;
  const frames = r.loop.frames || meta?.loop || null;
  let mode = r.loop.mode;
  if (mode === 'auto') mode = frames ? 'continuous' : 'none';
  const out = { ...r, buffer, loopMode: mode };
  if (frames) {
    out.loopStart = Math.max(0, frames.start / rate);
    out.loopEnd = Math.min(buffer.duration, frames.end / rate);
  }
  if ((mode === 'continuous' || mode === 'sustain') && !(out.loopEnd > out.loopStart + 0.0005)) out.loopMode = 'none';
  out.offset = (r.offsetFrames || 0) / rate;
  out.offsetRandom = (r.offsetRandomFrames || 0) / rate;
  out.end = r.endFrames != null ? r.endFrames / rate : null;
  return out;
}
