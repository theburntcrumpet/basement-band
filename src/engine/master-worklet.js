// Master bus dynamics: gentle "glue" compression and a brickwall limiter with a 1 ms lookahead.
// Replaces two DynamicsCompressorNodes, which each add a fixed 6 ms delay in Chromium — that
// delay sat in the guitar monitoring path and threw recording alignment off.
class MasterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    // Glue compressor: -16 dB threshold, 2.5:1, 8 dB soft knee.
    this.thr = -16; this.ratio = 2.5; this.knee = 8;
    this.att = Math.exp(-1 / (0.012 * sr));
    this.rel = Math.exp(-1 / (0.2 * sr));
    this.det = 0;
    // Limiter: -0.8 dBFS ceiling, 1 ms lookahead, 60 ms release.
    this.ceil = Math.pow(10, -0.8 / 20);
    this.look = Math.max(1, Math.round(0.001 * sr));
    this.limRel = Math.exp(-1 / (0.06 * sr));
    this.limGain = 1;
    this.buf = [new Float32Array(this.look + 1), new Float32Array(this.look + 1)];
    this.need = new Float32Array(this.look + 1);
    this.w = 0;
  }

  compGainDb(levelDb) {
    const over = levelDb - this.thr, k = this.knee / 2;
    if (over <= -k) return 0;
    const slope = 1 - 1 / this.ratio;
    if (over >= k) return -over * slope;
    return (-slope * (over + k) * (over + k)) / (2 * this.knee);
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const n = output[0].length, L = this.look, size = L + 1;
    const inL = input[0] || new Float32Array(n), inR = input[1] || inL;
    for (let i = 0; i < n; i++) {
      // Glue compression on the incoming sample.
      const peak = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
      this.det = peak > this.det ? this.att * this.det + (1 - this.att) * peak : this.rel * this.det + (1 - this.rel) * peak;
      const g = Math.pow(10, this.compGainDb(20 * Math.log10(this.det + 1e-9)) / 20);
      const l = inL[i] * g, r = inR[i] * g;
      // Queue it, remembering the gain it will need to stay under the ceiling.
      const w = this.w;
      this.buf[0][w] = l; this.buf[1][w] = r;
      const p = Math.max(Math.abs(l), Math.abs(r));
      this.need[w] = p > this.ceil ? this.ceil / p : 1;
      this.w = (w + 1) % size;
      // The limiter looks across the queued millisecond so it is already down when a peak leaves.
      let target = 1;
      for (let k = 0; k < size; k++) if (this.need[k] < target) target = this.need[k];
      this.limGain = target < this.limGain ? target : this.limRel * this.limGain + (1 - this.limRel) * target;
      const out = this.w; // oldest sample
      output[0][i] = this.buf[0][out] * this.limGain;
      if (output[1]) output[1][i] = this.buf[1][out] * this.limGain;
    }
    return true;
  }
}

registerProcessor('bb-master', MasterProcessor);
