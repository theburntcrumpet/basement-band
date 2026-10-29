// Standard MIDI File (.mid) reading and writing. Positions are in beats (quarter notes), so bars line
// up regardless of tempo; the file's first tempo and time signature are reported for empty songs.

// ------------------------------------------------------------------ General MIDI <-> our sounds

// GM program (0-127) -> built-in instrument id.
export function gmToInstrument(program) {
  const p = program;
  if (p === 4 || p === 5) return 'electric-piano';
  if (p === 6 || p === 7) return 'clav';
  if (p < 8) return 'grand-piano';
  if (p === 11) return 'vibes';
  if (p === 12 || p === 13) return 'xylophone';
  if (p < 16) return 'bells';
  if (p === 19) return 'church-organ';
  if (p === 20 || p === 21 || p === 23) return 'harmonium';
  if (p < 24) return 'tonewheel-organ';
  if (p === 24) return 'nylon-guitar';
  if (p === 25) return 'acoustic-guitar';
  if (p < 29) return 'clean-guitar';
  if (p < 32) return 'crunch-guitar';
  if (p === 32 || p === 43) return 'upright-bass';
  if (p === 38 || p === 39) return 'synth-bass';
  if (p < 40) return 'electric-bass';
  if (p === 40 || p === 41) return 'violin';
  if (p === 42) return 'cello';
  if (p === 46) return 'harp';
  if (p === 52 || p === 53 || p === 54) return 'glass-pad';
  if (p < 56) return 'strings';
  if (p === 56 || p === 59) return 'trumpet';
  if (p === 57) return 'trombone';
  if (p === 58) return 'tuba';
  if (p === 60) return 'french-horn';
  if (p < 64) return 'brass';
  if (p < 68) return 'saxophone';
  if (p === 70) return 'bassoon';
  if (p < 72) return 'clarinet';
  if (p < 80) return 'flute';
  if (p === 80) return 'square-lead';
  if (p < 88) return 'saw-lead';
  if (p === 88 || p === 91 || p === 94 || p === 95) return 'glass-pad';
  if (p < 96) return 'warm-pad';
  if (p < 104) return 'glass-pad';
  if (p === 104 || p === 105 || p === 106 || p === 107) return 'nylon-guitar';
  if (p < 112) return 'harp';
  if (p < 120) return 'xylophone';
  return 'chip';
}

// Built-in instrument id -> GM program, for export.
const GM_OF = {
  'grand-piano': 0, 'electric-piano': 4, 'clav': 7, 'tonewheel-organ': 16, 'church-organ': 19, 'harmonium': 20,
  'electric-bass': 33, 'upright-bass': 32, 'synth-bass': 38, 'sub-bass': 38,
  'acoustic-guitar': 25, 'nylon-guitar': 24, 'clean-guitar': 27, 'crunch-guitar': 29,
  'strings': 48, 'violin': 40, 'cello': 42, 'harp': 46, 'brass': 61, 'trumpet': 56, 'trombone': 57, 'french-horn': 60, 'tuba': 58,
  'saxophone': 66, 'flute': 73, 'clarinet': 71, 'bassoon': 70, 'xylophone': 13, 'vibes': 11, 'bells': 14,
  'warm-pad': 89, 'glass-pad': 88, 'saw-lead': 81, 'square-lead': 80, 'pluck': 84, 'chip': 80,
};
export const instrumentToGm = id => GM_OF[id] ?? 0;

// ------------------------------------------------------------------ reading

function readVarLen(v, pos) {
  let value = 0, b;
  do { b = v.getUint8(pos.i++); value = (value << 7) | (b & 0x7f); } while (b & 0x80);
  return value;
}

const str = (v, o, n) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + o, n));

