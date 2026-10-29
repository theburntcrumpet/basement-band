// Audio engine: mixer graph, transport scheduling, live input, recording and offline export.

import { createInstrument, loadInstrumentBuffers, fallbackFor, getInstrument } from './instruments.js';
import { meter } from '../music/meter.js';
import { bpmAt, secAt, beatAt, secBetween, changesFrom, tempoPoints } from '../music/tempo.js';
import { EQ_BANDS } from './eq.js';
import { FxSlot } from './effects.js';
import { AmpSlot, irBuffers } from './amp.js';
import { AUTO_PARAMS, curve, valueAt, staticValue, rampsFrom } from './automation.js';

const Tone = window.Tone;
const PPQ = 192;
// The master limiter's lookahead (see master-worklet.js): everything you hear is this much later.
const MASTER_DELAY = 0.001;
export const ticks = beats => `${Math.round(beats * PPQ)}i`;

// Tone's addAudioWorkletModule() keeps a single promise per context, so only the first module ever
// loads. Load each of ours directly, once per context (live and every offline render).
const WORKLETS = ['recorder', 'amp', 'master'];
const loadedWorklets = new WeakMap();
export async function loadWorklets(context = Tone.getContext()) {
  const raw = context.rawContext;
  if (!loadedWorklets.has(raw)) loadedWorklets.set(raw, Promise.all(WORKLETS.map(m => raw.audioWorklet.addModule(`engine/${m}-worklet.js`))));
  return loadedWorklets.get(raw);
}

// Shared send effects + master bus, built in the current Tone context.
function buildBuses(bpm) {
  const master = new Tone.Volume(0);
  const masterFx = new FxSlot();
  // Glue compressor + limiter in one low-latency worklet (needs engine/master-worklet.js loaded).
  const limiter = Tone.getContext().createAudioWorkletNode('bb-master', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  master.connect(masterFx.input);
  Tone.connect(masterFx.output, limiter);
  Tone.connect(limiter, Tone.getDestination());

  const reverb = new Tone.Convolver(makeImpulse(2.6));
  const reverbIn = new Tone.Gain(1);
  const reverbEq = new Tone.Filter(220, 'highpass');
  reverbIn.chain(reverbEq, reverb, master);

  const delay = new Tone.FeedbackDelay({ delayTime: (60 / bpm) * 0.75, feedback: 0.32, wet: 1 });
  const delayIn = new Tone.Gain(1);
  const delayTone = new Tone.Filter(3200, 'lowpass');
  delayIn.chain(delay, delayTone, master);

  return { master, masterFx, limiter, reverb, reverbIn, reverbEq, delay, delayIn, delayTone };
}

// Smooth stereo room: exponentially decaying noise, darker as it fades.
function makeImpulse(seconds) {
  const ctx = Tone.getContext();
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const noise = Math.random() * 2 - 1;
      const k = 0.15 + 0.8 * (1 - t);
      lp += k * (noise - lp);
      const pre = i < rate * 0.012 ? 0 : 1;
      data[i] = lp * Math.pow(1 - t, 2.8) * pre;
    }
  }
  return new Tone.ToneAudioBuffer(buffer);
}

