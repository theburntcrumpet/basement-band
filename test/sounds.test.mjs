import test from 'node:test';
import assert from 'node:assert/strict';
import { CC0_INSTRUMENTS, CC0_PERCUSSION, VERSILIAN, cc0Samples } from '../src/engine/sample-manifest.js';
import { convertSample } from '../scripts/fetch-samples.mjs';
import { matches } from '../src/ui/search.js';
import { gmToInstrument, instrumentToGm } from '../src/music/midifile.js';

test('search needs every word, in any order and case', () => {
  assert.ok(matches('', 'Anything'));
  assert.ok(matches('  HARP ', 'Harpsichord'));
  assert.ok(matches('muted horn', 'Muted French Horn', 'Brass'));
  assert.ok(matches('brass muted', 'Muted French Horn', 'Brass'));
  assert.ok(!matches('muted tuba', 'Muted French Horn', 'Brass'));
  assert.ok(matches('baroque', 'Harpsichord', null, undefined, 'baroque'));
});

test('CC0 samples get unique scientific note names and come from pinned commits', () => {
  for (const repo of Object.values(VERSILIAN)) assert.match(repo.raw, /\/[0-9a-f]{40}\/$/);
  for (const [dir, inst] of Object.entries(CC0_INSTRUMENTS)) {
    assert.ok(VERSILIAN[inst.repo], dir);
    assert.ok(inst.path.includes('{n}'), dir);
    const names = cc0Samples(dir).map(s => s.name);
    assert.equal(new Set(names).size, names.length, dir);
    for (const n of names) assert.match(n, /^[A-G]s?-?\d$/, dir);
  }
  assert.deepEqual(cc0Samples('violin-section')[0], { upstream: 'G2', name: 'G3' });
  assert.equal(cc0Samples('trumpet-harmon').find(s => s.upstream === 'A#2')?.name, 'As3');
  assert.equal(new Set(CC0_PERCUSSION.map(p => p.file)).size, CC0_PERCUSSION.length);
});

function wav(channels, bits, rate = 44100) {
  const frames = channels[0].length, bytes = bits / 8, size = frames * channels.length * bytes;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF', 0); b.writeUInt32LE(36 + size, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels.length, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels.length * bytes, 28); b.writeUInt16LE(channels.length * bytes, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(size, 40);
  for (let i = 0, o = 44; i < frames; i++) {
    for (const c of channels) {
      if (bits === 16) b.writeInt16LE(Math.round(c[i] * 32767), o);
      else b.writeIntLE(Math.round(c[i] * 8388607), o, 3);
      o += bytes;
    }
  }
  return b;
}

// The total sample count and channel count from a FLAC file's STREAMINFO.
function flacInfo(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'fLaC');
  const packed = buf.readUInt32BE(18), low = buf.readUInt32BE(22);
  return { rate: packed >>> 12, channels: ((packed >>> 9) & 7) + 1, frames: (packed & 15) * 2 ** 32 + low };
}

test('samples are trimmed, capped and converted to FLAC', () => {
  const rate = 44100;
  const tone = Array.from({ length: rate * 2 }, (_, i) => (i < rate / 2 || i >= rate * 1.5 ? 0 : 0.5 * Math.sin(i / 10)));
  const short = flacInfo(convertSample(wav([tone, tone], 24), { stereo: true }));
  assert.equal(short.channels, 2);
  assert.ok(short.frames > rate * 0.95 && short.frames < rate * 1.05, `kept ${short.frames}`);
  assert.equal(flacInfo(convertSample(wav([tone, tone], 16), { stereo: false })).channels, 1);
  const long = Array.from({ length: rate * 10 }, (_, i) => 0.5 * Math.sin(i / 10));
  assert.equal(flacInfo(convertSample(wav([long], 16), { stereo: false })).frames, rate * 7);
});

test('General MIDI programs reach the new instruments, both ways', () => {
  for (const id of ['harpsichord', 'marimba', 'oboe', 'pizz-strings', 'kalimba', 'tubular-bells']) assert.equal(gmToInstrument(instrumentToGm(id)), id);
});
