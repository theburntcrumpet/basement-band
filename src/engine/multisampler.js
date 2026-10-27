// Plays normalized regions (from SF2 or SFZ) with per-voice envelopes, loops, filters and panning.
// Voices are raw Web Audio nodes created on the instrument's own context, so the same instance
// works live and inside an offline export render.

const Tone = window.Tone;
const MAX_VOICES = 96;
const MIN_RELEASE = 0.006;

// Region buffers are attached by the loader as region.buffer (AudioBuffer) with loop/offset in seconds.
export class MultiSampler {
  constructor({ regions, initialSwitch = null, cc }, volumeDb = 0) {
    this.output = new Tone.Gain(Tone.dbToGain(volumeDb));
    this.ctx = this.output.context.rawContext;
    this.dest = this.output.input;
    this.regions = regions.filter(r => r.buffer);
    this.cc = cc;
    this.voices = [];
    this.held = new Map();          // midi -> velocity (0..1) while held
    this.liveVoices = new Map();    // midi -> voices started by the held key
    this.seq = new Map();           // region -> round-robin counter
    this.lastSwitch = initialSwitch;
    this.offline = this.output.context.isOffline;
    this.swKeys = new Set();
    for (const r of this.regions) if (r.swRange) for (let k = r.swRange[0]; k <= r.swRange[1]; k++) this.swKeys.add(k);
  }

  // ---------------------------------------------------------------- instrument interface

  // Scheduled note (playback/export): independent of what is physically held right now.
  play(midi, dur, time, vel = 0.8) {
    const voices = this.trigger(midi, time, vel, false);
    this.releaseNote(midi, time + dur, vel, voices);
  }

  // Live input (keyboard, musical typing).
  noteOn(midi, time, vel = 0.8) {
    this.held.set(midi, vel);
    this.liveVoices.set(midi, this.trigger(midi, time, vel, true));
  }

  noteOff(midi, time) {
    const vel = this.held.get(midi);
    this.held.delete(midi);
    if (vel != null) this.releaseNote(midi, time, vel, this.liveVoices.get(midi) || []);
    this.liveVoices.delete(midi);
  }

  stopAll(time) {
    for (const v of this.voices) this.stopVoice(v, time, MIN_RELEASE, true);
    this.held.clear();
    this.liveVoices.clear();
  }

  dispose() {
    this.stopAll(this.ctx.currentTime);
    setTimeout(() => this.output.dispose(), 100);
  }

  // ---------------------------------------------------------------- internals

  matches(r, midi, v127) {
    if (midi < r.lokey || midi > r.hikey || v127 < r.lovel || v127 > r.hivel) return false;
    for (const c of r.conds) {
      const value = this.cc[c.cc] ?? 0;
      if (value < c.lo || value > c.hi) return false;
    }
    if (r.swLast != null && r.swLast !== this.lastSwitch) return false;
    if (r.swDown != null && !this.held.has(r.swDown)) return false;
    return true;
  }

  trigger(midi, time, vel, live) {
    if (this.swKeys.has(midi)) {
      this.lastSwitch = midi;
      return [];
    }
    const v127 = Math.max(1, Math.min(127, Math.round(vel * 127)));
    const others = live ? this.held.size - 1 : 0;
    const rand = Math.random();
    const started = [];
    for (const r of this.regions) {
      if (r.trigger === 'release' || !this.matches(r, midi, v127)) continue;
      // Round robin: each region counts the notes it could have played.
      const n = (this.seq.get(r) || 0) + 1;
      this.seq.set(r, n);
      if (r.seqLength > 1 && ((n - 1) % r.seqLength) + 1 !== r.seqPosition) continue;
      if (rand < r.lorand || rand >= r.hirand) continue;
      if (r.trigger === 'first' && others > 0) continue;
      if (r.trigger === 'legato' && others === 0) continue;
      this.choke(r.group, time);
      started.push(this.startVoice(r, midi, v127, time));
    }
    return started;
  }

  releaseNote(midi, time, vel, voices) {
    for (const v of voices) if (!v.oneShot) this.stopVoice(v, time, v.region.env.release);
    // Release-triggered regions (piano damper noise, string release, ...).
    if (this.swKeys.has(midi)) return;
    const v127 = Math.max(1, Math.min(127, Math.round(vel * 127)));
    for (const r of this.regions) {
      if (r.trigger === 'release' && this.matches(r, midi, v127)) this.startVoice(r, midi, v127, time);
    }
  }

  choke(group, time) {
    if (!group) return;
    for (const v of this.voices) if (v.region.offBy === group && v.endTime > time) this.stopVoice(v, time, MIN_RELEASE, true);
  }

