// Noise gate for the guitar amp: silences hum and hiss between notes, which high gain makes loud.
// Opens fast on a pick attack, closes smoothly, with hysteresis so decaying notes don't chatter.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -60, minValue: -100, maxValue: 0, automationRate: 'k-rate' }];
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
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const thresholdDb = params.threshold[0];
    const off = thresholdDb <= -99;
    const openAt = Math.pow(10, thresholdDb / 20);
    const closeAt = openAt * 0.5; // 6 dB of hysteresis
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.env = peak > this.env ? peak : this.env * this.envRelease;
      if (this.env > openAt) { this.open = true; this.hold = this.holdSamples; }
      else if (this.env < closeAt && this.hold-- <= 0) this.open = false;
      const target = off || this.open ? 1 : 0;
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    return true;
  }
}

registerProcessor('bb-gate', GateProcessor);