// -> {ppq, bpm, timeSig: {num, den}, tracks: [{name, channel, program, drums, notes: [{t, d, n, v}]}]}
export function parseMidi(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 14 || str(v, 0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const ntracks = v.getUint16(10);
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const ppq = division;
  let bpm = null, timeSig = null;
  const tempos = [];
  const out = [];
  let o = 8 + v.getUint32(4);
  for (let t = 0; t < ntracks && o + 8 <= v.byteLength; t++) {
    if (str(v, o, 4) !== 'MTrk') break;
    const len = v.getUint32(o + 4);
    const end = Math.min(v.byteLength, o + 8 + len);
    const pos = { i: o + 8 };
    let tick = 0, status = 0, name = '';
    // Per channel: program, open notes, sustain state.
    const ch = Array.from({ length: 16 }, () => ({ program: null, open: new Map(), pedal: false, held: [], notes: [] }));
    const close = (c, note, at) => {
      const list = c.open.get(note);
      if (!list?.length) return;
      const n = list.shift();
      n.endTick = at;
      if (c.pedal) c.held.push(n); else n.done = true;
    };
    while (pos.i < end) {
      tick += readVarLen(v, pos);
      let b = v.getUint8(pos.i);
      if (b & 0x80) { status = b; pos.i++; } else if (status < 0x80) break; // running status
      b = status;
      if (b === 0xff) {
        const type = v.getUint8(pos.i++);
        const l = readVarLen(v, pos);
        if (type === 0x51 && l === 3) {
          const tb = 60000000 / ((v.getUint8(pos.i) << 16) | (v.getUint8(pos.i + 1) << 8) | v.getUint8(pos.i + 2));
          if (bpm == null) bpm = tb;
          tempos.push({ beat: tick / ppq, bpm: tb });
        }
        if (type === 0x58 && l >= 2 && timeSig == null) timeSig = { num: v.getUint8(pos.i), den: 2 ** v.getUint8(pos.i + 1) };
        if (type === 0x03 && !name) name = str(v, pos.i, l).replace(/\0/g, '').trim();
        pos.i += l;
        if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { pos.i += readVarLen(v, pos); continue; }
      const cmd = b & 0xf0, c = ch[b & 0x0f];
      const d1 = v.getUint8(pos.i++);
      const d2 = cmd === 0xc0 || cmd === 0xd0 ? 0 : v.getUint8(pos.i++);
      if (cmd === 0x90 && d2 > 0) {
        const n = { startTick: tick, n: d1, v: d2 / 127 };
        c.notes.push(n);
        if (!c.open.has(d1)) c.open.set(d1, []);
        c.open.get(d1).push(n);
      } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
        close(c, d1, tick);
      } else if (cmd === 0xc0) {
        if (c.program == null) c.program = d1;
      } else if (cmd === 0xb0 && d1 === 64) {
        // Sustain pedal: notes released while it's down end when it lifts.
        const down = d2 >= 64;
        if (!down && c.pedal) { for (const n of c.held) n.endTick = tick; c.held = []; }
        c.pedal = down;
      }
    }
    ch.forEach((c, i) => {
      for (const list of c.open.values()) for (const n of list) n.endTick = tick;
      for (const n of c.held) n.endTick = Math.max(n.endTick, tick);
      if (!c.notes.length) return;
      out.push({
        name: name || (i === 9 ? 'Drums' : `Track ${out.length + 1}`),
        channel: i,
        program: c.program ?? 0,
        drums: i === 9,
        notes: c.notes.map(n => ({ t: n.startTick / ppq, d: Math.max(1 / 32, ((n.endTick ?? n.startTick) - n.startTick) / ppq), n: n.n, v: n.v })),
      });
    });
    o = end;
  }
  tempos.sort((a, b) => a.beat - b.beat);
  return { ppq, bpm: bpm ? Math.round(bpm * 10) / 10 : null, tempos, timeSig, tracks: out };
}

// ------------------------------------------------------------------ writing

function varLen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (id, body) => [...id].map(c => c.charCodeAt(0)).concat(u32(body.length), body);
const text = s => [...new TextEncoder().encode(s)];

// song = {bpm, timeSig, tracks: [{name, program, drums, notes: [{t, d, n, v}]}]} -> Uint8Array
export function writeMidi(song, ppq = 480) {
  const tempo = Math.round(60000000 / song.bpm);
  const den = Math.round(Math.log2(song.timeSig?.den || 4));
  const conductor = [
    0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, song.timeSig?.num || 4, den, 24, 8,
  ];
  // Later tempo changes ({beat, bpm}) follow in time order.
  let lastTick = 0;
  for (const c of [...(song.tempos || [])].sort((a, b) => a.beat - b.beat)) {
    const tick = Math.round(c.beat * ppq), us = Math.round(60000000 / c.bpm);
    conductor.push(...varLen(tick - lastTick), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    lastTick = tick;
  }
  conductor.push(0, 0xff, 0x2f, 0);
  const tracks = [chunk('MTrk', conductor)];
  let nextChannel = 0;
  for (const tr of song.tracks) {
    let channel;
    if (tr.drums) channel = 9;
    else { channel = nextChannel % 15; if (channel >= 9) channel++; nextChannel++; }
    const events = [];
    for (const n of tr.notes) {
      const on = Math.round(n.t * ppq), off = Math.max(on + 1, Math.round((n.t + n.d) * ppq));
      const vel = Math.max(1, Math.min(127, Math.round(n.v * 127)));
      events.push({ tick: on, order: 1, bytes: [0x90 | channel, n.n, vel] });
      events.push({ tick: off, order: 0, bytes: [0x80 | channel, n.n, 0] });
    }
    // Note-offs before note-ons at the same tick, so repeated notes don't swallow each other.
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const name = text(tr.name || 'Track');
    const body = [0, 0xff, 0x03, ...varLen(name.length), ...name];
    if (!tr.drums) body.push(0, 0xc0 | channel, tr.program & 127);
    let last = 0;
    for (const e of events) { body.push(...varLen(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    tracks.push(chunk('MTrk', body));
  }
  // Format 1, track count, ticks per quarter note.
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (ppq >> 8) & 255, ppq & 255]);
  return new Uint8Array([...header, ...tracks.flat()]);
}