// One mixer channel: instrument/input -> amp -> EQ -> tone filter -> drive -> effect -> volume/pan -> master (+ sends).
export class TrackNode {
  constructor(buses, { meter = false } = {}) {
    this.input = new Tone.Gain(1);
    this.eq = EQ_BANDS.map(b => new Tone.Filter({ type: b.type, frequency: b.freq, Q: b.q ?? 1, gain: 0, rolloff: -12 }));
    this.filter = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -12 });
    this.drive = new Tone.Distortion({ distortion: 0.4, wet: 0 });
    this.channel = new Tone.Channel({ volume: 0, pan: 0 });
    this.reverbSend = new Tone.Gain(0);
    this.delaySend = new Tone.Gain(0);
    this.fx = new FxSlot();
    this.amp = new AmpSlot();
    this.input.connect(this.amp.input);
    this.amp.output.chain(...this.eq, this.filter, this.drive, this.fx.input);
    this.fx.output.chain(this.channel, buses.master);
    this.channel.connect(this.reverbSend);
    this.channel.connect(this.delaySend);
    this.reverbSend.connect(buses.reverbIn);
    this.delaySend.connect(buses.delayIn);
    if (meter) {
      this.meter = new Tone.Meter({ smoothing: 0.85 });
      this.channel.connect(this.meter);
    }
    this.instrument = null;
    this.instrumentId = null;
  }

  // The audio param behind each automatable setting, and how a setting value maps onto it.
  autoTarget(key) {
    switch (key) {
      case 'volume': return { param: this.channel.volume, map: v => v };
      case 'pan': return { param: this.channel.pan, map: v => v };
      case 'reverb': return { param: this.reverbSend.gain, map: v => Math.pow(Math.max(0, v), 1.5) };
      case 'echo': return { param: this.delaySend.gain, map: v => Math.max(0, v) * 0.7 };
      case 'tone': return { param: this.filter.frequency, map: v => 400 * Math.pow(50, v) };
      default: {
        const i = EQ_BANDS.findIndex(b => b.key === key);
        return i >= 0 ? { param: this.eq[i].gain, map: v => v } : null;
      }
    }
  }

  // Mixer settings. `beat` is where the song is parked: automated settings take their curve's value
  // there. While playing (beat null) automated settings are left to the scheduled ramps.
  apply(track, muted, beat = 0) {
    const now = Tone.now();
    this.channel.mute = muted;
    for (const p of AUTO_PARAMS) {
      const points = curve(track, p.key);
      if (points.length && beat == null) continue;
      const { param, map } = this.autoTarget(p.key);
      param.rampTo(map(points.length ? valueAt(points, beat) : staticValue(track, p.key)), 0.05, now);
    }
    this.fx.setConfig(track.fx);
    this.amp.setConfig(track.amp);
    const d = track.drive || 0;
    this.drive.distortion = 0.1 + 0.75 * d;
    this.drive.wet.value = Math.min(1, d * 2);
  }

  setInstrument(id, buffers) {
    const old = this.instrument;
    this.instrument = createInstrument(id, buffers);
    this.instrument.output.connect(this.input);
    this.instrumentId = id;
    if (old) {
      old.stopAll(Tone.now());
      setTimeout(() => old.dispose(), 3000);
    }
  }

  dispose() {
    this.instrument?.dispose();
    this.fx.dispose();
    this.amp.dispose();
    [this.input, ...this.eq, this.filter, this.drive, this.channel, this.reverbSend, this.delaySend, this.meter].forEach(n => n?.dispose());
  }
}

// Loads the buffers for an instrument, falling back to a synth when samples are missing.
export async function resolveInstrument(id) {
  try {
    return { id, buffers: await loadInstrumentBuffers(id) };
  } catch (err) {
    console.warn(`Samples for ${id} unavailable, using a synth instead`, err);
    const fb = fallbackFor(id);
    return { id: fb, buffers: await loadInstrumentBuffers(fb), fallback: true };
  }
}

export const anySolo = project => project.tracks.some(t => t.solo);
export const isMuted = (project, track) => track.mute || (anySolo(project) && !track.solo);

export function regionEnd(region) {
  return region.start + region.length;
}

export function songEnd(project) {
  let end = 0;
  for (const t of project.tracks) for (const r of t.regions) end = Math.max(end, regionEnd(r));
  return end;
}

// Every note of a region expanded across its loop repeats, in absolute beats.
export function expandRegion(region) {
  const out = [];
  const loopLen = region.loopLength || region.length;
  for (let off = 0; off < region.length - 1e-6; off += loopLen) {
    for (const n of region.notes || []) {
      const t = off + n.t;
      if (n.t >= loopLen - 1e-6 || t >= region.length - 1e-6) continue;
      out.push({ ...n, t: region.start + t, d: Math.min(n.d, region.length - t) });
    }
  }
  return out;
}

// Tempo-following audio: a clip remembers the tempo it was recorded/imported at (region.bpm) and is
// time-stretched to the song's tempo unless Follow tempo is off. Offsets stay in the recording's own
// seconds; one beat of the clip lasts sourceSpb seconds of the original recording.
// With tempo changes, a clip follows the tempo where it starts (split a clip at a tempo change if
// it needs to follow both).
export function stretchFactor(region, project) {
  return region.followTempo !== false && region.bpm ? region.bpm / bpmAt(project, region.start) : 1;
}

export function sourceSpb(region, project) {
  return 60 / (region.followTempo !== false && region.bpm ? region.bpm : bpmAt(project, region.start));
}

// Where an audio region's content plays: one segment per loop pass. Each pass starts `phase` beats
// into the content (non-zero after splitting a looped clip) and anything past the end of the
// recording is silence, so clips can be stretched to fill whole bars.
export function audioSegments(region) {
  const loop = region.loopLength || region.length;
  const phase = region.phase || 0;
  const out = [];
  for (let k = 0; ; k++) {
    const segStart = k * loop - phase;
    if (segStart >= region.length - 1e-6) break;
    const from = Math.max(0, segStart);
    const into = from - segStart;
    out.push({ at: region.start + from, into, length: Math.min(loop - into, region.length - from) });
  }
  return out;
}

