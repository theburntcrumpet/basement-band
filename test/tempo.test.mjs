import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bpmAt, secAt, beatAt, secBetween, beatsFor, changesFrom } from '../src/music/tempo.js';

const song = { bpm: 120, tempoChanges: [{ beat: 16, bpm: 60 }, { beat: 8, bpm: 90 }] };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('tempo at a beat', () => {
  assert.equal(bpmAt(song, 0), 120);
  assert.equal(bpmAt(song, 7.99), 120);
  assert.equal(bpmAt(song, 8), 90);
  assert.equal(bpmAt(song, 20), 60);
});

test('beats <-> seconds across changes', () => {
  close(secAt(song, 8), 4);            // 8 beats at 120
  close(secAt(song, 16), 4 + 8 * (60 / 90));
  close(secAt(song, 18), 4 + 8 * (60 / 90) + 2);
  for (const b of [0, 3, 8, 11.5, 16, 25]) close(beatAt(song, secAt(song, b)), b);
  close(secBetween(song, 6, 10), 1 + 2 * (60 / 90));
  close(beatsFor(song, 6, 1 + 2 * (60 / 90)), 4);
  assert.deepEqual(changesFrom(song, 10).map(c => c.beat), [16]);
  close(secAt({ bpm: 100 }, 10), 6);
});
