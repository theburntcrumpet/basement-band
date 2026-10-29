// Track automation: curves of {t (beats), v (the parameter's own units)} that override a mixer
// setting over time. Pure helpers here; the engine applies them to the audio params.

export const AUTO_PARAMS = [
  { key: 'volume', label: 'Volume', min: -40, max: 6, unit: 'dB', fmt: v => `${v.toFixed(1)} dB` },
  { key: 'pan', label: 'Pan', min: -1, max: 1, fmt: v => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)) },
  { key: 'reverb', label: 'Reverb', min: 0, max: 1, fmt: v => `${Math.round(v * 100)}%` },
  { key: 'echo', label: 'Echo', min: 0, max: 1, fmt: v => `${Math.round(v * 100)}%` },
  { key: 'tone', label: 'Tone', min: 0, max: 1, fmt: v => `${Math.round(v * 100)}%` },
  { key: 'eqLow', label: 'EQ Bass', min: -12, max: 12, fmt: v => `${v.toFixed(1)} dB` },
  { key: 'eqMid', label: 'EQ Mid', min: -12, max: 12, fmt: v => `${v.toFixed(1)} dB` },
  { key: 'eqHigh', label: 'EQ Treble', min: -12, max: 12, fmt: v => `${v.toFixed(1)} dB` },
];

export const AUTO_PARAM = Object.fromEntries(AUTO_PARAMS.map(p => [p.key, p]));

// The track's static value for a parameter (what the knob says when there's no automation).
export function staticValue(track, key) {
  const v = track[key];
  if (v != null) return v;
  return { volume: -4, pan: 0, reverb: 0, echo: 0, tone: 1 }[key] ?? 0;
}

export const curve = (track, key) => track.automation?.[key] || [];
export const isAutomated = (track, key) => curve(track, key).length > 0;

// Value of a curve at `beat`: linear between points, held flat before the first and after the last.
export function valueAt(points, beat) {
  if (!points.length) return null;
  if (beat <= points[0].t) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (beat <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (beat - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1].v;
}

// Keeps a curve sorted by time with one point per moment (the later edit wins).
export function normalize(points) {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of sorted) {
    if (out.length && Math.abs(out[out.length - 1].t - p.t) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// The ramps to play from `from` onwards: [{at, v, to, toV}] — each ramp starts at `at` (beats)
// with value v and moves linearly to toV at `to`. The first ramp starts at `from` itself.
export function rampsFrom(points, from) {
  if (!points.length) return [];
  const out = [];
  const startV = valueAt(points, from);
  const next = points.findIndex(p => p.t > from + 1e-9);
  if (next === -1) return [{ at: from, v: startV, to: null, toV: startV }];
  out.push({ at: from, v: startV, to: points[next].t, toV: points[next].v });
  for (let i = next; i < points.length; i++) {
    const p = points[i], q = points[i + 1];
    out.push({ at: p.t, v: p.v, to: q ? q.t : null, toV: q ? q.v : p.v });
  }
  return out;
}