// Tone's transport can invoke an event twice when it lands exactly on a render-block boundary
// (common in offline export, where whole seconds line up with 128-sample blocks), which doubled
// notes and clips. Each callback runs once per moment; a later cycle repeat still fires.
function once(fn) {
  let last = -Infinity;
  return t => {
    if (Math.abs(t - last) < 1e-4) return;
    last = t;
    fn(t);
  };
}

// Automation: each curve point starts a linear ramp to the next, timed from the transport.
// Playback starting mid-curve begins with the interpolated value; cycle repeats re-seed at the start.
function scheduleAutomation(transport, track, node, sec, { from, cycle, isRepeat, inCycleBefore }) {
  for (const p of AUTO_PARAMS) {
    const points = curve(track, p.key);
    if (!points.length) continue;
    const { param, map } = node.autoTarget(p.key);
    const play = r => time => {
      param.cancelScheduledValues(time);
      param.setValueAtTime(map(r.v), time);
      if (r.to != null) param.linearRampToValueAtTime(map(r.toV), time + sec(r.at, r.to));
    };
    for (const r of rampsFrom(points, from)) transport.schedule(once(play(r)), ticks(r.at));
    if (cycle) {
      // Repeats re-seed at the cycle start, plus any ramps in the loop before `from`.
      for (const r of rampsFrom(points, cycle.start)) {
        if (r.at >= from - 1e-9) break;
        if (r.at === cycle.start || inCycleBefore(r.at)) transport.schedule(once(t => { if (isRepeat()) play(r)(t); }), ticks(r.at));
      }
    }
  }
}

// Schedules a whole project onto a transport.
//   from:       the beat playback (or a mid-play re-plan) takes over at
//   restartAt:  where audio already under way at `from` picks up again (defaults to `from`; a little
//               later when re-planning mid-play, past what the scheduler has already handed off)
//   cycle:      the cycle range, if on. Everything in the loop before `from` is also scheduled, for
//               repeats only, so notes there aren't lost on the next pass.
//   isRepeat:   () => true once the transport has wrapped round the cycle since this schedule
//   active:     a Set collecting live audio sources, so they can be stopped
//   bufferFor:  region => {buffer, factor}: the audio to play (stretched to tempo) and its stretch factor
export function scheduleProject(transport, project, nodes, audioPool, { from = 0, restartAt = from, cycle = null, isRepeat = () => false, active = null, bufferFor = null } = {}) {
  const sec = (a, b) => secBetween(project, a, b);
  const inCycleBefore = t => !!cycle && t >= cycle.start - 1e-9 && t < Math.min(from, cycle.end) - 1e-9;
  const onRepeat = fn => once(t => { if (isRepeat()) fn(t); });
  // Tempo changes switch the transport's tempo as they pass (and replay on cycle repeats).
  const setTempo = bpm => t => transport.bpm.setValueAtTime(bpm, t);
  for (const c of changesFrom(project, from)) transport.schedule(once(setTempo(c.bpm)), ticks(c.beat));
  if (cycle) {
    transport.schedule(onRepeat(setTempo(bpmAt(project, cycle.start))), ticks(cycle.start));
    for (const c of tempoPoints(project)) if (c.beat > 1e-9 && inCycleBefore(c.beat)) transport.schedule(onRepeat(setTempo(c.bpm)), ticks(c.beat));
  }
  for (const track of project.tracks) {
    const node = nodes.get(track.id);
    if (!node) continue;
    scheduleAutomation(transport, track, node, sec, { from, cycle, isRepeat, inCycleBefore });
    for (const region of track.regions) {
      if (track.type === 'audio') {
        const { buffer, factor } = bufferFor ? bufferFor(region) : { buffer: audioPool.get(region.audioId), factor: 1 };
        if (!buffer) continue;
        // The (stretched) clip plays at the tempo where it starts.
        const spb = 60 / bpmAt(project, region.start);
        // One-shot sources at exact transport times (Tone's synced Player could start a clip twice).
        const ctx = node.input.context;
        for (const seg of audioSegments(region)) {
          // Offsets are in the original recording's seconds; the buffer is already stretched to tempo.
          const offset = (region.offset || 0) * factor + seg.into * spb;
          const dur = Math.min(seg.length * spb, buffer.duration - offset);
          if (dur <= 0.001) continue;
          const play = (time, skip) => {
            if (skip >= dur - 0.001) return;
            const src = new Tone.ToneBufferSource({ context: ctx, url: buffer, fadeIn: skip > 0 ? 0.005 : 0.003, fadeOut: 0.01 }).connect(node.input);
            src.startedAt = time;
            src.start(time, offset + skip, dur - skip, Tone.dbToGain(region.gain ?? 0));
            if (active) {
              active.add(src);
              src.onended = () => { active.delete(src); src.dispose(); };
            }
          };
          const end = seg.at + seg.length;
          if (seg.at >= from - 1e-9) transport.schedule(once(t => play(t, 0)), ticks(seg.at));
          else if (end > restartAt) transport.schedule(once(t => play(t, (restartAt - seg.at) * spb)), ticks(restartAt));
          if (inCycleBefore(seg.at)) transport.schedule(onRepeat(t => play(t, 0)), ticks(seg.at));
          if (cycle && seg.at < cycle.start - 1e-9 && end > cycle.start) {
            transport.schedule(onRepeat(t => play(t, (cycle.start - seg.at) * spb)), ticks(cycle.start));
          }
        }
        continue;
      }
      for (const n of expandRegion(region)) {
        const note = time => node.instrument?.play(n.n, sec(n.t, n.t + n.d), time, n.v);
        if (n.t >= from - 1e-6) transport.schedule(once(note), ticks(n.t));
        else if (inCycleBefore(n.t)) transport.schedule(onRepeat(note), ticks(n.t));
      }
    }
  }
}

