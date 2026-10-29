// Guitar/bass amp simulator, inserted at the start of a track's chain so it shapes both live
// monitoring and playback of the clean (DI) recordings — the amp can be changed after recording.
//
// gate + sustain -> tighten -> preamp stage 1 -> (stage 2 for high gain) -> tone stack -> power amp -> cabinet -> level

const Tone = window.Tone;

export const AMP_MODELS = {
  off: { name: 'Off' },
  clean: { name: 'Clean', stages: 1, gainRange: [1, 6], tighten: 70, mid: 650, bright: 3, power: 1.2, cab: 'open212', level: 1.6 },
  vintage: { name: 'Vintage', stages: 1, gainRange: [1.5, 20], tighten: 70, mid: 600, bright: 4, power: 1.4, cab: 'open212', level: 1.3 },
  crunch: { name: 'Crunch', stages: 1, gainRange: [3, 60], tighten: 90, mid: 800, bright: 2, power: 1.8, cab: 'combo112', level: 0.9 },
  lead: { name: 'Lead', stages: 2, gainRange: [6, 120], tighten: 130, mid: 700, bright: 1, power: 2.4, cab: 'closed412', level: 0.75 },
  metal: { name: 'Metal', stages: 2, gainRange: [12, 300], tighten: 170, mid: 750, bright: 2, power: 2.8, cab: 'closed412', level: 0.6 },
  bass: { name: 'Bass', stages: 1, gainRange: [1, 18], tighten: 30, mid: 500, bright: 0, power: 1.4, cab: 'bass115', level: 1.2 },
};

// Speaker cabinets, voiced with filters: low/high roll-off and a few resonances [Hz, Q, dB].
// 'ir' plays a loaded impulse response instead; 'off' skips the cabinet (e.g. into a real amp).
export const CABS = {
  combo112: { name: '1×12 Combo', low: 80, high: 5600, res: [[120, 1, 3], [2300, 1.4, 4], [650, 1, -2]] },
  open212: { name: '2×12 Open Back', low: 70, high: 6500, res: [[110, 1, 2], [1800, 1.2, 3], [3500, 1.5, 2]] },
  closed412: { name: '4×12 Closed Back', low: 90, high: 4800, res: [[100, 1.2, 4], [2400, 1.4, 5], [600, 1, -3]] },
  bass115: { name: '1×15 Bass', low: 40, high: 3500, res: [[80, 1, 3], [800, 1, -2], [2000, 1, 1]] },
};

function cabKeyFor(amp) {
  const choice = cabChoice(amp);
  if (choice === 'ir') return irBuffers.has(amp.ir.path) ? `ir:${amp.ir.path}` : (AMP_MODELS[amp.model] || AMP_MODELS.crunch).cab;
  return choice;
}

// Decoded impulse responses by file path (filled by the engine; shared by live and export graphs).
export const irBuffers = new Map();

// Which cabinet an amp setting means (older songs stored cab: true/false).
export function cabChoice(amp) {
  const m = AMP_MODELS[amp?.model] || AMP_MODELS.crunch;
  if (amp?.cab === false || amp?.cab === 'off') return 'off';
  if (amp?.cab === 'ir' && amp.ir?.path) return 'ir';
  return CABS[amp?.cab] ? amp.cab : m.cab;
}

export const AMP_KNOBS = [
  { key: 'gain', label: 'Gain', def: 0.5 },
  { key: 'sustain', label: 'Sustain', def: 0.35 },
  { key: 'bass', label: 'Bass', def: 0.5 },
  { key: 'mid', label: 'Mid', def: 0.5 },
  { key: 'treble', label: 'Treble', def: 0.5 },
  { key: 'presence', label: 'Presence', def: 0.5 },
  { key: 'gate', label: 'Gate', def: 0.3 },
  { key: 'level', label: 'Level', def: 0.5 },
];

export function defaultAmp(model = 'crunch') {
  const amp = { model, cab: AMP_MODELS[model]?.cab || 'combo112' };
  for (const k of AMP_KNOBS) amp[k.key] = k.def;
  // Sustain (see amp-worklet.js) keeps high-gain notes ringing instead of dropping away.
  amp.sustain = { clean: 0, vintage: 0, crunch: 0.35, lead: 0.65, metal: 0.8, bass: 0.25 }[model] ?? 0.35;
  if (model === 'clean') amp.gain = 0.35;
  if (model === 'lead') amp.gate = 0.45;
  if (model === 'metal') { amp.gate = 0.55; amp.mid = 0.32; amp.gain = 0.6; }
  if (model === 'vintage') { amp.gain = 0.4; amp.mid = 0.42; }
  return amp;
}

// Asymmetric soft clipping, like a triode stage (even harmonics); oversampled to tame aliasing.
function tubeCurve(drive, bias = 0.12) {
  const n = 8192, c = new Float32Array(n);
  const norm = Math.tanh(drive * (1 + bias)) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.tanh(drive * (x + bias)) - Math.tanh(drive * bias);
    c[i] = y / norm;
  }
  return c;
}

const biquad = (ctx, type, freq, q = 0.707, gain = 0) => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
};

