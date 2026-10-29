// Song sections (Intro, Verse, Chorus...): markers on the arrangement strip. A section runs from its
// marker to the next one (or the end of the song). Duplicating or deleting a section moves
// everything after it — regions, tempo changes, automation and later sections.

import { uid, splitRegion, barBeats } from './state.js';

export const SECTION_NAMES = ['Intro', 'Verse', 'Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus', 'Outro'];
export const SECTION_COLORS = ['#7a8bd8', '#5fbf6a', '#e7b43c', '#d8735a', '#b07ad8', '#4fb0c6', '#d86a9a', '#9aa0ac'];

function songEndBeats(project) {
  let end = 0;
  for (const t of project.tracks) for (const r of t.regions) end = Math.max(end, r.start + r.length);
  return end;
}

// Sections with their computed ends, in order.
export function sections(project) {
  const markers = [...(project.markers || [])].sort((a, b) => a.start - b.start);
  const bar = barBeats(project);
  const end = Math.max(songEndBeats(project), ...markers.map(m => m.start + bar));
  return markers.map((m, i) => ({ ...m, end: i + 1 < markers.length ? markers[i + 1].start : Math.max(end, m.start + bar) }));
}

export function sectionAt(project, beat) {
  return sections(project).find(s => beat >= s.start - 1e-9 && beat < s.end - 1e-9) || null;
}

// The next unused-looking name for a new section.
export function nextSectionName(project) {
  const count = (project.markers || []).length;
  return SECTION_NAMES[count % SECTION_NAMES.length];
}

export function addSection(project, start, name = nextSectionName(project)) {
  project.markers = [...(project.markers || []).filter(m => Math.abs(m.start - start) > 1e-6), { id: uid(), name, start, color: SECTION_COLORS[(project.markers || []).length % SECTION_COLORS.length] }];
}

// Splits every region crossing `beat`, so whole sections can be copied or removed cleanly.
export function splitAllAt(project, beat) {
  for (const t of project.tracks) for (const r of [...t.regions]) splitRegion(t, r, beat, project);
}

// Moves everything at or after `at` by `delta` beats (positive opens a gap, negative closes one).
export function shiftFrom(project, at, delta) {
  for (const t of project.tracks) {
    for (const r of t.regions) if (r.start >= at - 1e-9) r.start += delta;
    for (const key of Object.keys(t.automation || {})) {
      t.automation[key] = t.automation[key].map(p => (p.t >= at - 1e-9 ? { ...p, t: p.t + delta } : p));
    }
  }
  project.tempoChanges = (project.tempoChanges || []).map(c => (c.beat >= at - 1e-9 ? { ...c, beat: c.beat + delta } : c));
  project.markers = (project.markers || []).map(m => (m.start >= at - 1e-9 ? { ...m, start: m.start + delta } : m));
}

// Copies a section straight after itself (everything later moves along to make room).
export function duplicateSection(project, sec) {
  const len = sec.end - sec.start;
  splitAllAt(project, sec.start);
  splitAllAt(project, sec.end);
  const inside = (t0, t1 = t0) => t0 >= sec.start - 1e-9 && t1 <= sec.end + 1e-9;
  const copies = project.tracks.map(t => ({
    t,
    regions: t.regions.filter(r => inside(r.start, r.start + r.length)).map(r => ({ ...JSON.parse(JSON.stringify(r)), id: uid(), start: r.start + len })),
    auto: Object.fromEntries(Object.entries(t.automation || {}).map(([k, pts]) => [k, pts.filter(p => inside(p.t) && p.t < sec.end - 1e-9).map(p => ({ ...p, t: p.t + len }))])),
  }));
  const tempos = (project.tempoChanges || []).filter(c => c.beat >= sec.start && c.beat < sec.end).map(c => ({ ...c, beat: c.beat + len }));
  shiftFrom(project, sec.end, len);
  for (const c of copies) {
    c.t.regions.push(...c.regions);
    for (const [k, pts] of Object.entries(c.auto)) if (pts.length) c.t.automation[k] = [...c.t.automation[k], ...pts].sort((a, b) => a.t - b.t);
  }
  project.tempoChanges = [...(project.tempoChanges || []), ...tempos];
  const m = (project.markers || []).find(x => x.id === sec.id);
  project.markers.push({ id: uid(), name: m.name, start: sec.end, color: m.color });
}

// Removes a section and everything in it, closing the gap.
export function deleteSection(project, sec) {
  const len = sec.end - sec.start;
  splitAllAt(project, sec.start);
  splitAllAt(project, sec.end);
  const inside = (t0, t1 = t0) => t0 >= sec.start - 1e-9 && t1 <= sec.end + 1e-9;
  for (const t of project.tracks) {
    t.regions = t.regions.filter(r => !inside(r.start, r.start + r.length));
    for (const k of Object.keys(t.automation || {})) t.automation[k] = t.automation[k].filter(p => !(p.t >= sec.start - 1e-9 && p.t < sec.end - 1e-9));
  }
  project.tempoChanges = (project.tempoChanges || []).filter(c => !(c.beat >= sec.start && c.beat < sec.end));
  project.markers = (project.markers || []).filter(m => m.id !== sec.id);
  shiftFrom(project, sec.end, -len);
}