// ------------------------------------------------------------------ live engine

export class Engine extends EventTarget {
  constructor() {
    super();
    this.nodes = new Map();
    this.stretched = new Map();   // "audioId@factor" -> Promise<AudioBuffer>
    this.stretchedReady = new Map();
    this.audioPool = new Map();
    this.pending = new Map();
    this.audioSources = new Set();
    this.loopCount = 0;
    this.project = null;
    this.recording = null;
    this.metronome = false;
  }

  // mode: 'low' | 'balanced' | 'stable'. Stable gives the audio thread bigger buffers and the scheduler
  // more headroom, which avoids dropouts on slower machines at the cost of latency.
  async init(mode = 'balanced') {
    this.mode = mode;
    const opts = { low: ['interactive', 0.05], balanced: ['interactive', 0.06], stable: ['playback', 0.15] }[mode] || ['interactive', 0.06];
    Tone.setContext(new Tone.Context({ latencyHint: opts[0], lookAhead: opts[1] }));
    this.transport = Tone.getTransport();
    this.transport.PPQ = PPQ;
    // When the cycle wraps, cut off audio from the previous pass (anything started before the wrap).
    this.transport.on('loop', time => { this.loopCount++; this.stopAudio(time, time); });
    await loadWorklets();
    this.buses = buildBuses(120);
    this.masterMeter = new Tone.Meter({ smoothing: 0.85, channelCount: 1 });
    Tone.connect(this.buses.limiter, this.masterMeter);
    this.click = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 }, volume: -10 }).toDestination();
  }

  async resume() {
    if (Tone.getContext().state !== 'running') await Tone.start();
  }

  // Brings the graph in line with the project (tracks, instruments, mixer settings).
  sync(project) {
    this.project = project;
    if (!this.playing) this.transport.bpm.value = bpmAt(project, this.cursor || 0);
    this.transport.timeSignature = [project.timeSig.num, project.timeSig.den];
    this.buses.delay.delayTime.rampTo((60 / project.bpm) * 0.75, 0.05);
    this.buses.master.volume.rampTo(project.masterVolume ?? 0, 0.05);
    this.buses.masterFx.setConfig(project.masterFx);
    const ids = new Set(project.tracks.map(t => t.id));
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) { node.dispose(); this.nodes.delete(id); }
    }
    for (const track of project.tracks) {
      if (track.amp?.cab === 'ir' && track.amp.ir?.path && !irBuffers.has(track.amp.ir.path) && window.host) this.loadIR(track.amp.ir.path);
      let node = this.nodes.get(track.id);
      if (!node) {
        node = new TrackNode(this.buses, { meter: true });
        this.nodes.set(track.id, node);
      }
      node.apply(track, isMuted(project, track), this.playing ? null : this.cursor || 0);
      if (track.type !== 'audio' && node.instrumentId !== track.instrument && this.pending.get(track.id) !== track.instrument) {
        this.loadTrackInstrument(track.id, track.instrument);
      }
    }
    this.transport.loop = !!project.cycle?.on;
    if (project.cycle) {
      this.transport.loopStart = ticks(project.cycle.start);
      this.transport.loopEnd = ticks(project.cycle.end);
    }
  }

  async loadTrackInstrument(trackId, id) {
    this.pending.set(trackId, id);
    this.dispatchEvent(new CustomEvent('loading', { detail: { trackId, loading: true } }));
    try {
      const res = await resolveInstrument(id);
      const node = this.nodes.get(trackId);
      if (node && this.pending.get(trackId) === id) {
        node.setInstrument(res.id, res.buffers);
        node.instrumentId = id;
        if (res.fallback) {
          const def = getInstrument(id);
          const detail = def.type === 'user'
            ? `Couldn't load "${def.name}" from ${def.source.path.split(/[\\/]/).pop()} — playing a stand-in synth. Re-import it in Sounds → My Instruments.`
            : `${def.name} samples are missing; using a synth. Run "npm run fetch-samples".`;
          this.dispatchEvent(new CustomEvent('warning', { detail }));
        }
        if (res.buffers?.failed) this.dispatchEvent(new CustomEvent('warning', { detail: `${res.buffers.failed} samples of "${getInstrument(id).name}" could not be loaded.` }));
      }
    } finally {
      if (this.pending.get(trackId) === id) this.pending.delete(trackId);
      this.dispatchEvent(new CustomEvent('loading', { detail: { trackId, loading: false } }));
    }
  }

  whenLoaded() {
    return new Promise(resolve => {
      const check = () => (this.pending.size ? setTimeout(check, 50) : resolve());
      check();
    });
  }

  get playing() {
    return this.transport.state === 'started';
  }

  // Current audible position in beats.
  position() {
    const t = this.transport.getTicksAtTime(Tone.immediate());
    return t / PPQ;
  }

  setPosition(beats) {
    this.transport.ticks = Math.max(0, Math.round(beats * PPQ));
  }

  // Schedules everything from `from` (the playback start, or the current position for edits while playing).
  // ---------------------------------------------------------------- cabinet impulse responses

  loadIR(path) {
    this.irLoads ||= new Map();
    if (!this.irLoads.has(path)) {
      const job = window.host.readFile(path)
        .then(bytes => Tone.getContext().rawContext.decodeAudioData(bytes))
        .then(buf => { irBuffers.set(path, buf); if (this.project) this.sync(this.project); return buf; });
      job.catch(err => {
        this.irLoads.delete(path);
        this.dispatchEvent(new CustomEvent('warning', { detail: `Couldn't load the cabinet IR ${path.split(/[\\/]/).pop()}; using a built-in cabinet. (${err.message})` }));
      });
      this.irLoads.set(path, job);
    }
    return this.irLoads.get(path);
  }

  // Loads every IR the song's amps use (export waits on this).
  prepareIRs(project = this.project) {
    const paths = project.tracks.map(t => t.amp).filter(a => a?.cab === 'ir' && a.ir?.path).map(a => a.ir.path);
    return Promise.allSettled([...new Set(paths)].map(p => this.loadIR(p)));
  }

  // ---------------------------------------------------------------- tempo-following audio

  stretchKey(region, factor) {
    return `${region.audioId}@${factor.toFixed(5)}`;
  }

  // The audio a region should play at the current tempo (falls back to the original if a stretch
  // isn't ready yet — callers await prepareAudio() first).
  bufferFor = region => {
    const buffer = this.audioPool.get(region.audioId);
    const factor = stretchFactor(region, this.project);
    if (!buffer || Math.abs(factor - 1) < 1e-4) return { buffer, factor: 1 };
    const ready = this.stretchedReady.get(this.stretchKey(region, factor));
    return ready ? { buffer: ready, factor } : { buffer, factor: 1 };
  };

  // Stretches every tempo-following clip to the song's tempo (in a worker), once per tempo.
  prepareAudio(project = this.project) {
    const jobs = [];
    for (const t of project.tracks) {
      if (t.type !== 'audio') continue;
      for (const r of t.regions) {
        const buffer = this.audioPool.get(r.audioId);
        const factor = stretchFactor(r, project);
        if (!buffer || Math.abs(factor - 1) < 1e-4) continue;
        const key = this.stretchKey(r, factor);
        if (!this.stretched.has(key)) {
          const job = this.stretchInWorker(buffer, factor).then(b => { this.stretchedReady.set(key, b); return b; });
          job.catch(() => this.stretched.delete(key));
          this.stretched.set(key, job);
        }
        jobs.push(this.stretched.get(key));
      }
    }
    return Promise.all(jobs);
  }

  stretchInWorker(buffer, factor) {
    this.worker ||= new Worker(new URL('./stretch-worker.js', import.meta.url), { type: 'module' });
    this.jobs ||= new Map();
    if (!this.worker.onmessage) {
      this.worker.onmessage = e => {
        const job = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        const out = new AudioBuffer({ length: e.data.channels[0].length, sampleRate: job.rate, numberOfChannels: e.data.channels.length });
        e.data.channels.forEach((c, i) => out.copyToChannel(c, i));
        job.resolve(out);
      };
    }
    const id = (this.jobSeq = (this.jobSeq || 0) + 1);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
    return new Promise(resolve => {
      this.jobs.set(id, { resolve, rate: buffer.sampleRate });
      this.worker.postMessage({ id, channels, factor, rate: buffer.sampleRate }, channels.map(c => c.buffer));
    });
  }

  // Plans playback from `startBeat`, or — when called mid-play after an edit — takes over seamlessly:
  // notes and automation from the scheduler's horizon (everything before it is already handed to the
  // audio clock), and playing audio clips from a moment after it, where the old ones stop.
  reschedule(startBeat) {
    const live = startBeat == null && this.playing;
    let from = startBeat ?? 0, restartAt = from, stopAt = Tone.now();
    if (live) {
      from = this.transport.getTicksAtTime(Tone.now()) / PPQ;
      stopAt = Tone.now() + 0.04;
      restartAt = this.transport.getTicksAtTime(stopAt) / PPQ;
    }
    this.transport.cancel(0);
    this.stopAudio(stopAt);
    const cycle = this.project.cycle?.on ? this.project.cycle : null;
    const pass = this.loopCount;
    scheduleProject(this.transport, this.project, this.nodes, this.audioPool, { from, restartAt, cycle, isRepeat: () => this.loopCount > pass, active: this.audioSources, bufferFor: this.bufferFor });
    const m = meter(this.project.timeSig);
    this.transport.scheduleRepeat(time => {
      if (!this.metronome) return;
      const beats = this.transport.getTicksAtTime(time) / PPQ;
      const pulse = Math.round(beats / m.pulse) % m.num;
      const down = pulse === 0;
      // Compound meters lean on each dotted-quarter group too.
      const group = m.compound && pulse % 3 === 0;
      this.click.triggerAttackRelease(down ? 'G5' : 'C5', 0.03, time, down ? 1 : group ? 0.75 : 0.45);
    }, ticks(m.pulse), 0);
  }

  async play(fromBeat, { countIn = false } = {}) {
    await this.resume();
    await this.prepareAudio();
    this.loopCount = 0;
    this.transport.bpm.value = bpmAt(this.project, fromBeat);
    this.reschedule(fromBeat);
    const spb = 60 / bpmAt(this.project, fromBeat);
    let at = Tone.now() + 0.05;
    if (countIn) {
      const m = meter(this.project.timeSig);
      for (let i = 0; i < m.num; i++) this.click.triggerAttackRelease(i === 0 ? 'G5' : 'C5', 0.03, at + i * m.pulse * spb, i === 0 ? 1 : 0.6);
      at += m.barBeats * spb;
    }
    this.startedAt = { time: at, beat: fromBeat };
    this.transport.start(at, ticks(fromBeat));
    this.setFxRunning(true);
    return at;
  }

  // Crackle, hiss and static only sound while the song is playing.
  setFxRunning(on) {
    this.buses.masterFx.setRunning(on);
    for (const node of this.nodes.values()) node.fx.setRunning(on);
  }

  stopAudio(time, before = Infinity) {
    for (const src of this.audioSources) {
      if (src.startedAt >= before) continue;
      try { src.stop(time); } catch { /* already stopped */ }
      this.audioSources.delete(src);
    }
  }

  // Where the song is parked (for automation values while stopped).
  setCursor(beats) {
    this.cursor = beats;
  }

  stop() {
    this.setFxRunning(false);
    this.transport.stop();
    this.transport.cancel(0);
    this.stopAudio(Tone.now());
    for (const node of this.nodes.values()) node.instrument?.stopAll(Tone.now());
  }

  // Live note input (musical typing, MIDI keyboard, piano roll previews).
  noteOn(trackId, midi, vel = 0.8) {
    this.nodes.get(trackId)?.instrument?.noteOn(midi, Tone.immediate(), vel);
  }

  noteOff(trackId, midi) {
    this.nodes.get(trackId)?.instrument?.noteOff(midi, Tone.immediate());
  }

  previewNote(trackId, midi, vel = 0.8, dur = 0.35) {
    this.nodes.get(trackId)?.instrument?.play(midi, dur, Tone.immediate(), vel);
  }

  // Plays a list of notes (beats relative to now) on a throwaway channel; returns a stop function.
  async preview(instrumentId, notes, { bpm, loop = true, lengthBeats } = {}) {
    await this.resume();
    const { id, buffers } = await resolveInstrument(instrumentId);
    const node = new TrackNode(this.buses);
    node.apply({ volume: -2, pan: 0, tone: 1, drive: 0, reverb: 0.15, echo: 0 }, false);
    node.setInstrument(id, buffers);
    const spb = 60 / (bpm || this.project?.bpm || 120);
    const len = lengthBeats || Math.max(4, Math.ceil(Math.max(0, ...notes.map(n => n.t + n.d)) / 4) * 4);
    let stopped = false;
    let timer;
    const start = Tone.now() + 0.08;
    const pass = k => {
      if (stopped) return;
      const t0 = start + k * len * spb;
      for (const n of notes) node.instrument.play(n.n, n.d * spb, t0 + n.t * spb, n.v);
      if (loop) timer = setTimeout(() => pass(k + 1), Math.max(0, (t0 + len * spb - Tone.now() - 0.3) * 1000));
      else timer = setTimeout(stop, (len * spb + 2) * 1000);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      node.channel.volume.rampTo(-80, 0.05);
      setTimeout(() => node.dispose(), 200);
    };
    pass(0);
    return stop;
  }

  // ---------------------------------------------------------------- audio input (mic / interface)

  // Opens the input device with every voice-call "enhancement" off — they mangle instruments.
  async openInput(deviceId) {
    const id = deviceId || '';
    if (this.inputStream && this.inputDeviceId === id) return;
    this.closeInput(true);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, latency: { ideal: 0 },
      },
    });
    const raw = Tone.getContext().rawContext;
    this.inputStream = stream;
    this.inputDeviceId = id;
    this.inputSource = raw.createMediaStreamSource(stream);
    this.inputSplitter = raw.createChannelSplitter(2);
    this.inputSource.connect(this.inputSplitter);
    this.inputTaps = {};
  }

  // Tone's context wrapper doesn't expose outputLatency, so measure it with a brief, silent native
  // context configured the same way (same device, same buffer settings).
  async measureOutputLatency() {
    try {
      const probe = new AudioContext({ latencyHint: this.mode === 'stable' ? 'playback' : 'interactive' });
      const osc = probe.createOscillator(), mute = probe.createGain();
      mute.gain.value = 0;
      osc.connect(mute).connect(probe.destination);
      osc.start();
      let value = 0;
      for (let i = 0; i < 10 && !value; i++) { await new Promise(r => setTimeout(r, 60)); value = probe.outputLatency || 0; }
      await probe.close();
      if (value) this.outputLatency = value;
    } catch { /* keep the last measurement */ }
    return this.outputLatency || 0;
  }

  inputInfo() {
    const settings = this.inputStream?.getAudioTracks()[0]?.getSettings() || {};
    const raw = Tone.getContext().rawContext;
    const inLatency = settings.latency || 0;
    return {
      open: !!this.inputStream,
      channels: settings.channelCount || 2,
      label: this.inputStream?.getAudioTracks()[0]?.label || '',
      // What you hear when monitoring: input + processing + output buffering.
      monitorLatencyMs: Math.round((inLatency + (raw.baseLatency || 0) + (this.outputLatency || 0) + MASTER_DELAY) * 1000),
      inputLatency: inLatency,
    };
  }

  // A node carrying the chosen input: 'left' (input 1), 'right' (input 2) or 'stereo'.
  inputTap(channel = 'left') {
    if (!this.inputSource) return null;
    if (this.inputTaps[channel]) return this.inputTaps[channel];
    const raw = Tone.getContext().rawContext;
    const tap = raw.createGain();
    if (channel === 'stereo') this.inputSource.connect(tap);
    else this.inputSplitter.connect(tap, channel === 'right' ? 1 : 0);
    const analyser = raw.createAnalyser();
    analyser.fftSize = 1024;
    tap.connect(analyser);
    this.inputTaps[channel] = { tap, analyser, data: new Float32Array(1024) };
    return this.inputTaps[channel];
  }

  // Peak level of the chosen input in dB (for the input meter).
  inputLevel(channel = 'left') {
    const t = this.inputTaps?.[channel];
    if (!t) return -Infinity;
    t.analyser.getFloatTimeDomainData(t.data);
    let peak = 0;
    for (const v of t.data) peak = Math.max(peak, Math.abs(v));
    return 20 * Math.log10(peak || 1e-9);
  }

  // Sends the live input through a track's chain (amp, EQ, effects) so you hear what you play.
  setMonitor(trackId, channel = 'left') {
    if (this.monitor) {
      try { this.monitor.tap.disconnect(this.monitor.dest); } catch { /* already gone */ }
      this.monitor = null;
    }
    const node = trackId && this.nodes.get(trackId);
    const t = node && this.inputTap(channel);
    if (!t) return false;
    const dest = node.input.input;
    t.tap.connect(dest);
    this.monitor = { trackId, tap: t.tap, dest };
    return true;
  }

  closeInput(force = false) {
    if (!force && (this.monitor || this.recording)) return;
    this.setMonitor(null);
    this.recorderNode?.disconnect();
    this.recorderNode = null;
    for (const t of Object.values(this.inputTaps || {})) { t.tap.disconnect(); t.analyser.disconnect(); }
    this.inputTaps = {};
    this.inputSource?.disconnect();
    this.inputStream?.getTracks().forEach(t => t.stop());
    this.inputStream = null;
    this.inputSource = null;
    this.inputDeviceId = null;
  }

  // Records the clean (unprocessed) input; amps and effects stay adjustable afterwards.
  async startAudioRecording(deviceId, channel = 'left') {
    await this.openInput(deviceId);
    const t = this.inputTap(channel);
    const count = channel === 'stereo' ? 2 : 1;
    this.recorderNode = Tone.getContext().createAudioWorkletNode('bb-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: count, channelCountMode: 'explicit' });
    t.tap.connect(this.recorderNode);
    this.recorderNode.port.onmessage = e => this.recording?.chunks.push(e.data);
    this.recording = { chunks: [], inputLatency: this.inputInfo().inputLatency };
    this.recorderNode.port.postMessage({ on: true });
  }

  // Returns {buffer, startBeat} for what was captured since startAudioRecording().
  async stopAudioRecording(latencyMs = 0) {
    if (!this.recording) return null;
    this.recorderNode.port.postMessage({ on: false });
    await new Promise(r => setTimeout(r, 120));
    const { chunks, inputLatency } = this.recording;
    this.recording = null;
    this.recorderNode.disconnect();
    this.recorderNode = null;
    this.closeInput();
    if (!chunks.length || !this.startedAt) return null;
    const rate = Tone.getContext().sampleRate;
    const raw = Tone.getContext().rawContext;
    // You hear the beat outputLatency late and your playing reaches us inputLatency later still.
    const latency = (this.outputLatency || 0) + (raw.baseLatency || 0) + (inputLatency || 0) + MASTER_DELAY + latencyMs / 1000;
    const startTime = chunks[0].frame / rate;
    const total = chunks.reduce((n, c) => n + c.data[0].length, 0);
    const channels = Math.max(...chunks.map(c => c.data.length));
    // Drop audio captured during the count-in.
    const skip = Math.max(0, Math.round((this.startedAt.time - startTime + latency) * rate));
    if (skip >= total) return null;
    const buffer = Tone.getContext().createBuffer(channels, total - skip, rate);
    for (let ch = 0; ch < channels; ch++) {
      const out = buffer.getChannelData(ch);
      let w = -skip;
      for (const c of chunks) {
        const data = c.data[ch] || c.data[0];
        for (let i = 0; i < data.length; i++, w++) if (w >= 0) out[w] = data[i];
      }
    }
    const startBeat = beatAt(this.project, secAt(this.project, this.startedAt.beat) + Math.max(0, startTime - latency - this.startedAt.time));
    return { buffer, startBeat };
  }
}

