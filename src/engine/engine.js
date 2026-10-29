// Audio engine: mixer graph, transport scheduling, live input, recording and offline export.

import { createInstrument, loadInstrumentBuffers, fallbackFor, getInstrument } from './instruments.js';
import { meter } from '../music/meter.js';
import { EQ_BANDS } from './eq.js';
import { FxSlot } from './effects.js';
import { AmpSlot } from './amp.js';

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

  apply(track, muted) {
    const now = Tone.now();
    this.channel.volume.rampTo(track.volume, 0.05, now);
    this.channel.pan.rampTo(track.pan, 0.05, now);
    this.channel.mute = muted;
    this.filter.frequency.rampTo(400 * Math.pow(50, track.tone ?? 1), 0.05, now);
    EQ_BANDS.forEach((b, i) => this.eq[i].gain.rampTo(track[b.key] || 0, 0.05, now));
    this.fx.setConfig(track.fx);
    this.amp.setConfig(track.amp);
    const d = track.drive || 0;
    this.drive.distortion = 0.1 + 0.75 * d;
    this.drive.wet.value = Math.min(1, d * 2);
    this.reverbSend.gain.rampTo(Math.pow(track.reverb ?? 0, 1.5), 0.05, now);
    this.delaySend.gain.rampTo((track.echo ?? 0) * 0.7, 0.05, now);
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

// Schedules a whole project onto a transport.
//   from:      the beat playback starts at; audio already under way there starts partway through
//   cycle:     the cycle range, if on; audio spanning its start restarts partway on each repeat
//   isRepeat:  () => true once the transport has wrapped round the cycle at least once
//   active:    a Set collecting live audio sources, so they can be stopped
export function scheduleProject(transport, project, nodes, audioPool, { from = 0, cycle = null, isRepeat = () => false, active = null } = {}) {
  const spb = 60 / project.bpm;
  for (const track of project.tracks) {
    const node = nodes.get(track.id);
    if (!node) continue;
    for (const region of track.regions) {
      if (track.type === 'audio') {
        const buffer = audioPool.get(region.audioId);
        if (!buffer || regionEnd(region) <= from) continue;
        // One-shot sources at exact transport times (Tone's synced Player could start a clip twice).
        const ctx = node.input.context;
        for (const seg of audioSegments(region)) {
          const offset = (region.offset || 0) + seg.into * spb;
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
          else if (end > from) transport.schedule(once(t => play(t, (from - seg.at) * spb)), ticks(from));
          if (cycle && seg.at < cycle.start - 1e-9 && end > cycle.start) {
            transport.schedule(once(t => { if (isRepeat()) play(t, (cycle.start - seg.at) * spb); }), ticks(cycle.start));
          }
        }
        continue;
      }
      for (const n of expandRegion(region)) {
        if (n.t < from - 1e-6) continue;
        transport.schedule(once(time => node.instrument?.play(n.n, n.d * spb, time, n.v)), ticks(n.t));
      }
    }
  }
}

// ------------------------------------------------------------------ live engine

export class Engine extends EventTarget {
  constructor() {
    super();
    this.nodes = new Map();
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
    this.transport.bpm.value = project.bpm;
    this.transport.timeSignature = [project.timeSig.num, project.timeSig.den];
    this.buses.delay.delayTime.rampTo((60 / project.bpm) * 0.75, 0.05);
    this.buses.master.volume.rampTo(project.masterVolume ?? 0, 0.05);
    this.buses.masterFx.setConfig(project.masterFx);
    const ids = new Set(project.tracks.map(t => t.id));
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) { node.dispose(); this.nodes.delete(id); }
    }
    for (const track of project.tracks) {
      let node = this.nodes.get(track.id);
      if (!node) {
        node = new TrackNode(this.buses, { meter: true });
        this.nodes.set(track.id, node);
      }
      node.apply(track, isMuted(project, track));
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
  reschedule(from = this.playing ? this.position() + 0.05 : 0) {
    this.transport.cancel(0);
    this.stopAudio(Tone.now());
    const cycle = this.project.cycle?.on ? this.project.cycle : null;
    scheduleProject(this.transport, this.project, this.nodes, this.audioPool, { from, cycle, isRepeat: () => this.loopCount > 0, active: this.audioSources });
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
    this.loopCount = 0;
    this.reschedule(fromBeat);
    const spb = 60 / this.project.bpm;
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
    const startBeat = this.startedAt.beat + Math.max(0, startTime - latency - this.startedAt.time) / (60 / this.project.bpm);
    return { buffer, startBeat };
  }
}

// ------------------------------------------------------------------ offline export

export async function renderProject(project, audioPool, { start = 0, end, tail = 2.5, sampleRate = Tone.getContext().sampleRate } = {}) {
  const spb = 60 / project.bpm;
  const stop = end ?? songEnd(project);
  const duration = Math.max(0.5, (stop - start) * spb + tail);
  const loaded = new Map();
  await Promise.all(project.tracks.filter(t => t.type !== 'audio').map(async t => loaded.set(t.id, await resolveInstrument(t.instrument))));

  const rendered = await Tone.Offline(async ({ transport }) => {
    // The master dynamics and the amp's noise gate are AudioWorklets; the offline context needs its own copies.
    await loadWorklets();
    transport.PPQ = PPQ;
    transport.bpm.value = project.bpm;
    const buses = buildBuses(project.bpm);
    buses.master.volume.value = project.masterVolume ?? 0;
    buses.masterFx.setConfig(project.masterFx);
    const nodes = new Map();
    for (const track of project.tracks) {
      const node = new TrackNode(buses);
      node.apply(track, isMuted(project, track));
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
    scheduleProject(transport, trimmed, nodes, audioPool, { from: start });
    transport.start(0, ticks(start));
    if (end != null) transport.stop((end - start) * spb);
  }, duration, 2, sampleRate);
  return rendered.get();
}
