// Captures raw input audio with sample-accurate frame stamps for latency-correct recording.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.pending = null;
    this.port.onmessage = e => {
      this.on = e.data.on;
      if (!this.on) this.flush();
    };
  }

  flush() {
    if (!this.pending) return;
    const { frame, chunks } = this.pending;
    const data = chunks[0].map((_, ch) => {
      const out = new Float32Array(chunks.length * 128);
      chunks.forEach((c, i) => out.set(c[ch], i * 128));
      return out;
    });
    this.port.postMessage({ frame, data }, data.map(d => d.buffer));
    this.pending = null;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.on || !input || !input.length) return true;
    if (!this.pending) this.pending = { frame: currentFrame, chunks: [] };
    this.pending.chunks.push(input.map(ch => ch.slice(0)));
    if (this.pending.chunks.length >= 32) this.flush();
    return true;
  }
}

registerProcessor('bb-recorder', RecorderProcessor);