  velocityGain(r, v127) {
    if (r.velcurve) {
      const pts = [[0, 0], ...r.velcurve];
      if (!r.velcurve.some(p => p[0] === 127)) pts.push([127, 1]);
      for (let i = 1; i < pts.length; i++) {
        if (v127 <= pts[i][0]) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          return y0 + (y1 - y0) * ((v127 - x0) / Math.max(1, x1 - x0));
        }
      }
      return pts[pts.length - 1][1];
    }
    const x = v127 / 127;
    return 1 - r.veltrack + r.veltrack * x * x;
  }

  startVoice(r, midi, v127, time) {
    const ctx = this.ctx;
    const t0 = Math.max(time, ctx.currentTime);
    // Forget voices that have finished by now (by schedule, since offline renders never wait).
    this.voices = this.voices.filter(v => v.endTime > t0);
    if (this.voices.length >= MAX_VOICES) this.stopVoice(this.voices[0], t0, MIN_RELEASE, true);

    const src = ctx.createBufferSource();
    src.buffer = r.buffer;
    src.playbackRate.value = Math.pow(2, ((midi - r.root) * r.keytrack * 100 + r.tune) / 1200);
    const looping = r.loopMode === 'continuous' || r.loopMode === 'sustain';
    if (looping && r.loopEnd > r.loopStart) {
      src.loop = true;
      src.loopStart = r.loopStart;
      src.loopEnd = r.loopEnd;
    }

    let node = src;
    let filter = null;
    if (r.filter) {
      const f = r.filter;
      filter = ctx.createBiquadFilter();
      filter.type = f.type;
      const cents = f.keytrack * (midi - f.keycenter) + f.veltrack * (v127 / 127);
      filter.frequency.value = Math.max(10, Math.min(ctx.sampleRate / 2 - 100, f.cutoff * Math.pow(2, cents / 1200)));
      filter.Q.value = f.type === 'lowpass' || f.type === 'highpass' ? f.resonance : Math.max(0.1, Math.pow(10, f.resonance / 20));
      if (f.egDepth) envelope(filter.detune, f.eg, t0, f.egDepth, 0);
      node.connect(filter);
      node = filter;
    }

    const amp = ctx.createGain();
    const peak = Math.pow(10, r.gainDb / 20) * this.velocityGain(r, v127);
    envelope(amp.gain, r.env, t0, peak, 0);
    node.connect(amp);

    const pan = ctx.createStereoPanner();
    pan.pan.value = r.pan;
    amp.connect(pan);
    pan.connect(this.dest);

    const offset = Math.min(r.buffer.duration - 0.001, r.offset + (r.offsetRandom ? Math.random() * r.offsetRandom : 0));
    const playable = r.end != null ? Math.max(0.001, r.end - offset) : undefined;
    if (src.loop) src.start(t0, offset);
    else src.start(t0, offset, playable);

    const naturalEnd = src.loop ? Infinity : t0 + (playable ?? (r.buffer.duration - offset)) / src.playbackRate.value;
    const voice = { src, amp, pan, filter, region: r, midi, released: false, endTime: naturalEnd, oneShot: r.loopMode === 'one_shot' };
    this.voices.push(voice);
    if (!this.offline) src.onended = () => pan.disconnect();
    return voice;
  }

  // Fades a voice out from `time`. A later stop (e.g. a choke) can still cut an earlier-scheduled release short.
  stopVoice(v, time, release, force = false) {
    if (!v || (v.released && !force)) return;
    v.released = true;
    const t = Math.max(time, this.ctx.currentTime);
    const rel = Math.max(MIN_RELEASE, release);
    holdAt(v.amp.gain, t);
    v.amp.gain.setTargetAtTime(0, t, rel / 5);
    if (v.filter && v.region.filter.egDepth) {
      holdAt(v.filter.detune, t);
      v.filter.detune.setTargetAtTime(0, t, Math.max(MIN_RELEASE, v.region.filter.eg.release) / 5);
    }
    const end = t + rel + 0.02;
    if (end < v.endTime) {
      v.endTime = end;
      try { v.src.stop(end); } catch { /* already stopped */ }
    }
  }
}

// DAHDS envelope on an AudioParam from `base` to `base + depth`, starting at t0.
function envelope(param, env, t0, depth, base) {
  const { delay = 0, attack = 0, hold = 0, decay = 0, sustain = 1 } = env;
  const tA = t0 + delay;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(base, t0);
  param.setValueAtTime(base, tA);
  if (attack > 0.0005) param.linearRampToValueAtTime(base + depth, tA + attack);
  else param.setValueAtTime(base + depth, tA);
  const tD = tA + attack + hold;
  param.setValueAtTime(base + depth, tD);
  if (sustain < 1) {
    if (decay > 0.0005) param.setTargetAtTime(base + depth * sustain, tD, decay / 4);
    else param.setValueAtTime(base + depth * sustain, tD);
  }
}

// Freezes an AudioParam at its current automation value at time t.
function holdAt(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { param.cancelScheduledValues(t); }
}
