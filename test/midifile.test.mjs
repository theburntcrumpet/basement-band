import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, writeMidi, gmToInstrument, instrumentToGm } from '../src/music/midifile.js';

const buf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('round trip: tracks, notes, tempo, meter, drums on channel 10', () => {
  const song = {
    bpm: 96, timeSig: { num: 6, den: 8 },
    tracks: [
      { name: 'Keys', program: 4, notes: [{ t: 0, d: 1, n: 60, v: 0.8 }, { t: 0, d: 1, n: 64, v: 0.5 }, { t: 1, d: 0.5, n: 60, v: 1 }] },
      { name: 'Drums', drums: true, notes: [{ t: 0, d: 0.25, n: 36, v: 0.9 }, { t: 1.5, d: 0.25, n: 38, v: 0.7 }] },
    ],
  };
  const parsed = parseMidi(buf(writeMidi(song)));
  assert.equal(parsed.bpm, 96);
  assert.deepEqual(parsed.timeSig, { num: 6, den: 8 });
  const keys = parsed.tracks.find(t => t.name === 'Keys');
  const drums = parsed.tracks.find(t => t.drums);
  assert.equal(keys.program, 4);
  assert.equal(drums.channel, 9);
  const round = notes => notes.map(n => [n.t, +n.d.toFixed(3), n.n, Math.round(n.v * 127)]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  assert.deepEqual(round(keys.notes), round(song.tracks[0].notes));
  assert.deepEqual(round(drums.notes), round(song.tracks[1].notes));
});

test('reads running status, note-on velocity 0 as note-off, and the sustain pedal', () => {
  // ppq 96, one track: C4 on, (running status) E4 on, C4 off via vel 0, pedal down, E4 off, pedal up later.
  const ev = [
    0x00, 0x90, 60, 100,
    0x00, 64, 100,          // running status note-on
    0x60, 60, 0,            // +96: C4 "off" (velocity 0)
    0x00, 0xb0, 64, 127,    // pedal down
    0x10, 0x80, 64, 0,      // +16: E4 released while pedal down
    0x60, 0xb0, 64, 0,      // +96: pedal up -> E4 ends here
    0x00, 0xff, 0x2f, 0,
  ];
  const file = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, ev.length, ...ev];
  const { tracks, ppq } = parseMidi(buf(new Uint8Array(file)));
  assert.equal(ppq, 96);
  const notes = tracks[0].notes.sort((a, b) => a.n - b.n);
  assert.deepEqual(notes.map(n => [n.n, n.t, n.d]), [[60, 0, 1], [64, 0, (96 + 16 + 96) / 96]]);
});

test('general MIDI mapping both ways', () => {
  assert.equal(gmToInstrument(0), 'grand-piano');
  assert.equal(gmToInstrument(33), 'electric-bass');
  assert.equal(gmToInstrument(48), 'strings');
  assert.equal(gmToInstrument(127), 'chip');
  for (const id of ['grand-piano', 'electric-bass', 'strings', 'trumpet', 'flute', 'saxophone']) assert.equal(gmToInstrument(instrumentToGm(id)), id);
  assert.throws(() => parseMidi(new ArrayBuffer(20)), /Not a MIDI file/);
});
