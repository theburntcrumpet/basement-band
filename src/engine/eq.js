// The per-track tone EQ: a bass shelf, a broad mid bell and a treble shelf, ±12 dB each.
// response() mirrors the Web Audio biquad formulas (RBJ cookbook) so the curve drawn in Smart
// Controls is exactly what the filters do.

export const EQ_BANDS = [
  { key: 'eqLow', label: 'Bass', type: 'lowshelf', freq: 120 },
  { key: 'eqMid', label: 'Mid', type: 'peaking', freq: 1000, q: 0.7 },
  { key: 'eqHigh', label: 'Treble', type: 'highshelf', freq: 5000 },
];

export const EQ_RANGE = 12;

function coefficients(type, f0, gainDb, q, rate) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  if (type === 'peaking') {
    const alpha = sin / (2 * q);
    return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  // Shelves with slope S = 1, as Web Audio defines them.
  const alpha = (sin / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  if (type === 'lowshelf') {
    return [
      A * ((A + 1) - (A - 1) * cos + k), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - k),
      (A + 1) + (A - 1) * cos + k, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - k,
    ];
  }
  return [
    A * ((A + 1) + (A - 1) * cos + k), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - k),
    (A + 1) - (A - 1) * cos + k, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - k,
  ];
}

function magnitudeDb([b0, b1, b2, a0, a1, a2], freq, rate) {
  const w = (2 * Math.PI * freq) / rate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// Combined gain in dB at each frequency for a track's EQ settings.
export function response(track, freqs, rate = 48000) {
  const bands = EQ_BANDS.map(b => coefficients(b.type, b.freq, track[b.key] || 0, b.q || 0.7071, rate));
  return freqs.map(f => bands.reduce((sum, c) => sum + magnitudeDb(c, f, rate), 0));
}
