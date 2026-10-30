// Finds the pitch of a played note, for the tuner: the McLeod pitch method (a normalised
// autocorrelation that resists octave errors) on a decimated signal, then refined at full rate over
// many periods, which is what makes it accurate to well under a cent.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MIN_HZ = 25;     // below a 5-string bass's low B
const MAX_HZ = 2200;
const MIN_LEVEL = 0.002; // about -54 dB: quieter than this is just hiss
const MIN_CLARITY = 0.8;

// How alike the signal is with itself `lag` samples later: 1 is identical.
function similarity(x, lag, length) {
  let cross = 0, energy = 0;
  for (let i = 0; i < length; i++) {
    const a = x[i], b = x[i + lag];
    cross += a * b;
    energy += a * a + b * b;
  }
  return energy > 0 ? (2 * cross) / energy : 0;
}

// Returns {hz, clarity}, or null if there's no clear note.
export function detectPitch(samples, rate) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;
  let power = 0;
  const x = new Float32Array(samples.length);
  for (let i = 0; i < x.length; i++) { x[i] = samples[i] - mean; power += x[i] * x[i]; }
  if (Math.sqrt(power / x.length) < MIN_LEVEL) return null;

  // Coarse search at about 11 kHz.
  const step = Math.max(1, Math.floor(rate / 11025));
  const y = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < y.length; i++) {
    let v = 0;
    for (let k = 0; k < step; k++) v += x[i * step + k];
    y[i] = v / step;
  }
  const lowRate = rate / step;
  const maxLag = Math.min(Math.floor(lowRate / MIN_HZ), Math.floor(y.length / 2));
  const minLag = Math.max(2, Math.floor(lowRate / MAX_HZ));
  const length = y.length - maxLag;
  const curve = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag + length <= y.length; lag++) curve[lag] = similarity(y, lag, length);

  // The peak of each positive stretch of the curve; take the first nearly as high as the highest,
  // since multiples of the period score just as well and would read as a lower octave.
  const peaks = [];
  let best = -1, bestLag = -1;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (curve[lag] <= 0) {
      if (bestLag > 0) peaks.push(bestLag);
      best = -1; bestLag = -1;
    } else if (curve[lag] > best && curve[lag] >= curve[lag - 1] && curve[lag] >= curve[lag + 1]) {
      best = curve[lag]; bestLag = lag;
    }
  }
  if (bestLag > 0) peaks.push(bestLag);
  if (!peaks.length) return null;
  const highest = Math.max(...peaks.map(l => curve[l]));
  if (highest < MIN_CLARITY) return null;
  const coarse = peaks.find(l => curve[l] >= highest * 0.9);

  // Refine at full rate, doubling the number of periods compared each time. A refinement that doesn't
  // find a true peak (its best is at the edge of the search, as when a note is just starting) ends
  // here with the estimate so far: extrapolating from it can give nonsense, even a negative period.
  let period = coarse * step;
  const peakNear = (centre, reach, len) => {
    let top = -2, at = centre;
    for (let lag = Math.max(1, centre - reach); lag <= centre + reach; lag++) {
      const v = similarity(x, lag, len);
      if (v > top) { top = v; at = lag; }
    }
    if (at === centre - reach || at === centre + reach) return null;
    const a = similarity(x, at - 1, len), c = similarity(x, at + 1, len);
    const bend = a - 2 * top + c;
    return bend < 0 ? at + (a - c) / (2 * bend) : at;
  };
  for (let periods = 1, reach = step + 1; period * periods < x.length; periods *= 2, reach = 2) {
    const lag = Math.round(period * periods);
    const len = x.length - lag - reach - 2;
    if (len < x.length / 3) break;
    const peak = peakNear(lag, reach, len);
    if (peak === null) break;
    period = peak / periods;
  }
  const hz = rate / period;
  if (!(hz >= MIN_HZ * 0.9 && hz <= MAX_HZ * 1.1)) return null;
  return { hz, clarity: highest };
}

// The nearest note to a frequency, and how far off it is in cents (positive is sharp).
export function nearestNote(hz, a4 = 440) {
  const exact = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(exact);
  return { midi, name: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents: (exact - midi) * 100 };
}
