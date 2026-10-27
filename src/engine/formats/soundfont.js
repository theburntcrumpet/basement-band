// SoundFont 2 (.sf2) parser: presets and their sample zones as normalized regions.
// Follows the SF2.04 spec: global zones, preset generators added to instrument generators,
// key/velocity ranges intersected, timecent/centibel units converted to seconds/dB.

import { defaultRegion } from './region.js';

const G = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, initialFilterFc: 8, initialFilterQ: 9, modEnvToFilterFc: 11,
  endAddrsCoarseOffset: 12, pan: 17, delayModEnv: 25, attackModEnv: 26, holdModEnv: 27,
  decayModEnv: 28, sustainModEnv: 29, releaseModEnv: 30, delayVolEnv: 33, attackVolEnv: 34,
  holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38, instrument: 41,
  keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, keynum: 46, velocity: 47,
  initialAttenuation: 48, endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
};

const DEFAULTS = {
  [G.initialFilterFc]: 13500, [G.delayModEnv]: -12000, [G.attackModEnv]: -12000, [G.holdModEnv]: -12000,
  [G.decayModEnv]: -12000, [G.releaseModEnv]: -12000, [G.delayVolEnv]: -12000, [G.attackVolEnv]: -12000,
  [G.holdVolEnv]: -12000, [G.decayVolEnv]: -12000, [G.releaseVolEnv]: -12000, [G.scaleTuning]: 100,
  [G.overridingRootKey]: -1, [G.keynum]: -1, [G.velocity]: -1,
};

// Generators that only make sense at instrument level (not summed from presets).
const INSTRUMENT_ONLY = new Set([0, 1, 2, 3, 4, 12, 45, 50, 46, 47, 53, 54, 57, 58]);
const RANGE = new Set([G.keyRange, G.velRange]);

const str = (v, o, n) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = v.getUint8(o + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
};

function chunks(v, start, end) {
  const out = {};
  for (let o = start; o + 8 <= end;) {
    const id = str(v, o, 4);
    const size = v.getUint32(o + 4, true);
    if (id === 'LIST') out[str(v, o + 8, 4)] = { start: o + 12, end: o + 8 + size };
    else out[id] = { start: o + 8, size };
    o += 8 + size + (size & 1);
  }
  return out;
}

function records(v, chunk, size, read) {
  const out = [];
  if (!chunk) return out;
  for (let o = chunk.start; o + size <= chunk.start + chunk.size; o += size) out.push(read(o));
  return out;
}

export function parseSf2(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (str(v, 0, 4) !== 'RIFF' || str(v, 8, 4) !== 'sfbk') throw new Error('Not a SoundFont 2 file');
  const top = chunks(v, 12, Math.min(v.byteLength, 8 + v.getUint32(4, true)));
  if (!top.sdta || !top.pdta) throw new Error('SoundFont is missing sample or preset data');
  const sdta = chunks(v, top.sdta.start, top.sdta.end);
  const pdta = chunks(v, top.pdta.start, top.pdta.end);
  const info = top.INFO ? chunks(v, top.INFO.start, top.INFO.end) : {};
  const name = info.INAM ? str(v, info.INAM.start, info.INAM.size) : '';

  const phdr = records(v, pdta.phdr, 38, o => ({ name: str(v, o, 20), program: v.getUint16(o + 20, true), bank: v.getUint16(o + 22, true), bag: v.getUint16(o + 24, true) }));
  const pbag = records(v, pdta.pbag, 4, o => v.getUint16(o, true));
  const pgen = records(v, pdta.pgen, 4, o => [v.getUint16(o, true), v.getInt16(o + 2, true), v.getUint8(o + 2), v.getUint8(o + 3)]);
  const inst = records(v, pdta.inst, 22, o => ({ name: str(v, o, 20), bag: v.getUint16(o + 20, true) }));
  const ibag = records(v, pdta.ibag, 4, o => v.getUint16(o, true));
  const igen = records(v, pdta.igen, 4, o => [v.getUint16(o, true), v.getInt16(o + 2, true), v.getUint8(o + 2), v.getUint8(o + 3)]);
  const shdr = records(v, pdta.shdr, 46, o => ({
    name: str(v, o, 20), start: v.getUint32(o + 20, true), end: v.getUint32(o + 24, true),
    loopStart: v.getUint32(o + 28, true), loopEnd: v.getUint32(o + 32, true), rate: v.getUint32(o + 36, true),
    pitch: v.getUint8(o + 40), correction: v.getInt8(o + 41), type: v.getUint16(o + 44, true),
  }));
  if (shdr.some(s => s.type & 0x10)) throw new Error('Compressed SoundFonts (.sf3) are not supported yet');

  // Zones: list of generator maps for each bag range. The first zone is global if it lacks its terminal generator.
  const zones = (bags, gens, from, to, terminal) => {
    const list = [];
    for (let b = from; b < to; b++) {
      const z = new Map();
      for (let g = bags[b]; g < bags[b + 1]; g++) {
        const [op, amount, lo, hi] = gens[g];
        z.set(op, RANGE.has(op) ? [lo, hi] : amount);
      }
      list.push(z);
    }
    let global = new Map();
    if (list.length && !list[0].has(terminal)) global = list.shift();
    return { global, zones: list.filter(z => z.has(terminal)) };
  };

  const instruments = inst.slice(0, -1).map((ins, i) => zones(ibag, igen, ins.bag, inst[i + 1].bag, G.sampleID));
  const presets = phdr.slice(0, -1).map((p, i) => ({ ...p, end: phdr[i + 1].bag }));

  const smpl = sdta.smpl;
  return {
    name,
    presets: presets.map(p => ({ name: p.name, bank: p.bank, program: p.program })).sort((a, b) => a.bank - b.bank || a.program - b.program),
    samples: shdr,
    // Normalized regions for one preset (bank/program).
    regions(bank, program) {
      const p = presets.find(x => x.bank === bank && x.program === program);
      if (!p) throw new Error(`Preset ${bank}:${program} not found`);
      const pz = zones(pbag, pgen, p.bag, p.end, G.instrument);
      const out = [];
      for (const pzone of pz.zones) {
        const pg = new Map([...pz.global, ...pzone]);
        const ins = instruments[pg.get(G.instrument)];
        if (!ins) continue;
        for (const izone of ins.zones) {
          const ig = new Map([...ins.global, ...izone]);
          const region = toRegion(pg, ig, shdr);
          if (region) out.push(region);
        }
      }
      return out;
    },
    // 16-bit PCM for one sample header, as floats, plus its loop points relative to the slice.
    sampleData(index, extraStart = 0, extraEnd = 0) {
      const s = shdr[index];
      const start = s.start + extraStart, end = s.end + extraEnd;
      const n = Math.max(0, end - start);
      const data = new Float32Array(n);
      const base = smpl.start + start * 2;
      for (let i = 0; i < n; i++) data[i] = v.getInt16(base + i * 2, true) / 32768;
      return { data, rate: s.rate };
    },
  };
}