// ------------------------------------------------------------------ offline export

export async function renderProject(project, audioPool, { start = 0, end, tail = 2.5, sampleRate = Tone.getContext().sampleRate, bufferFor = null } = {}) {
  const stop = end ?? songEnd(project);
  const duration = Math.max(0.5, secBetween(project, start, stop) + tail);
  const loaded = new Map();
  await Promise.all(project.tracks.filter(t => t.type !== 'audio').map(async t => loaded.set(t.id, await resolveInstrument(t.instrument))));

  const rendered = await Tone.Offline(async ({ transport }) => {
    // The master dynamics and the amp's noise gate are AudioWorklets; the offline context needs its own copies.
    await loadWorklets();
    transport.PPQ = PPQ;
    transport.bpm.value = bpmAt(project, start);
    const buses = buildBuses(project.bpm);
    buses.master.volume.value = project.masterVolume ?? 0;
    buses.masterFx.setConfig(project.masterFx);
    const nodes = new Map();
    for (const track of project.tracks) {
      const node = new TrackNode(buses);
      node.apply(track, isMuted(project, track), start);
      if (track.type !== 'audio') {
        const res = loaded.get(track.id);
        node.setInstrument(res.id, res.buffers);
      }
      nodes.set(track.id, node);
    }
    const trimmed = end == null ? project : {
      ...project,
      tracks: project.tracks.map(t => ({ ...t, regions: t.regions.filter(r => r.start < end) })),
    };
    scheduleProject(transport, trimmed, nodes, audioPool, { from: start, bufferFor });
    transport.start(0, ticks(start));
    if (end != null) transport.stop(secBetween(project, start, end));
  }, duration, 2, sampleRate);
  return rendered.get();
}
