// Time-stretching without changing pitch (WSOLA: waveform-similarity overlap-add).
// Each output frame is taken from near where it "should" come from in the input, nudged to the
// position whose waveform best continues the previous frame, then cross-faded in with a Hann window.

// channels: Float32Array[]; factor: output length / input length (e.g. 1.25 = 25% longer/slower).
export function timeStretch(channels, factor, sampleRate) {
  if (Math.abs(factor - 1) < 1e-4) return channels.map(c => c.slice());
  const N = sampleRate > 60000 ? 4096 : 2048;      // ~43 ms frames
  const Hs = N / 2;                                 // output hop; Hann at 50% overlap sums to 1
  const Ha = Hs / factor;                           // input hop
  const tol = Math.round(0.012 * sampleRate);       // search ±12 ms for the best match
  const inLen = channels[0].length;
  const outLen = Math.max(1, Math.round(inLen * factor));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // Matching is done on a mono mix so every channel uses the same positions (keeps stereo intact).
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] += c[i] / channels.length;

  const out = channels.map(() => new Float32Array(outLen + N));
  const maxStart = Math.max(0, inLen - N);
  const stride = 4;        // sub-sample the comparison for speed
  let prev = null;

  // Frame k lands at output position (k - 1) * Hs: the first frame starts half a frame before 0, so
  // every output sample is covered by two overlapping windows.
  for (let k = 0; (k - 1) * Hs < outLen; k++) {
    const o = (k - 1) * Hs;
    // The lead frame reads the input from -Hs so its second half lines up with the first samples.
    const nominal = k === 0 ? -Hs : Math.min(maxStart, Math.round((k - 1) * Ha));
    let best = nominal;
    const target = prev == null ? null : prev + Hs; // where the previous frame naturally continues
    if (target != null && nominal >= 0 && target >= 0 && target + Hs < inLen) {
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - tol), hi = Math.min(maxStart, nominal + tol);
      for (let p = lo; p <= hi; p += 2) {
        let dot = 0, energy = 1e-9;
        for (let i = 0; i < Hs; i += stride) {
          const a = mono[p + i];
          dot += a * mono[target + i];
          energy += a * a;
        }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = out[c];
      for (let i = Math.max(0, -o); i < N; i++) {
        const s = best + i;
        if (s >= 0 && s < inLen) dst[o + i] += src[s] * win[i];
      }
    }
    prev = best;
  }
  return out.map(d => d.subarray(0, outLen).slice());
}
