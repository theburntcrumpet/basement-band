#!/usr/bin/env node
// Downloads the bundled open-licensed sample library into assets/samples/.
// Run automatically on `npm install`; re-run with `npm run fetch-samples`.
//
//   --if-missing   skip when this version of the library is already present
//   --force        re-download files that already exist

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'samples');
const args = new Set(process.argv.slice(2));

const TONEJS_INSTRUMENTS = 'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples';
const TONEJS_AUDIO = 'https://raw.githubusercontent.com/Tonejs/audio/master';
const HYDROGEN = 'https://raw.githubusercontent.com/hydrogen-music/hydrogen/master/data/drumkits';

import { INSTRUMENT_NOTES, PIANO_NOTES, ROCK_FILES, TR808_FILES, FREESOUND_FX, SONICPI_FX, VERSILIAN, CC0_INSTRUMENTS, CC0_PERCUSSION, cc0Samples } from '../src/engine/sample-manifest.js';
import { encodeFlac } from '../src/engine/formats/flac.js';

// Bump when the library gains files so existing installs fetch the additions.
const LIBRARY_VERSION = '3';

const MAX_SECONDS = 7;

function jobs() {
  const list = [...FREESOUND_FX, ...SONICPI_FX].map(fx => ({ url: fx.url, file: fx.file }));
  for (const n of PIANO_NOTES) {
    list.push({ url: `${TONEJS_AUDIO}/salamander/${n}.mp3`, file: `piano/${n}.mp3` });
  }
  for (const [inst, notes] of Object.entries(INSTRUMENT_NOTES)) {
    for (const n of notes.split(' ')) {
      list.push({ url: `${TONEJS_INSTRUMENTS}/${inst}/${n}.mp3`, file: `${inst}/${n}.mp3` });
    }
  }
  for (const f of ROCK_FILES) list.push({ url: `${HYDROGEN}/GMRockKit/${f}`, file: `drums-rock/${f}` });
  for (const f of TR808_FILES) list.push({ url: `${HYDROGEN}/TR808EmulationKit/${f}`, file: `drums-808/${f}` });
  const raw = (repo, file) => VERSILIAN[repo].raw + file.split('/').map(encodeURIComponent).join('/');
  for (const [dir, inst] of Object.entries(CC0_INSTRUMENTS)) {
    for (const { upstream, name } of cc0Samples(dir)) {
      const source = inst.alt?.[upstream] ? inst.path.replace(/\{n\}.*$/, `{n}${inst.alt[upstream]}`) : inst.path;
      list.push({ url: raw(inst.repo, source.replace('{n}', upstream)), file: `${dir}/${name}.flac`, convert: { stereo: !!inst.stereo } });
    }
  }
  for (const p of CC0_PERCUSSION) list.push({ url: raw('vcsl', p.path), file: p.file, convert: { stereo: false } });
  return list;
}

// Reads a PCM or float WAV into one Float32Array per channel.
function readWav(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not a WAV file');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { tag: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') data = { start: o + 8, size: Math.min(size, buf.length - o - 8) };
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunks');
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  const float = fmt.tag === 3 || (fmt.tag === 0xfffe && fmt.bits === 32);
  const read = float ? o => v.getFloat32(o, true)
    : bytes === 2 ? o => v.getInt16(o, true) / 32768
      : bytes === 3 ? o => ((v.getInt8(o + 2) << 16) | v.getUint16(o, true)) / 8388608
        : o => v.getInt32(o, true) / 2147483648;
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0, o = data.start; i < frames; i++) for (let c = 0; c < fmt.channels; c++, o += bytes) channels[c][i] = read(o);
  return { channels, rate: fmt.rate };
}

// Prepares a sample to play instantly and take little space: 16-bit FLAC, no silence either end,
// no longer than a held note needs, and mono unless the recording's stereo image matters.
export function convertSample(buf, { stereo }) {
  const { channels, rate } = readWav(buf);
  let out = channels;
  if (!stereo || channels.length === 1) {
    out = [new Float32Array(channels[0].length)];
    for (const c of channels) for (let i = 0; i < c.length; i++) out[0][i] += c[i] / channels.length;
  } else out = channels.slice(0, 2);
  const level = i => Math.max(...out.map(c => Math.abs(c[i])));
  let peak = 0;
  for (let i = 0; i < out[0].length; i++) peak = Math.max(peak, level(i));
  let from = 0, to = out[0].length;
  while (from < to && level(from) < peak * 0.003) from++;
  while (to > from && level(to - 1) < peak * 0.0005) to--;
  from = Math.max(0, from - Math.round(rate * 0.002));
  to = Math.min(to, from + MAX_SECONDS * rate);
  const fade = Math.round(rate * (to - from >= MAX_SECONDS * rate ? 0.4 : 0.01));
  const trimmed = out.map(c => {
    const t = c.slice(from, to);
    for (let i = 0; i < fade && i < t.length; i++) t[t.length - 1 - i] *= i / fade;
    return t;
  });
  return Buffer.from(encodeFlac(trimmed, rate));
}

