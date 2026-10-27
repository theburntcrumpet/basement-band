// Synthesized transition effects, rendered to audio on demand and sized to the song's tempo.
// Everything here is generated (seeded noise, oscillators, filters), so it ships license-free.

export const GEN_FX = [
  { id: 'riser', name: 'Noise Riser', bars: [1, 2, 4] },
  { id: 'synth-riser', name: 'Synth Riser', bars: [2, 4] },
  { id: 'downlifter', name: 'Downlifter', bars: [1, 2] },
  { id: 'reverse-cymbal', name: 'Reverse Cymbal', bars: [1, 2] },
  { id: 'sweep', name: 'Filter Sweep', bars: [1, 2] },
  { id: 'impact', name: 'Impact', seconds: 3.5 },
  { id: 'sub-drop', name: 'Sub Drop', seconds: 2.5 },
  { id: 'noise-hit', name: 'Noise Burst', seconds: 1.2 },
];

const RATE = 44100;
const cache = new Map();

// Seconds for an effect at a tempo; fixed-length effects ignore the tempo.
export function fxSeconds(fx, bars, bpm, barBeats) {
  return fx.seconds ?? (bars * barBeats * 60) / bpm;
}

export function renderFx(id, { bars = 1, bpm = 120, barBeats = 4 } = {}) {
  const fx = GEN_FX.find(f => f.id === id);
  if (!fx) return Promise.reject(new Error(`Unknown effect ${id}`));
  const seconds = fxSeconds(fx, bars, bpm, barBeats);
  const key = `${id}:${seconds.toFixed(4)}`;
  if (!cache.has(key)) cache.set(key, render(id, seconds));
  return cache.get(key);
}

async function render(id, T) {
  const ctx = new OfflineAudioContext(2, Math.ceil(T * RATE), RATE);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  BUILDERS[id](ctx, out, T);
  const buffer = await ctx.startRendering();
  normalize(buffer, 0.89);
  return buffer;
}

// ------------------------------------------------------------------ building blocks

function noise(ctx, T, seed = 1) {
  const len = Math.ceil(T * RATE);
  const buf = ctx.createBuffer(2, len, RATE);
  let s = seed >>> 0 || 1;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = s / 2147483648 - 1;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.start(0);
  return src;
}

function filter(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

// Gain following shape(t in 0..1) over T seconds, with a short fade at the very end.
function shapedGain(ctx, T, shape, fadeOut = 0.012) {
  const g = ctx.createGain();
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.max(0, shape(i / (n - 1)));
  g.gain.setValueCurveAtTime(curve, 0, Math.max(0.01, T - fadeOut));
  g.gain.setValueAtTime(curve[n - 1], T - fadeOut);
  g.gain.linearRampToValueAtTime(0, T);
  return g;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

function normalize(buffer, peak) {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
  }
  if (!max) return;
  const k = peak / max;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

// ------------------------------------------------------------------ the effects

const BUILDERS = {
  // White noise swelling up through a rising band-pass.
  riser(ctx, out, T) {
    const bp = filter(ctx, 'bandpass', 200, 1.4);
    bp.frequency.setValueAtTime(180, 0);
    bp.frequency.exponentialRampToValueAtTime(9500, T);
    chain(noise(ctx, T, 7), bp, shapedGain(ctx, T, t => 0.02 + Math.pow(t, 2.4)), out);
  },

  // Detuned saws climbing three octaves, opening up, over a quiet noise riser.
  'synth-riser'(ctx, out, T) {
    const lp = filter(ctx, 'lowpass', 400, 4);
    lp.frequency.setValueAtTime(350, 0);
    lp.frequency.exponentialRampToValueAtTime(9000, T);
    const amp = shapedGain(ctx, T, t => 0.05 + Math.pow(t, 2));
    chain(lp, amp, out);
    for (const [detune, pan] of [[-14, -0.6], [0, 0], [13, 0.6]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(110, 0);
      osc.frequency.exponentialRampToValueAtTime(880, T);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      chain(osc, g, p, lp);
      osc.start(0);
      osc.stop(T);
    }
    const bp = filter(ctx, 'highpass', 2000, 0.7);
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    chain(noise(ctx, T, 3), bp, ng, amp);
  },

  // The opposite of a riser: bright noise falling away.
  downlifter(ctx, out, T) {
    const bp = filter(ctx, 'bandpass', 9000, 1.2);
    bp.frequency.setValueAtTime(9000, 0);
    bp.frequency.exponentialRampToValueAtTime(160, T);
    chain(noise(ctx, T, 11), bp, shapedGain(ctx, T, t => Math.pow(1 - t, 2.2), 0.02), out);
  },

  // A crash cymbal played backwards: a hissing swell that stops dead on the beat.
  'reverse-cymbal'(ctx, out, T) {
    const hp = filter(ctx, 'highpass', 3500, 0.5);
    const peak = filter(ctx, 'peaking', 7500, 0.8);
    peak.gain.value = 6;
    chain(noise(ctx, T, 5), hp, peak, shapedGain(ctx, T, t => Math.exp(-(1 - t) * 6), 0.006), out);
  },

  // Resonant low-pass opening across the spectrum.
  sweep(ctx, out, T) {
    const lp = filter(ctx, 'lowpass', 150, 9);
    lp.frequency.setValueAtTime(150, 0);
    lp.frequency.exponentialRampToValueAtTime(12000, T);
    chain(noise(ctx, T, 9), lp, shapedGain(ctx, T, t => 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.05))), out);
  },

  // Sub thump + noise crack + a long dark tail.
  impact(ctx, out, T) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(65, 0);
    osc.frequency.exponentialRampToValueAtTime(30, 1.4);
    const sub = ctx.createGain();
    sub.gain.setValueAtTime(1, 0);
    sub.gain.exponentialRampToValueAtTime(0.001, T);
    chain(osc, sub, out);
    osc.start(0);
    osc.stop(T);
    const crack = filter(ctx, 'lowpass', 3500, 0.7);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.9, 0);
    cg.gain.exponentialRampToValueAtTime(0.001, 0.45);
    chain(noise(ctx, T, 13), crack, cg, out);
    const tail = filter(ctx, 'lowpass', 500, 0.7);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.5, 0);
    tg.gain.exponentialRampToValueAtTime(0.001, T);
    chain(noise(ctx, T, 17), tail, tg, out);
  },

  // A falling sine with a touch of saturation so it still reads on small speakers.
  'sub-drop'(ctx, out, T) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(95, 0);
    osc.frequency.exponentialRampToValueAtTime(28, T * 0.85);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2.2 * ((i / 1023) * 2 - 1));
    shaper.curve = curve;
    chain(osc, shaper, shapedGain(ctx, T, t => (t < 0.02 ? t / 0.02 : 1 - Math.pow(Math.max(0, (t - 0.55) / 0.45), 1.5)), 0.03), out);
    osc.start(0);
    osc.stop(T);
  },

  // A quick white-noise hit with a gated tail.
  'noise-hit'(ctx, out, T) {
    const hp = filter(ctx, 'highpass', 600, 0.7);
    chain(noise(ctx, T, 19), hp, shapedGain(ctx, T, t => (t < 0.01 ? t / 0.01 : Math.exp(-t * 7)), 0.02), out);
  },
};
