import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heardContextTime, placeTake, placeNativeTake } from '../src/engine/take-placement.js';

const device = { rate: 48000, buffer: 128, inputLatency: 96 };

test('a take maps through the device clock, performance clock and output timestamp', () => {
  // The callback at helper time 10.000 s delivered frames [48000, 48128). Helper time runs 5 s ahead
  // of performance.now(); the context was outputting time 2.0 at performance 4000 ms.
  const chunk = { first: 48000, frameTime: 10, frame: 48000 };
  const heard = heardContextTime(chunk, device, { offset: 5 }, { contextTime: 2, performanceTime: 4000 });
  // Frame 48000 hit the converter (128 + 96 frames) before the callback: 10 - 224/48000 s helper
  // time = 5 - 0.004667 s performance time = 1000 ms after the timestamp, minus 4.667 ms.
  assert.ok(Math.abs(heard - (2 + 1 - 224 / 48000)) < 1e-9);
});

test('placement skips the count-in and lands on the song beat', () => {
  const project = { bpm: 120, tempoChanges: [] };
  // Playback (beat 4) started at context time 3.0; the take began 1 s earlier (count-in).
  const { skip, startBeat } = placeTake(2, { time: 3, beat: 4 }, project, 48000);
  assert.equal(skip, 48000);
  assert.equal(startBeat, 4);
  // A take starting half a second after playback starts lands one beat later at 120 bpm.
  const later = placeTake(3.5, { time: 3, beat: 4 }, project, 48000);
  assert.equal(later.skip, 0);
  assert.equal(later.startBeat, 5);
  // The recording offset setting nudges it (+20 ms = later).
  assert.ok(Math.abs(placeTake(3.5, { time: 3, beat: 4 }, project, 48000, 20).startBeat - 5.04) < 1e-9);
});

test('placement follows tempo changes', () => {
  const project = { bpm: 120, tempoChanges: [{ beat: 8, bpm: 60 }] };
  // From beat 4 at 120 bpm, 2 s reaches beat 8; 1 s more at 60 bpm is beat 9.
  assert.ok(Math.abs(placeTake(6, { time: 3, beat: 4 }, project, 48000).startBeat - 9) < 1e-9);
});

test('native placement uses the device clock and the round-trip latency', () => {
  const project = { bpm: 120, tempoChanges: [] };
  const device = { rate: 48000, inputLatency: 100, outputLatency: 140 };
  // The song started rolling at frame 96000 at beat 8. A take whose first frame is 96240 began
  // exactly as the song started (240 frames of latency).
  const a = placeNativeTake({ first: 96240 }, device, { frame: 96000, beat: 8 }, project);
  assert.equal(a.skip, 0);
  assert.ok(Math.abs(a.startBeat - 8) < 1e-9);
  // Recording from a count-in: the first 48000 frames come before the song starts.
  const b = placeNativeTake({ first: 48240 }, device, { frame: 96000, beat: 8 }, project);
  assert.equal(b.skip, 48000);
  assert.ok(Math.abs(b.startBeat - 8) < 1e-9);
  // Half a second after the start is one beat later at 120 bpm.
  assert.ok(Math.abs(placeNativeTake({ first: 120240 }, device, { frame: 96000, beat: 8 }, project).startBeat - 9) < 1e-9);
});
