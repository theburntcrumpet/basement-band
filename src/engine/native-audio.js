// The native low-latency engine for live audio (see native/plugin-host/Source/LiveAudio.h): the
// helper opens the audio interface itself and runs the monitored track's chain (amp, cabinet, EQ,
// effects) with only the device's buffering as latency, and records the clean input.
//
// Song playback still comes from the app's Web Audio engine, so a take is placed by time: each
// recorded frame has a device-clock time, which maps to performance.now() (by pinging the helper),
// which maps to the AudioContext time being heard at that moment (getOutputTimestamp), which maps
// to a beat of the song.

import { bridge } from './plugins.js';

// ------------------------------------------------------------------ the client

export class NativeAudio extends EventTarget {
  constructor() {
    super();
    this.device = null;       // status from the helper once open
    this.peak = 0;
    this.chunks = null;
    this.monitoring = false;
    bridge.addEventListener('inputLevel', e => { this.peak = Math.max(this.peak * 0.7, e.detail.peak); });
    bridge.addEventListener('input', e => { this.chunks?.push(e.detail); this.tap?.(e.detail.data); });
    bridge.addEventListener('crash', () => { this.device = null; this.monitoring = false; this.tap = null; });
  }

  async devices() {
    return bridge.call('audio:devices');
  }

  // settings: {type, input, output, buffer}; opened at the song's sample rate where possible.
  async open(settings, rate) {
    const res = await bridge.call('audio:open', { type: settings.type || '', input: settings.input || '', output: settings.output || '', rate, buffer: settings.buffer || 128 });
    this.device = res;
    await this.syncClock();
    return res;
  }

  async close() {
    this.monitoring = false;
    this.device = null;
    try { await bridge.call('audio:close'); } catch { /* helper gone */ }
  }

  // Helper clock vs performance.now(): keep the estimate from the quickest round trip.
  async syncClock() {
    let best = null;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const c = await bridge.call('audio:clock');
      const t1 = performance.now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: c.now - (t0 + t1) / 2000 };
    }
    this.clock = best;
    return best;
  }

  // Sends the monitored track's settings (call again whenever they change).
  async monitor(track, project, channel = 'left') {
    this.monitoring = !!track;
    return bridge.call('monitor:set', {
      on: !!track, input: channel, track: track || {}, bpm: project?.bpm || 120, masterVolume: project?.masterVolume ?? 0, masterFx: project?.masterFx || null,
    });
  }

  levelDb() {
    return 20 * Math.log10(this.peak || 1e-9);
  }

  // What you hear while monitoring: input + buffer + output, plus the chain's ~1 ms.
  monitorLatencyMs() {
    const d = this.device;
    if (!d) return null;
    return Math.round(((d.inputLatency || 0) + (d.outputLatency || 0) + d.buffer) / d.rate * 1000 + 1);
  }

  // Listens to the clean input without keeping it (the tuner). It uses the helper's recording stream,
  // so it has to stop before a real recording starts.
  async startTap(listener) {
    this.tap = listener;
    await bridge.call('record:start');
  }

  async stopTap() {
    if (!this.tap) return;
    this.tap = null;
    await bridge.call('record:stop').catch(() => {});
  }

  async startRecording() {
    this.chunks = [];
    await bridge.call('record:start');
  }

  // Returns the take as {data: Float32Array, first, frameTime, frame} (or null if nothing came in).
  async stopRecording() {
    const stopped = new Promise(resolve => {
      const done = e => { if (e.detail.event === 'recordStopped') { bridge.removeEventListener('recordStopped', done); resolve(); } };
      bridge.addEventListener('recordStopped', done);
      setTimeout(resolve, 1500);
    });
    await bridge.call('record:stop');
    await stopped;
    const chunks = this.chunks || [];
    this.chunks = null;
    if (!chunks.length) return null;
    const total = chunks.reduce((n, c) => n + c.data.length, 0);
    const data = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { data.set(c.data, o); o += c.data.length; }
    // Every chunk carries the clock reading of its moment; the first chunk's describes frame `first`.
    return { data, first: chunks[0].first, frameTime: chunks[0].frameTime, frame: chunks[0].frame };
  }
}