const tc = t => Math.pow(2, t / 1200);           // timecents -> seconds
const gainOfCb = cb => Math.pow(10, -cb / 200);  // centibels of attenuation -> linear

function toRegion(pg, ig, shdr) {
  const get = op => {
    const base = ig.has(op) ? ig.get(op) : DEFAULTS[op] ?? 0;
    if (INSTRUMENT_ONLY.has(op) || RANGE.has(op)) return base;
    return base + (pg.get(op) ?? 0);
  };
  const range = op => {
    const a = ig.get(op) ?? [0, 127], b = pg.get(op) ?? [0, 127];
    return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  };
  const s = shdr[ig.get(G.sampleID)];
  if (!s) return null;
  const [lokey, hikey] = range(G.keyRange);
  const [lovel, hivel] = range(G.velRange);
  if (lokey > hikey || lovel > hivel) return null;

  const r = defaultRegion();
  r.sample = ig.get(G.sampleID);
  r.lokey = lokey; r.hikey = hikey; r.lovel = Math.max(1, lovel); r.hivel = hivel;
  const rootOverride = get(G.overridingRootKey);
  r.root = rootOverride >= 0 ? rootOverride : s.pitch > 127 ? 60 : s.pitch;
  r.keytrack = get(G.scaleTuning) / 100;
  r.tune = get(G.coarseTune) * 100 + get(G.fineTune) + s.correction;
  r.gainDb = -get(G.initialAttenuation) / 10;
  r.pan = Math.max(-1, Math.min(1, get(G.pan) / 500));
  // Stereo pairs without explicit pan go hard left/right.
  if (!r.pan && (s.type & 4)) r.pan = -1;
  if (!r.pan && (s.type & 2) && !(s.type & 1)) r.pan = 1;
  r.env = {
    delay: tc(get(G.delayVolEnv)), attack: tc(get(G.attackVolEnv)), hold: tc(get(G.holdVolEnv)),
    decay: tc(get(G.decayVolEnv)), sustain: gainOfCb(Math.max(0, Math.min(1440, get(G.sustainVolEnv)))),
    release: tc(get(G.releaseVolEnv)),
  };
  const mode = get(G.sampleModes) & 3;
  r.loop.mode = mode === 1 ? 'continuous' : mode === 3 ? 'sustain' : 'none';

  // Sample addresses (frames). The region plays a slice of the shared sample data.
  const startShift = get(G.startAddrsOffset) + 32768 * get(G.startAddrsCoarseOffset);
  const endShift = get(G.endAddrsOffset) + 32768 * get(G.endAddrsCoarseOffset);
  const loopStart = s.loopStart + get(G.startloopAddrsOffset) + 32768 * get(G.startloopAddrsCoarseOffset);
  const loopEnd = s.loopEnd + get(G.endloopAddrsOffset) + 32768 * get(G.endloopAddrsCoarseOffset);
  r.slice = { startShift, endShift };
  r.loop.frames = { start: loopStart - (s.start + startShift), end: loopEnd - (s.start + startShift) };
  r.sampleRate = s.rate;
  r.group = get(G.exclusiveClass);
  r.offBy = r.group || null;

  const fc = get(G.initialFilterFc);
  const egDepth = get(G.modEnvToFilterFc);
  if (fc < 13500 || egDepth) {
    r.filter = {
      type: 'lowpass',
      cutoff: 8.176 * Math.pow(2, Math.min(13500, fc) / 1200),
      resonance: get(G.initialFilterQ) / 10,
      keytrack: 0, keycenter: 60, veltrack: 0,
      egDepth,
      eg: {
        delay: tc(get(G.delayModEnv)), attack: tc(get(G.attackModEnv)), hold: tc(get(G.holdModEnv)),
        decay: tc(get(G.decayModEnv)), sustain: 1 - Math.max(0, Math.min(1000, get(G.sustainModEnv))) / 1000,
        release: tc(get(G.releaseModEnv)),
      },
    };
  }
  return r;
}

// GM-style drum kits live in bank 128.
export const isDrumPreset = preset => preset.bank === 128;
