import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSf2 } from '../src/engine/formats/soundfont.js';
import { parseSfz, sfzKey, joinPath } from '../src/engine/formats/sfz.js';
import { audioMeta } from '../src/engine/formats/audiometa.js';

// ------------------------------------------------------------------ a tiny SF2 built in memory

function riff(id, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
const list = (type, ...parts) => riff('LIST', Buffer.from(type, 'latin1'), ...parts);
const name20 = s => { const b = Buffer.alloc(20); b.write(s, 'latin1'); return b; };
const u16 = (...n) => { const b = Buffer.alloc(2 * n.length); n.forEach((x, i) => b.writeUInt16LE(x & 0xffff, i * 2)); return b; };
const gen = (op, amount) => Buffer.concat([u16(op), Buffer.from(Int16Array.of(amount).buffer)]);
const range = (op, lo, hi) => Buffer.concat([u16(op), Buffer.from([lo, hi])]);

function tinySf2() {
  // One 1000-frame sample: a ramp, looped 200..800, recorded at A4 (69), 22050 Hz.
  const pcm = Buffer.alloc(2 * (1000 + 46));
  for (let i = 0; i < 1000; i++) pcm.writeInt16LE(Math.round((i / 1000) * 16000), i * 2);
  const shdr = (name, start, end, ls, le, rate, pitch, corr, type) => {
    const b = Buffer.alloc(46);
    b.write(name, 0, 'latin1');
    b.writeUInt32LE(start, 20); b.writeUInt32LE(end, 24); b.writeUInt32LE(ls, 28); b.writeUInt32LE(le, 32);
    b.writeUInt32LE(rate, 36); b.writeUInt8(pitch, 40); b.writeInt8(corr, 41); b.writeUInt16LE(0, 42); b.writeUInt16LE(type, 44);
    return b;
  };
  const phdr = (n, prog, bank, bag) => Buffer.concat([name20(n), u16(prog, bank, bag), Buffer.alloc(12)]);
  const inst = (n, bag) => Buffer.concat([name20(n), u16(bag)]);
  // Preset "Ramp" (bank 0 prog 5): global zone attenuation 30cB, zone -> instrument 0, keyRange 40..80.
  const pgen = Buffer.concat([gen(48, 30), range(43, 40, 80), gen(41, 0), gen(0, 0)]);
  const pbag = u16(0, 0, 1, 0, 3, 0);
  // Instrument: global release 1200tc (2s); zone keyRange 60..100, root override 69, loop, coarse +12, sample 0.
  const igen = Buffer.concat([gen(38, 1200), range(43, 60, 100), gen(58, 69), gen(54, 1), gen(51, 12), gen(17, -250), gen(53, 0), gen(0, 0)]);
  const ibag = u16(0, 0, 1, 0, 7, 0);
  const pdta = list('pdta',
    riff('phdr', phdr('Ramp', 5, 0, 0), phdr('EOP', 0, 0, 2)),
    riff('pbag', pbag), riff('pmod', Buffer.alloc(10)), riff('pgen', pgen),
    riff('inst', inst('RampInst', 0), inst('EOI', 2)),
    riff('ibag', ibag), riff('imod', Buffer.alloc(10)), riff('igen', igen),
    riff('shdr', shdr('ramp', 0, 1000, 200, 800, 22050, 69, -5, 1), shdr('EOS', 0, 0, 0, 0, 0, 0, 0, 0)));
  const file = riff('RIFF', Buffer.from('sfbk', 'latin1'),
    list('INFO', riff('ifil', u16(2, 4)), riff('INAM', Buffer.from('Tiny\0', 'latin1'))),
    list('sdta', riff('smpl', pcm)), pdta);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

test('sf2: presets, zone merging and unit conversion', () => {
  const sf = parseSf2(tinySf2());
  assert.equal(sf.name, 'Tiny');
  assert.deepEqual(sf.presets, [{ name: 'Ramp', bank: 0, program: 5 }]);
  const [r] = sf.regions(0, 5);
  assert.deepEqual([r.lokey, r.hikey], [60, 80], 'key ranges intersect');
  assert.equal(r.root, 69);
  assert.equal(r.tune, 1200 - 5, 'coarse tune plus pitch correction');
  assert.equal(r.gainDb, -3, 'preset attenuation adds');
  assert.equal(r.pan, -0.5);
  assert.ok(Math.abs(r.env.release - 2) < 1e-9, 'timecents to seconds');
  assert.equal(r.loop.mode, 'continuous');
  assert.deepEqual(r.loop.frames, { start: 200, end: 800 });
  const { data, rate } = sf.sampleData(r.sample);
  assert.equal(rate, 22050);
  assert.equal(data.length, 1000);
  assert.ok(Math.abs(data[500] - 8000 / 32768) < 1e-4);
});

test('sf2: rejects non-soundfonts', () => {
  assert.throws(() => parseSf2(new ArrayBuffer(64)), /Not a SoundFont/);
});

// ------------------------------------------------------------------ SFZ

test('sfz: note names and paths', () => {
  assert.equal(sfzKey('c4'), 60);
  assert.equal(sfzKey('g#1'), 32);
  assert.equal(sfzKey('Bb2'), 46);
  assert.equal(sfzKey('64'), 64);
  assert.equal(joinPath('/lib/inst', 'tuned\\g2.wav'), '/lib/inst/tuned/g2.wav');
  assert.equal(joinPath('/lib/inst', '../samples/a.wav'), '/lib/samples/a.wav');
});

test('sfz: inheritance, defines, includes, CC defaults and comments', async () => {
  const files = {
    '/lib/common.sfzh': '<global> ampeg_release=0.5 // shared\n',
  };
  const text = `
    /* header comment */
    #define $VEL 64
    <control> default_path=Samples\\ set_cc102=127
    #include "common.sfzh"
    <group> lovel=$VEL ampeg_decay=1 ampeg_decay_oncc102=2 loop_mode=loop_continuous group=1 off_by=2
    <region> sample=Piano C4.wav key=c4
    <region> sample=Piano E4.wav lokey=d4 hikey=f#4 pitch_keycenter=e4 tune=-10 pan=50 seq_length=2 seq_position=2
    <group> trigger=release
    <region> sample=rel.wav lokey=0 hikey=127 locc64=64
  `;
  const res = await parseSfz(text, { path: '/lib/piano.sfz', readText: async p => files[p] });
  const [a, b, c] = res.regions;
  assert.equal(res.regions.length, 3);
  assert.equal(a.sample, '/lib/Samples/Piano C4.wav', 'spaces in sample names and default_path');
  assert.deepEqual([a.lokey, a.hikey, a.root, a.lovel], [60, 60, 60, 64]);
  assert.equal(a.env.release, 0.5, 'global from #include');
  assert.equal(a.env.decay, 3, 'decay + oncc102 at set_cc102=127');
  assert.equal(a.loop.mode, 'continuous');
  assert.deepEqual([a.group, a.offBy], [1, 2]);
  assert.deepEqual([b.lokey, b.hikey, b.root, b.tune, b.pan], [62, 66, 64, -10, 0.5]);
  assert.deepEqual([b.seqLength, b.seqPosition], [2, 2]);
  assert.equal(c.trigger, 'release');
  assert.equal(c.lovel, 1, 'new <group> resets group opcodes');
  assert.deepEqual(c.conds, [{ cc: 64, lo: 64, hi: 127 }]);
});

// ------------------------------------------------------------------ audio metadata

test('wav metadata: rate and smpl loop', () => {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(32000, 4);
  const smpl = Buffer.alloc(36 + 24);
  smpl.writeUInt32LE(1, 28); smpl.writeUInt32LE(100, 44); smpl.writeUInt32LE(499, 48);
  const wav = riff('RIFF', Buffer.from('WAVE', 'latin1'), riff('fmt ', fmt), riff('smpl', smpl), riff('data', Buffer.alloc(8)));
  const meta = audioMeta(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  assert.deepEqual(meta, { rate: 32000, loop: { start: 100, end: 500 } });
});

// ------------------------------------------------------------------ real files, when available

const SCRATCH = process.env.BB_SFZ_TEST_DIR;
const FLUID = '/usr/share/soundfonts/FluidR3_GM.sf2';

test('real: FluidR3 GM soundfont', { skip: !fs.existsSync(FLUID) && 'FluidR3_GM.sf2 not installed' }, () => {
  const buf = fs.readFileSync(FLUID);
  const sf = parseSf2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.ok(sf.presets.length > 180, `presets: ${sf.presets.length}`);
  const piano = sf.regions(0, 0);
  assert.ok(piano.length > 10);
  for (const n of [21, 60, 108]) assert.ok(piano.some(r => n >= r.lokey && n <= r.hikey), `piano covers ${n}`);
  const kit = sf.regions(128, 0);
  for (const n of [36, 38, 42, 46, 49]) assert.ok(kit.some(r => n >= r.lokey && n <= r.hikey), `kit has ${n}`);
  for (const r of [...piano, ...kit]) {
    const s = sf.samples[r.sample];
    assert.ok(s.end > s.start && s.rate > 3000, 'sample header sane');
    if (r.loop.mode !== 'none') assert.ok(r.loop.frames.end > r.loop.frames.start, 'loop sane');
  }
});

test('real: SFZ libraries parse and resolve their samples', { skip: !SCRATCH && 'set BB_SFZ_TEST_DIR' }, async () => {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory() && e.name !== '.git') walk(p); else if (e.name.endsWith('.sfz')) files.push(p);
  });
  walk(SCRATCH);
  assert.ok(files.length >= 10);
  for (const f of files) {
    const res = await parseSfz(fs.readFileSync(f, 'utf8'), { path: f, readText: async p => fs.readFileSync(p, 'utf8') });
    assert.ok(res.regions.length > 0, `${f}: no regions`);
    for (const r of res.regions) assert.ok(fs.existsSync(r.sample), `${path.basename(f)}: missing ${r.sample}`);
  }
  const jr = fs.readdirSync(SCRATCH).includes('jlearman.jRhodes3c');
  if (jr) {
    const flac = path.join(SCRATCH, 'jlearman.jRhodes3c/jRhodes3c-looped-flac-sfz/As_029__F1_51-stereo.flac');
    const b = fs.readFileSync(flac);
    const meta = audioMeta(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    assert.equal(meta.rate, 44100);
    assert.ok(meta.loop && meta.loop.end > meta.loop.start, 'FLAC foreign-metadata loop found');
  }
});

import { response, EQ_BANDS } from '../src/engine/eq.js';

test('eq response: shelves and bell land where expected', () => {
  const freqs = [30, 120, 1000, 5000, 15000];
  const flat = response({}, freqs);
  flat.forEach(db => assert.ok(Math.abs(db) < 1e-6, 'flat when all at 0'));
  const [lo30, , mid1k, , hi15k] = response({ eqLow: 6, eqMid: -4, eqHigh: 9 }, freqs);
  assert.ok(Math.abs(lo30 - 6) < 0.3, `bass shelf ${lo30}`);
  assert.ok(Math.abs(mid1k + 4) < 0.6, `mid bell ${mid1k}`);
  assert.ok(Math.abs(hi15k - 9) < 0.6, `treble shelf ${hi15k}`);
  const [bassOnlyAt5k] = response({ eqLow: 12 }, [5000]);
  assert.ok(Math.abs(bassOnlyAt5k) < 0.3, 'bass leaves treble alone');
  assert.equal(EQ_BANDS.length, 3);
});

import { encodeFlac } from '../src/engine/formats/flac.js';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('flac encoder is lossless (decoded by ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const rate = 44100, n = rate * 2 + 1234;  // odd length exercises the short last block
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * 0.2;
    l[i] = i < 5000 ? 0 : Math.sin(i * 0.03) * 0.6 + noise;   // silence, then tone + noise
    r[i] = Math.max(-1, Math.min(1, Math.sin(i * 0.011) * 1.2)); // clipped full-scale
  }
  const bytes = encodeFlac([l, r], rate);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-flac-'));
  fs.writeFileSync(path.join(dir, 'a.flac'), bytes);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'a.flac'), '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  const dec = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  assert.equal(dec.length, n * 2, 'sample count');
  const q = v => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    if (dec[i * 2] !== q(l[i]) || dec[i * 2 + 1] !== q(r[i])) assert.fail(`mismatch at ${i}: ${dec[i * 2]},${dec[i * 2 + 1]} vs ${q(l[i])},${q(r[i])}`);
  }
  assert.ok(bytes.length < n * 4 * 0.8, `compressed ${(bytes.length / (n * 4) * 100).toFixed(0)}% of PCM`);
  // ffmpeg verifies frame CRCs too: decoding with explode on errors must succeed.
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path.join(dir, 'a.flac'), '-f', 'null', '-']);
  fs.rmSync(dir, { recursive: true });
});

