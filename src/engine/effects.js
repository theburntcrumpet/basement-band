// Character effects for tracks and the master bus: Vinyl, Tape, Radio and Lo-Fi.
// Built from raw Web Audio nodes on whichever context is current, so the same code serves live
// playback and offline export. Noise layers (crackle, hiss, static) only sound while playing.

const Tone = window.Tone;

export const EFFECTS = {
  none: { name: 'None', params: [] },
  vinyl: {
    name: 'Vinyl',
    params: [
      { key: 'crackle', label: 'Crackle', def: 0.45 },
      { key: 'pops', label: 'Pops', def: 0.35 },
      { key: 'age', label: 'Age', def: 0.5 },
      { key: 'wow', label: 'Wow', def: 0.3 },
      { key: 'mix', label: 'Mix', def: 1 },
    ],
  },
  tape: {
    name: 'Tape',
    params: [
      { key: 'saturation', label: 'Saturation', def: 0.4 },
      { key: 'warmth', label: 'Warmth', def: 0.4 },
      { key: 'wow', label: 'Wow', def: 0.25 },
      { key: 'hiss', label: 'Hiss', def: 0.15 },
      { key: 'mix', label: 'Mix', def: 1 },
    ],
  },
  radio: {
    name: 'Radio',
    params: [
      { key: 'band', label: 'Narrow', def: 0.5 },
      { key: 'distortion', label: 'Distortion', def: 0.3 },
      { key: 'static', label: 'Static', def: 0.2 },
      { key: 'mix', label: 'Mix', def: 1 },
    ],
  },
  lofi: {
    name: 'Lo-Fi',
    params: [
      { key: 'crush', label: 'Crush', def: 0.5 },
      { key: 'tone', label: 'Tone', def: 0.5 },
      { key: 'noise', label: 'Noise', def: 0.15 },
      { key: 'mix', label: 'Mix', def: 1 },
    ],
  },
};

export function defaultFx(type = 'none') {
  const fx = { type };
  for (const p of EFFECTS[type]?.params || []) fx[p.key] = p.def;
  return fx;
}

// ------------------------------------------------------------------ noise textures

const textures = new Map();

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Looping textures, generated once per sample rate. Odd lengths keep the loop from being obvious.
function texture(kind, rate) {
  const key = `${kind}:${rate}`;
  if (textures.has(key)) return textures.get(key);
  const seconds = { crackle: 9.7, pops: 13.3, hiss: 5.1 }[kind];
  const len = Math.floor(seconds * rate);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: rate });
  const rand = rng(kind === 'crackle' ? 101 : kind === 'pops' ? 202 : 303);
  if (kind === 'pops') {
    // Occasional thumpy clicks, mostly centred.
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let t = 0; t < len;) {
      t += Math.floor((-Math.log(1 - rand()) / 0.7) * rate);
      if (t >= len) break;
      const amp = 0.3 + 0.7 * rand();
      const width = Math.floor(rate * (0.0006 + 0.002 * rand()));
      const pan = (rand() - 0.5) * 0.4;
      for (let i = 0; i < width * 6 && t + i < len; i++) {
        const env = Math.exp(-i / width);
        const v = amp * env * (i < 2 ? 1 : (rand() * 2 - 1) * 0.6);
        L[t + i] += v * (1 - pan);
        R[t + i] += v * (1 + pan);
      }
    }
  } else {
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      if (kind === 'crackle') {
        // Dense tiny ticks over a faint surface noise.
        let lp = 0;
        for (let i = 0; i < len; i++) { lp += 0.05 * ((rand() * 2 - 1) - lp); d[i] = lp * 0.02; }
        for (let t = 0; t < len;) {
          t += Math.floor((-Math.log(1 - rand()) / 80) * rate);
          if (t + 4 >= len) break;
          const amp = Math.pow(rand(), 3.5) * 0.9 * (rand() < 0.5 ? -1 : 1);
          d[t] += amp; d[t + 1] -= amp * 0.6; d[t + 2] += amp * 0.25;
        }
      } else {
        // Hiss: softened white noise.
        let lp = 0;
        for (let i = 0; i < len; i++) { const w = rand() * 2 - 1; lp += 0.4 * (w - lp); d[i] = (w * 0.5 + lp * 0.5) * 0.5; }
      }
    }
  }
  textures.set(key, buf);
  return buf;
}

// ------------------------------------------------------------------ building blocks

