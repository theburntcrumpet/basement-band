// SFZ instrument parser. Produces the same normalized regions as the SF2 parser (see region.js).
// Supports the opcodes real libraries lean on: key/velocity zones, envelopes, loops, offsets,
// filters with envelopes, round-robin/random, choke groups, CC conditions and modulation
// (evaluated at their set_ccN defaults), keyswitches, release triggers, #define and #include.

import { defaultRegion, ccDefaults } from './region.js';

const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function sfzKey(value) {
  const v = String(value).trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  const m = /^([a-gA-G])([#b♯♭]?)(-?\d+)$/.exec(v);
  if (!m) return null;
  let pc = NOTE[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === '♯') pc++;
  if (m[2] === 'b' || m[2] === '♭') pc--;
  return pc + (Number(m[3]) + 1) * 12;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Expands #include (via readText) and #define, in file order. readText(path) -> Promise<string>.
export async function preprocess(text, { baseDir = '', readText, defines = new Map(), depth = 0 } = {}) {
  if (depth > 16) throw new Error('SFZ #include nested too deeply');
  const lines = stripComments(text).split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    // Longest names first so $VEL doesn't clobber $VEL2.
    for (const [name, value] of [...defines].sort((x, y) => y[0].length - x[0].length)) line = line.split(name).join(value);
    const def = /^\s*#define\s+(\$\w+)\s+(.*?)\s*$/.exec(line);
    if (def) { defines.set(def[1], def[2]); continue; }
    const inc = /^\s*#include\s+"([^"]+)"/.exec(line);
    if (inc) {
      if (!readText) continue;
      const path = joinPath(baseDir, inc[1]);
      const sub = await readText(path);
      out.push(await preprocess(sub, { baseDir, readText, defines, depth: depth + 1 }));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function joinPath(base, rel) {
  const r = rel.replace(/\\/g, '/');
  if (/^([a-zA-Z]:)?\//.test(r) || !base) return normalizePath(r);
  return normalizePath(base.replace(/\\/g, '/').replace(/\/?$/, '/') + r);
}

function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '..' && parts.length && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/').replace(/\/{2,}/g, '/');
}

// Splits preprocessed text into [{header, opcodes}] in order.
export function tokenize(text) {
  const sections = [];
  const re = /<(\w+)>/g;
  let m, last = null, lastEnd = 0;
  const flush = end => {
    if (!last) return;
    last.opcodes = parseOpcodes(text.slice(lastEnd, end));
    sections.push(last);
  };
  while ((m = re.exec(text))) {
    flush(m.index);
    last = { header: m[1].toLowerCase() };
    lastEnd = m.index + m[0].length;
  }
  flush(text.length);
  return sections;
}

// A value runs until the next "name=" so sample paths can contain spaces.
function parseOpcodes(chunk) {
  const out = {};
  const re = /([A-Za-z0-9_]+)=/g;
  const hits = [];
  let m;
  while ((m = re.exec(chunk))) hits.push({ name: m[1], start: m.index, valueStart: re.lastIndex });
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : chunk.length;
    out[hit.name] = chunk.slice(hit.valueStart, end).trim();
  });
  return out;
}

// Flattens <global>/<master>/<group>/<region> inheritance. Returns {control, regions: [opcodes]}.
export function flatten(sections) {
  let control = {}, global = {}, master = {}, group = {};
  const regions = [];
  for (const s of sections) {
    switch (s.header) {
      case 'control': control = { ...control, ...s.opcodes }; break;
      case 'global': global = s.opcodes; master = {}; group = {}; break;
      case 'master': master = s.opcodes; group = {}; break;
      case 'group': group = s.opcodes; break;
      case 'region': regions.push({ ...global, ...master, ...group, ...s.opcodes }); break;
      default: break; // <curve>, <effect>, <midi>: not used for playback here
    }
  }
  return { control, regions };
}

const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

// Applies CC-driven offsets (e.g. ampeg_decay_oncc102=10 with set_cc102=64) at the CC defaults.
function applyCcModulation(op, cc) {
  const out = { ...op };
  for (const [name, value] of Object.entries(op)) {
    const m = /^(.+?)_?(?:on)?cc(\d+)$/.exec(name);
    if (!m || /^(lo|hi)$/.test(m[1]) || m[1].startsWith('label') || m[1].startsWith('set')) continue;
    const target = m[1];
    const amount = num(value) * ((cc[Number(m[2])] ?? 0) / 127);
    if (!amount) continue;
    if (target === 'cutoff' || target === 'cutoff2') out[target] = num(out[target], 0) * Math.pow(2, amount / 1200);
    else out[target] = String(num(out[target], 0) + amount);
  }
  return out;
}

const FIL_TYPES = { lpf_1p: 'lowpass', lpf_2p: 'lowpass', lpf_4p: 'lowpass', lpf_6p: 'lowpass', hpf_1p: 'highpass', hpf_2p: 'highpass', hpf_4p: 'highpass', hpf_6p: 'highpass', bpf_1p: 'bandpass', bpf_2p: 'bandpass', brf_1p: 'notch', brf_2p: 'notch' };

// Turns flattened opcodes into normalized regions. sampleDir is where sample paths resolve from.
export function normalizeSfz({ control, regions }, sampleDir = '') {
  const cc = ccDefaults();
  for (const [name, value] of Object.entries(control)) {
    const m = /^set_cc(\d+)$/.exec(name);
    if (m) cc[Number(m[1])] = num(value);
  }
  const defaultPath = (control.default_path || '').replace(/\\/g, '/');
  const noteShift = num(control.note_offset) + 12 * num(control.octave_offset);
  let swDefault = null;

  const out = [];
  for (const raw of regions) {
    if (!raw.sample) continue;
    const op = applyCcModulation(raw, cc);
    const r = defaultRegion();
    if (op.sample.startsWith('*')) continue; // generators like *sine are not supported
    r.sample = joinPath(sampleDir, defaultPath + op.sample);
    if (op.key != null) {
      const k = sfzKey(op.key);
      r.lokey = r.hikey = r.root = k;
    }
    if (op.lokey != null) r.lokey = sfzKey(op.lokey) ?? r.lokey;
    if (op.hikey != null) r.hikey = sfzKey(op.hikey) ?? r.hikey;
    if (op.pitch_keycenter != null && op.pitch_keycenter !== 'sample') r.root = sfzKey(op.pitch_keycenter) ?? r.root;
    if (noteShift) { r.lokey += noteShift; r.hikey += noteShift; r.root += noteShift; }
    r.lovel = num(op.lovel, 1);
    r.hivel = num(op.hivel, 127);
    r.keytrack = num(op.pitch_keytrack, 100) / 100;
    r.tune = num(op.tune) + 100 * num(op.transpose);
    r.gainDb = num(op.volume) + (op.amplitude != null ? 20 * Math.log10(Math.max(1e-4, num(op.amplitude) / 100)) : 0);
    r.pan = Math.max(-1, Math.min(1, num(op.pan) / 100));
    r.veltrack = num(op.amp_veltrack, 100) / 100;
    const curve = Object.entries(op).filter(([k]) => /^amp_velcurve_\d+$/.test(k)).map(([k, v]) => [Number(k.slice(13)), num(v)]);
    if (curve.length) r.velcurve = curve.sort((a, b) => a[0] - b[0]);
    r.env = {
      delay: num(op.ampeg_delay), attack: num(op.ampeg_attack), hold: num(op.ampeg_hold),
      decay: num(op.ampeg_decay), sustain: Math.max(0, Math.min(1, num(op.ampeg_sustain, 100) / 100)),
      release: num(op.ampeg_release, 0.001),
    };
    const mode = op.loop_mode || op.loopmode;
    r.loop.mode = mode === 'loop_continuous' ? 'continuous' : mode === 'loop_sustain' ? 'sustain' : mode === 'one_shot' ? 'one_shot' : mode === 'no_loop' ? 'none' : 'auto';
    const ls = op.loop_start ?? op.loopstart, le = op.loop_end ?? op.loopend;
    if (ls != null && le != null) r.loop.frames = { start: num(ls), end: num(le) + 1 };
    r.offsetFrames = num(op.offset);
    r.offsetRandomFrames = num(op.offset_random);
    r.endFrames = op.end != null ? num(op.end) + 1 : null;
    if (op.end === '-1' || op.end === '0') continue; // explicitly silenced region
    r.trigger = op.trigger || 'attack';
    r.seqLength = num(op.seq_length, 1);
    r.seqPosition = num(op.seq_position, 1);
    r.lorand = num(op.lorand, 0);
    r.hirand = num(op.hirand, 1);
    r.group = op.group != null ? num(op.group) : 0;
    r.offBy = op.off_by != null ? num(op.off_by) : null;
    for (const [k, v] of Object.entries(op)) {
      const m = /^(lo|hi)cc(\d+)$/.exec(k);
      if (!m) continue;
      const n = Number(m[2]);
      let c = r.conds.find(x => x.cc === n);
      if (!c) { c = { cc: n, lo: 0, hi: 127 }; r.conds.push(c); }
      c[m[1]] = num(v);
    }
    if (op.sw_lokey != null) r.swRange = [sfzKey(op.sw_lokey), sfzKey(op.sw_hikey ?? op.sw_lokey)];
    if (op.sw_last != null) r.swLast = sfzKey(op.sw_last);
    if (op.sw_down != null) r.swDown = sfzKey(op.sw_down);
    if (op.sw_default != null) swDefault = sfzKey(op.sw_default);
    if (op.cutoff != null) {
      r.filter = {
        type: FIL_TYPES[op.fil_type || op.filtype] || 'lowpass',
        cutoff: num(op.cutoff, 20000),
        resonance: num(op.resonance),
        keytrack: num(op.fil_keytrack),
        keycenter: sfzKey(op.fil_keycenter ?? 60) ?? 60,
        veltrack: num(op.fil_veltrack),
        egDepth: num(op.fileg_depth),
        eg: {
          delay: num(op.fileg_delay), attack: num(op.fileg_attack), hold: num(op.fileg_hold),
          decay: num(op.fileg_decay), sustain: Math.max(0, Math.min(1, num(op.fileg_sustain, 100) / 100)),
          release: num(op.fileg_release),
        },
      };
    }
    r.cc = cc;
    out.push(r);
  }
  // Instruments with keyswitches but no sw_default start on their lowest switch.
  const switches = out.map(r => r.swLast).filter(v => v != null);
  const initialSwitch = swDefault ?? (switches.length ? Math.min(...switches) : null);
  return { regions: out, initialSwitch, cc };
}

// Full pipeline for a .sfz file. readText(path) resolves includes.
export async function parseSfz(text, { path = '', readText } = {}) {
  const dir = path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const pre = await preprocess(text, { baseDir: dir, readText });
  return normalizeSfz(flatten(tokenize(pre)), dir);
}
