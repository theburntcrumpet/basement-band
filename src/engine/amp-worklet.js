// Front of the guitar amp:
// - Noise gate: silences hum and hiss between notes, which high gain makes loud. Opens fast on a
//   pick attack, closes smoothly, with hysteresis so decaying notes don't chatter.
// - Sustain: gently lifts a note's fading tail (up to 30 dB at full sustain), so high-gain amps keep
//   a note saturated and let it go gradually, like a real amp's sag or a compressor in front.
//   It eases off near silence so the noise floor isn't pumped up.
// native/plugin-host/Source/Dsp.h (Gate) does exactly the same; keep them in step.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -60, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'sustain', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 0;
    this.open = false;
    this.hold = 0;
    const sr = sampleRate;
    this.envRelease = Math.exp(-1 / (0.02 * sr));
    this.attack = 1 - Math.exp(-1 / (0.0008 * sr));
    this.release = 1 - Math.exp(-1 / (0.08 * sr));
    this.holdSamples = Math.floor(0.05 * sr);
    this.susEnv = 0;
    this.susGainDb = 0;
    this.susAttack = 1 - Math.exp(-1 / (0.003 * sr));
    this.susRelease = 1 - Math.exp(-1 / (0.15 * sr));
    this.susSmooth = 1 - Math.exp(-1 / (0.01 * sr));
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const thresholdDb = params.threshold[0];
    const off = thresholdDb <= -99;
    const openAt = Math.pow(10, thresholdDb / 20);
    const closeAt = openAt * 0.5; // 6 dB of hysteresis
    const sustain = params.sustain[0];
    const ratio = 1 + 5 * sustain, maxBoost = 30 * sustain;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.env = peak > this.env ? peak : this.env * this.envRelease;
      if (this.env > openAt) { this.open = true; this.hold = this.holdSamples; }
      else if (this.env < closeAt && this.hold-- <= 0) this.open = false;
      const target = off || this.open ? 1 : 0;
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      // Sustain: boost below -24 dB at ratio 1+5s (at most 30s dB), fading out between -66 and -80 dB.
      let boost = 1;
      if (sustain > 0.001) {
        this.susEnv += (peak - this.susEnv) * (peak > this.susEnv ? this.susAttack : this.susRelease);
        const envDb = 20 * Math.log10(this.susEnv + 1e-9);
        let db = envDb < -24 ? Math.min(maxBoost, (-24 - envDb) * (1 - 1 / ratio)) : 0;
        if (envDb < -66) db *= Math.max(0, Math.min(1, (envDb + 80) / 14));
        this.susGainDb += (db - this.susGainDb) * this.susSmooth;
        boost = Math.pow(10, this.susGainDb / 20);
      }
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain * boost;
    }
    return true;
  }
}

registerProcessor('bb-gate', GateProcessor);