export class AmpSlot {
  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);
    this.toneCtx = this.input.context;
    this.ctx = this.toneCtx.rawContext;
    this.model = null;
    this.nodes = null;
    this.build('off');
  }

  build(model, amp = {}) {
    this.teardown();
    this.model = model;
    this.cabKey = null;
    const ctx = this.ctx;
    const inNode = ctx.createGain();
    Tone.connect(this.input, inNode);
    if (model === 'off' || !AMP_MODELS[model]) {
      inNode.connect(this.output.input);
      this.nodes = { inNode };
      return;
    }
    const m = AMP_MODELS[model];
    // The gate needs its worklet module; without it (e.g. a context that never loaded it) skip the gate.
    let gate = null;
    try { gate = this.toneCtx.createAudioWorkletNode('bb-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); } catch { gate = null; }
    const tighten = biquad(ctx, 'highpass', m.tighten, 0.7);
    const pre1 = ctx.createGain(), shape1 = ctx.createWaveShaper();
    shape1.oversample = '4x';
    const couple = biquad(ctx, 'lowpass', 7000, 0.6);
    const pre2 = ctx.createGain(), shape2 = ctx.createWaveShaper();
    shape2.oversample = '4x';
    const bass = biquad(ctx, 'lowshelf', 110), mid = biquad(ctx, 'peaking', m.mid, 0.8), treble = biquad(ctx, 'highshelf', 2600);
    const presence = biquad(ctx, 'peaking', 4200, 1.2);
    const power = ctx.createWaveShaper();
    power.curve = tubeCurve(m.power, 0.02);
    power.oversample = '2x';
    // Cabinet: a loaded IR if there is one (and it's decoded), otherwise filter voicing; or none.
    let choice = cabChoice(amp);
    const ir = choice === 'ir' ? irBuffers.get(amp.ir.path) : null;
    if (choice === 'ir' && !ir) choice = m.cab;
    let cab = [];
    if (ir) {
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      cab = [conv];
    } else if (choice !== 'off') {
      const c = CABS[choice];
      cab = [biquad(ctx, 'highpass', c.low, 0.8), ...c.res.map(([f, q, g]) => biquad(ctx, 'peaking', f, q, g)),
        biquad(ctx, 'lowpass', c.high, 0.8), biquad(ctx, 'lowpass', c.high, 0.6)];
    }
    this.cabKey = ir ? `ir:${amp.ir.path}` : choice;
    const cabBypass = ctx.createGain();
    const cabOut = ctx.createGain();
    const level = ctx.createGain();

    let node = inNode;
    const to = n => { node.connect(n); node = n; };
    if (gate) to(gate);
    to(tighten); to(pre1); to(shape1); to(couple);
    if (m.stages > 1) { to(pre2); to(shape2); }
    to(bass); to(mid); to(treble); to(presence); to(power);
    // Cabinet (or straight through when the cab is switched off, e.g. into a real amp's return).
    let c = node;
    for (const f of cab) { c.connect(f); c = f; }
    c.connect(cabOut);
    node.connect(cabBypass);
    cabOut.connect(level);
    cabBypass.connect(level);
    level.connect(this.output.input);
    this.nodes = { inNode, gate, tighten, pre1, shape1, couple, pre2, shape2, bass, mid, treble, presence, power, cab, cabOut, cabBypass, level, m };
  }

  teardown() {
    if (!this.nodes) return;
    this.input.disconnect();
    for (const n of Object.values(this.nodes)) {
      if (Array.isArray(n)) n.forEach(x => x.disconnect());
      else if (n && typeof n.disconnect === 'function') n.disconnect();
    }
    this.nodes = null;
  }

  setConfig(amp) {
    const model = amp?.model && AMP_MODELS[amp.model] ? amp.model : 'off';
    // Rebuild when the model or the cabinet changes (including an IR finishing loading).
    if (model !== this.model || (model !== 'off' && cabKeyFor(amp) !== this.cabKey)) this.build(model, amp);
    if (model === 'off') return;
    const a = { ...defaultAmp(model), ...amp };
    const n = this.nodes, m = n.m, t = this.ctx.currentTime;
    const [g0, g1] = m.gainRange;
    const drive = g0 * Math.pow(g1 / g0, a.gain);
    n.shape1.curve = tubeCurve(m.stages > 1 ? Math.sqrt(drive) * 2 : drive, 0.15);
    n.pre1.gain.setTargetAtTime(m.stages > 1 ? 2 : 1, t, 0.02);
    if (m.stages > 1) {
      n.pre2.gain.setTargetAtTime(1, t, 0.02);
      n.shape2.curve = tubeCurve(Math.sqrt(drive) * 2.5, 0.08);
    }
    const db = v => (v - 0.5) * 24; // knob 0..1 -> -12..+12 dB
    n.bass.gain.setTargetAtTime(db(a.bass), t, 0.02);
    n.mid.gain.setTargetAtTime(db(a.mid), t, 0.02);
    n.treble.gain.setTargetAtTime(db(a.treble) + m.bright, t, 0.02);
    n.presence.gain.setTargetAtTime(db(a.presence) * 0.6, t, 0.02);
    // Gate knob: off at zero, then -90 dB (barely there) up to -30 dB (only loud playing gets through).
    if (n.gate) {
      n.gate.parameters.get('threshold').setValueAtTime(a.gate < 0.02 ? -100 : -90 + a.gate * 60, t);
      n.gate.parameters.get('sustain').setValueAtTime(a.sustain, t);
    }
    const hasCab = n.cab.length > 0;
    n.cabOut.gain.setTargetAtTime(hasCab ? 1 : 0, t, 0.02);
    n.cabBypass.gain.setTargetAtTime(hasCab ? 0 : 0.6, t, 0.02);
    // Level: 0.5 is unity-ish after each model's own compensation.
    n.level.gain.setTargetAtTime(m.level * Math.pow(10, ((a.level - 0.5) * 24) / 20), t, 0.02);
  }

  dispose() {
    this.teardown();
    this.input.dispose();
    this.output.dispose();
  }
}