import { encodeMp3 } from '../src/engine/export.js';
import { Mp3Encoder } from '@breezystack/lamejs';

test('mp3 export decodes to the right length and pitch', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const rate = 44100, n = rate * 3;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5; r[i] = Math.sin((2 * Math.PI * 660 * i) / rate) * 0.5; }
  const bytes = await encodeMp3([l, r], rate, 192, Mp3Encoder);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mp3-'));
  const file = path.join(dir, 'a.mp3');
  fs.writeFileSync(file, bytes);
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,bit_rate:format=duration', '-of', 'json', file]).toString();
  const meta = JSON.parse(info);
  assert.equal(meta.streams[0].channels, 2);
  assert.equal(Number(meta.streams[0].sample_rate), 44100);
  assert.ok(Math.abs(Number(meta.format.duration) - 3) < 0.1, `duration ${meta.format.duration}`);
  // Count zero crossings of the left channel to check pitch survived.
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '2', '-'], { maxBuffer: 1 << 26 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  let crossings = 0;
  for (let i = rate; i < rate * 2; i++) if ((s[i * 2] >= 0) !== (s[(i + 1) * 2] >= 0)) crossings++;
  assert.ok(Math.abs(crossings / 2 - 440) < 3, `left pitch ${crossings / 2} Hz`);
  fs.rmSync(dir, { recursive: true });
});
