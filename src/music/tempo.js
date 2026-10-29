// The tempo map: a song starts at project.bpm and may change tempo at given beats
// (project.tempoChanges = [{beat, bpm}], beat > 0). Changes are steps, not ramps.
// Converts between beats and seconds anywhere in the song.

export function tempoPoints(project) {
  const changes = (project.tempoChanges || []).filter(c => c.beat > 1e-9).sort((a, b) => a.beat - b.beat);
  return [{ beat: 0, bpm: project.bpm }, ...changes];
}

function segmentAt(points, beat) {
  let i = 0;
  while (i + 1 < points.length && points[i + 1].beat <= beat + 1e-9) i++;
  return i;
}

export function bpmAt(project, beat) {
  const pts = tempoPoints(project);
  return pts[segmentAt(pts, beat)].bpm;
}

// Seconds from the start of the song to `beat`.
export function secAt(project, beat) {
  const pts = tempoPoints(project);
  let sec = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].beat, b = i + 1 < pts.length ? pts[i + 1].beat : Infinity;
    if (beat <= a) break;
    sec += ((Math.min(beat, b) - a) * 60) / pts[i].bpm;
  }
  return sec;
}

// The beat reached `sec` seconds into the song.
export function beatAt(project, sec) {
  const pts = tempoPoints(project);
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const spb = 60 / pts[i].bpm;
    const nextBeat = i + 1 < pts.length ? pts[i + 1].beat : Infinity;
    const segSec = (nextBeat - pts[i].beat) * spb;
    if (sec <= t + segSec) return pts[i].beat + (sec - t) / spb;
    t += segSec;
  }
  return 0;
}

export const secBetween = (project, a, b) => secAt(project, b) - secAt(project, a);

// How many beats `seconds` of audio covers when it starts at `startBeat`.
export const beatsFor = (project, startBeat, seconds) => beatAt(project, secAt(project, startBeat) + seconds) - startBeat;

// Tempo changes from `from` onwards (inclusive), for scheduling on the transport.
export const changesFrom = (project, from) => tempoPoints(project).filter(p => p.beat >= from - 1e-9 && p.beat > 1e-9);
