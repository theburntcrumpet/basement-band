// Plays audio rendered elsewhere (by the plugin helper) at exact frames of the audio clock.
// Chunks arrive as {frame, l, r}; each sample plays when currentFrame reaches its frame. Anything
// that arrives too late is dropped, and gaps play as silence. Every two blocks it reports the clock,
// which is what drives rendering ahead.
const SIZE = 1 << 16; // ~1.4 s at 48 kHz

class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(SIZE);
    this.r = new Float32Array(SIZE);
    this.at = new Float64Array(SIZE).fill(-1); // which frame each slot holds
    this.blocks = 0;
    this.late = 0;
    this.port.onmessage = e => {
      const { frame, l, r } = e.data;
      if (e.data.reset) { this.at.fill(-1); return; }
      for (let i = 0; i < l.length; i++) {
        const f = frame + i;
        if (f < currentFrame) { this.late++; continue; }
        const k = f % SIZE;
        this.l[k] = l[i];
        this.r[k] = r[i];
        this.at[k] = f;
      }
    };
  }

  process(_inputs, outputs) {
    const [outL, outR] = outputs[0];
    for (let i = 0; i < outL.length; i++) {
      const f = currentFrame + i, k = f % SIZE;
      if (this.at[k] === f) {
        outL[i] = this.l[k];
        if (outR) outR[i] = this.r[k];
        this.at[k] = -1;
      } else {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
    }
    if (++this.blocks % 2 === 0) {
      this.port.postMessage({ now: currentFrame + outL.length, late: this.late });
      this.late = 0;
    }
    return true;
  }
}

registerProcessor('bb-stream', StreamProcessor);