function shaperCurve(fn, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

const saturate = k => shaperCurve(x => Math.tanh(k * x) / Math.tanh(k));

function crushCurve(bits) {
  const steps = Math.pow(2, bits - 1);
  return shaperCurve(x => Math.round(x * steps) / steps, 65536);
}

function loopSource(ctx, kind) {
  const src = ctx.createBufferSource();
  src.buffer = texture(kind, ctx.sampleRate);
  src.loop = true;
  src.start(ctx.currentTime);
  return src;
}

// A slowly wobbling delay line: tape/vinyl wow (slow) and flutter (fast).
function wobble(ctx) {
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 0.008;
  const slow = ctx.createOscillator(), fast = ctx.createOscillator();
  slow.frequency.value = 0.55;
  fast.frequency.value = 6.3;
  const slowDepth = ctx.createGain(), fastDepth = ctx.createGain();
  slow.connect(slowDepth).connect(delay.delayTime);
  fast.connect(fastDepth).connect(delay.delayTime);
  slow.start(ctx.currentTime);
  fast.start(ctx.currentTime);
  return {
    node: delay,
    set: (wow, t) => {
      slowDepth.gain.setTargetAtTime(wow * 0.0024, t, 0.05);
      fastDepth.gain.setTargetAtTime(wow * 0.00016, t, 0.05);
    },
    sources: [slow, fast],
  };
}

function biquad(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

// ------------------------------------------------------------------ effect graphs
// Each builder wires `input` -> ... -> `wet` and returns {set(fx, t), noise: [gain], sources: []}.

const BUILDERS = {
  vinyl(ctx, input, wet) {
    // Two low-passes in series give a steep 24 dB/oct roll-off, like a worn groove.
    const hp = biquad(ctx, 'highpass', 60), lp = biquad(ctx, 'lowpass', 9000), lp2 = biquad(ctx, 'lowpass', 9000);
    const sat = ctx.createWaveShaper();
    const wow = wobble(ctx);
    input.connect(hp).connect(lp).connect(lp2).connect(sat).connect(wow.node).connect(wet);
    const crackle = loopSource(ctx, 'crackle'), pops = loopSource(ctx, 'pops');
    const crackleGain = ctx.createGain(), popsGain = ctx.createGain(), noise = ctx.createGain();
    const noiseLp = biquad(ctx, 'lowpass', 9000);
    crackle.connect(crackleGain).connect(noise);
    pops.connect(popsGain).connect(noise);
    noise.connect(noiseLp).connect(wet);
    return {
      set(fx, t) {
        hp.frequency.setTargetAtTime(25 + fx.age * 170, t, 0.03);
        const top = 18000 * Math.pow(0.2, fx.age);
        lp.frequency.setTargetAtTime(top, t, 0.03);
        lp2.frequency.setTargetAtTime(top, t, 0.03);
        noiseLp.frequency.setTargetAtTime(Math.min(12000, top * 1.4), t, 0.03);
        sat.curve = saturate(1 + fx.age * 2.5);
        wow.set(fx.wow, t);
        crackleGain.gain.setTargetAtTime(Math.pow(fx.crackle, 1.5) * 0.5, t, 0.03);
        popsGain.gain.setTargetAtTime(Math.pow(fx.pops, 1.5) * 0.7, t, 0.03);
      },
      noise: [noise],
      sources: [crackle, pops, ...wow.sources],
    };
  },

  tape(ctx, input, wet) {
    const drive = ctx.createGain(), sat = ctx.createWaveShaper(), trim = ctx.createGain();
    const lp = biquad(ctx, 'lowpass', 12000), lowBump = biquad(ctx, 'peaking', 110, 0.8);
    const wow = wobble(ctx);
    input.connect(drive).connect(sat).connect(trim).connect(lowBump).connect(lp).connect(wow.node).connect(wet);
    const hiss = loopSource(ctx, 'hiss');
    const hissGain = ctx.createGain(), noise = ctx.createGain();
    hiss.connect(hissGain).connect(noise).connect(wet);
    return {
      set(fx, t) {
        const k = 1 + fx.saturation * 5;
        drive.gain.setTargetAtTime(1 + fx.saturation * 1.5, t, 0.03);
        sat.curve = saturate(k);
        trim.gain.setTargetAtTime(1 / (1 + fx.saturation * 0.8), t, 0.03);
        lowBump.gain.setTargetAtTime(fx.warmth * 3, t, 0.03);
        lp.frequency.setTargetAtTime(16000 * Math.pow(0.3, fx.warmth), t, 0.03);
        wow.set(fx.wow, t);
        hissGain.gain.setTargetAtTime(fx.hiss * 0.035, t, 0.03);
      },
      noise: [noise],
      sources: [hiss, ...wow.sources],
    };
  },

  radio(ctx, input, wet) {
    const hp = biquad(ctx, 'highpass', 400, 1), lp = biquad(ctx, 'lowpass', 3500, 1);
    const presence = biquad(ctx, 'peaking', 1600, 1.2);
    presence.gain.value = 5;
    const drive = ctx.createGain(), sat = ctx.createWaveShaper(), trim = ctx.createGain();
    input.connect(hp).connect(lp).connect(presence).connect(drive).connect(sat).connect(trim).connect(wet);
    const hiss = loopSource(ctx, 'hiss');
    const band = biquad(ctx, 'bandpass', 2500, 0.8);
    const hissGain = ctx.createGain(), noise = ctx.createGain();
    hiss.connect(band).connect(hissGain).connect(noise).connect(wet);
    return {
      set(fx, t) {
        hp.frequency.setTargetAtTime(250 + fx.band * 650, t, 0.03);
        lp.frequency.setTargetAtTime(6000 - fx.band * 3600, t, 0.03);
        drive.gain.setTargetAtTime(1 + fx.distortion * 5, t, 0.03);
        sat.curve = saturate(1 + fx.distortion * 4);
        trim.gain.setTargetAtTime(1.6 / (1 + fx.distortion * 2), t, 0.03);
        hissGain.gain.setTargetAtTime(fx.static * 0.12, t, 0.03);
      },
      noise: [noise],
      sources: [hiss],
    };
  },

  lofi(ctx, input, wet) {
    const crush = ctx.createWaveShaper();
    const lp = biquad(ctx, 'lowpass', 6000), hp = biquad(ctx, 'highpass', 70);
    input.connect(crush).connect(lp).connect(hp).connect(wet);
    const hiss = loopSource(ctx, 'hiss');
    const hissGain = ctx.createGain(), noise = ctx.createGain();
    hiss.connect(hissGain).connect(noise).connect(wet);
    let bits = null;
    return {
      set(fx, t) {
        const b = Math.round(16 - fx.crush * 12);
        if (b !== bits) { crush.curve = crushCurve(b); bits = b; }
        lp.frequency.setTargetAtTime(14000 * Math.pow(0.15, fx.tone), t, 0.03);
        hissGain.gain.setTargetAtTime(fx.noise * 0.03, t, 0.03);
      },
      noise: [noise],
      sources: [hiss],
    };
  },
};

// A swappable effect insert with a dry/wet mix. config: {type, ...params} or undefined for none.
export class FxSlot {
  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);
    this.ctx = this.input.context.rawContext;
    this.offline = this.input.context.isOffline;
    this.running = this.offline;
    this.type = null;
    this.graph = null;
    this.build('none');
  }

  build(type) {
    this.teardown();
    this.type = type;
    const ctx = this.ctx;
    const inNode = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    Tone.connect(this.input, inNode);
    inNode.connect(dry).connect(this.output.input);
    this.nodes = { inNode, dry, wet };
    if (type === 'none' || !BUILDERS[type]) {
      wet.gain.value = 0;
      this.graph = null;
      return;
    }
    wet.connect(this.output.input);
    this.graph = BUILDERS[type](ctx, inNode, wet);
    for (const g of this.graph.noise) g.gain.value = this.running ? 1 : 0;
  }

  teardown() {
    if (!this.nodes) return;
    this.input.disconnect();
    for (const n of Object.values(this.nodes)) n.disconnect();
    for (const s of this.graph?.sources || []) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.nodes = null;
    this.graph = null;
  }

  setConfig(fx) {
    const type = fx?.type && EFFECTS[fx.type] ? fx.type : 'none';
    if (type !== this.type) this.build(type);
    if (!this.graph) return;
    const full = { ...defaultFx(type), ...fx };
    const t = this.ctx.currentTime;
    this.graph.set(full, t);
    this.nodes.dry.gain.setTargetAtTime(1 - full.mix, t, 0.03);
    this.nodes.wet.gain.setTargetAtTime(full.mix, t, 0.03);
  }

  // Noise layers follow the transport so a stopped song is silent.
  setRunning(on) {
    this.running = on || this.offline;
    for (const g of this.graph?.noise || []) g.gain.setTargetAtTime(this.running ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  dispose() {
    this.teardown();
    this.input.dispose();
    this.output.dispose();
  }
}