const CREDITS = `# Bundled sample library credits

Basement Band ships with the following freely licensed recordings. See LICENSES.md for everything
else in the app and the full license texts.

| Folder | Source | Author | License |
|---|---|---|---|
| piano/ | Salamander Grand Piano V2 (via Tonejs/audio) | Alexander Holm | CC-BY 3.0 |
| bass-electric/, guitar-electric/, saxophone/ | Karoryfer Samples (via nbrosowsky/tonejs-instruments) | Karoryfer | CC-BY 3.0 |
| bassoon/, contrabass/, flute/, french-horn/, harp/, organ/, trombone/, trumpet/, tuba/, violin/, xylophone/ | VSCO 2 Community Edition (via nbrosowsky/tonejs-instruments) | Versilian Studios | CC-BY 3.0 as distributed |
| clarinet/ | nbrosowsky/tonejs-instruments, which doesn't name the recording for this instrument | see upstream | CC-BY 3.0 as distributed |
| guitar-acoustic/ | University of Iowa Electronic Music Studios (via nbrosowsky/tonejs-instruments) | UIowa MIS | CC-BY 3.0 as distributed |
| cello/ | Freesound pack 12408, "real cello notes" (via nbrosowsky/tonejs-instruments) | flcellogrl | CC-BY 4.0 on Freesound |
| guitar-nylon/ | Freesound pack 11573, "ClassicalGuitar-multisampled" (via nbrosowsky/tonejs-instruments) | quartertone | CC-BY 4.0 on Freesound |
| harmonium/ | Freesound sound 330410, "Harmonium Samples" (via nbrosowsky/tonejs-instruments) | donyaquick | CC0 1.0 on Freesound |
| drums-rock/ | Hydrogen GMRockKit | Glen MacArthur / Sebastian Moors | GPL-3.0-or-later |
| drums-808/ | Hydrogen TR808EmulationKit | ArtemioLabs | GPL-3.0-or-later |

- https://github.com/Tonejs/audio
- https://github.com/nbrosowsky/tonejs-instruments (samples: CC-BY 3.0)
- https://github.com/hydrogen-music/hydrogen (drum kits: GPL)
- https://creativecommons.org/licenses/by/3.0/
- https://creativecommons.org/licenses/by/4.0/
`;

function cc0Credits() {
  const rows = Object.entries(VERSILIAN).map(([repo, r]) => {
    const dirs = Object.entries(CC0_INSTRUMENTS).filter(([, i]) => i.repo === repo).map(([d]) => `${d}/`);
    if (repo === 'vcsl') dirs.push('perc/');
    return `| ${dirs.join(', ')} | [${r.name}](${r.url}) | Versilian Studios (Sam Gossner) and contributors | CC0 1.0 |`;
  });
  return `
## Versilian libraries

Public domain (CC0 1.0), so credit isn't required but is gladly given. Versilian asks that the samples
aren't sold on their own and that improvements stay open; Basement Band is free and open source. These
files are trimmed and converted to 16-bit FLAC by scripts/fetch-samples.mjs.

| Folder | Source | Author | License |
|---|---|---|---|
${rows.join('\n')}
`;
}

function fxCredits() {
  const rows = [...FREESOUND_FX, ...SONICPI_FX].map(fx => `| ${fx.file} | ${fx.name} | ${fx.author} | [source](${fx.page}) | CC0 1.0 |`);
  return `
## Sound effects and atmospheres (fx/)

All public domain (CC0 1.0). Freesound files are the site's high-quality previews; Sonic Pi files
come from its CC0 sample set (each originally from Freesound). Credit is not required but given anyway.

| File | Name | Author | Source | License |
|---|---|---|---|---|
${rows.join('\n')}

Generated FX (risers, sweeps, impacts...) are synthesized by Basement Band itself and have no source files.
`;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function download(job, attempt = 1) {
  const dest = path.join(OUT, job.file);
  if (!args.has('--force') && await exists(dest)) return 'skipped';
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    const res = await fetch(job.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (job.convert) buf = convertSample(buf, job.convert);
    await fs.writeFile(dest + '.part', buf);
    await fs.rename(dest + '.part', dest);
    return 'downloaded';
  } catch (err) {
    if (attempt < 3) return download(job, attempt + 1);
    throw new Error(`${job.url}: ${err.message}`);
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const marker = path.join(OUT, '.version');
  const current = await fs.readFile(marker, 'utf8').catch(() => '');
  if (args.has('--if-missing') && current.trim() === LIBRARY_VERSION) {
    console.log('Sample library already present (run `npm run fetch-samples` to update).');
    return;
  }
  const list = jobs();
  console.log(`Fetching ${list.length} samples into ${path.relative(ROOT, OUT)}/ ...`);
  let done = 0, failed = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      try { await download(job); } catch (err) { failed++; console.warn('  failed:', err.message); }
      done++;
      if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${list.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (process.stdout.isTTY) process.stdout.write('\n');
  if (failed) {
    console.warn(`${failed} samples failed to download. Instruments fall back to built-in synths; re-run \`npm run fetch-samples\`.`);
    process.exitCode = args.has('--if-missing') ? 0 : 1;
    return;
  }
  await fs.writeFile(path.join(OUT, 'CREDITS.md'), CREDITS + cc0Credits() + fxCredits());
  await fs.writeFile(marker, LIBRARY_VERSION);
  console.log('Sample library ready.');
}

// Only when run as a script: the tests import convertSample.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
