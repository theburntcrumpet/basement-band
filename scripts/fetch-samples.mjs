#!/usr/bin/env node
// Downloads the bundled open-licensed sample library into assets/samples/.
// Run automatically on `npm install`; re-run with `npm run fetch-samples`.
//
//   --if-missing   skip when this version of the library is already present
//   --force        re-download files that already exist

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'samples');
const args = new Set(process.argv.slice(2));

const TONEJS_INSTRUMENTS = 'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples';
const TONEJS_AUDIO = 'https://raw.githubusercontent.com/Tonejs/audio/master';
const HYDROGEN = 'https://raw.githubusercontent.com/hydrogen-music/hydrogen/master/data/drumkits';

import { INSTRUMENT_NOTES, PIANO_NOTES, ROCK_FILES, TR808_FILES, FREESOUND_FX, SONICPI_FX } from '../src/engine/sample-manifest.js';

// Bump when the library gains files so existing installs fetch the additions.
const LIBRARY_VERSION = '2';

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
  return list;
}

const CREDITS = `# Bundled sample library credits

Basement Band ships with the following freely licensed recordings.

| Folder | Source | Author | License |
|---|---|---|---|
| piano/ | Salamander Grand Piano V2 (via Tonejs/audio) | Alexander Holm | CC-BY 3.0 |
| bass-electric/, guitar-electric/, saxophone/ | Karoryfer Samples (via nbrosowsky/tonejs-instruments) | Karoryfer | CC-BY 3.0 |
| bassoon/, contrabass/, flute/, french-horn/, harp/, organ/, trombone/, trumpet/, tuba/, violin/, xylophone/ | VSCO 2 Community Edition (via nbrosowsky/tonejs-instruments) | Versilian Studios | CC-BY 3.0 as distributed |
| guitar-acoustic/ | University of Iowa Electronic Music Studios (via nbrosowsky/tonejs-instruments) | UIowa MIS | CC-BY 3.0 as distributed |
| cello/, guitar-nylon/, harmonium/ | Freesound packs 12408, 11573, 330410 (via nbrosowsky/tonejs-instruments) | flcellogrl, quartertone, donyaquick | CC-BY 3.0 as distributed |
| drums-rock/ | Hydrogen GMRockKit | Glen MacArthur / Sebastian Moors | GPL |
| drums-808/ | Hydrogen TR808EmulationKit | Hydrogen project | GPL |

- https://github.com/Tonejs/audio
- https://github.com/nbrosowsky/tonejs-instruments (samples: CC-BY 3.0)
- https://github.com/hydrogen-music/hydrogen (drum kits: GPL)
- https://creativecommons.org/licenses/by/3.0/
`;

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
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest + '.part', buf);
    await fs.rename(dest + '.part', dest);
    return 'downloaded';
  } catch (err) {
    if (attempt < 3) return download(job, attempt + 1);
    throw new Error(`${job.url}: ${err.message}`);
  }
}

async function main() {
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
  await fs.writeFile(path.join(OUT, 'CREDITS.md'), CREDITS + fxCredits());
  await fs.writeFile(marker, LIBRARY_VERSION);
  console.log('Sample library ready.');
}

main();
