#!/usr/bin/env node
// Downloads the plugins that ship with Basement Band into plugins/ (bundled into the installers).
// Currently Dexed, a free DX7-style FM synth (GPL-3.0, https://github.com/asb2m10/dexed).
//
//   node scripts/fetch-plugins.mjs [--platform linux|win32|darwin] [--force]

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'plugins');
const argv = process.argv.slice(2);
const platform = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : process.platform;
const force = argv.includes('--force');

const DEXED = {
  version: '1.0.1',
  source: 'https://github.com/asb2m10/dexed/releases/download/v1.0.1/dexed-source-bce5dee.tar.gz',
  builds: {
    linux: { file: 'Dexed-1.0.1-lnx.zip', sha256: '2bac3d0c4237e8c22c4274b6d5b59fe6329fcae72864f81b5830393eff354fc1' },
    win32: { file: 'Dexed-1.0.1-win.zip', sha256: '1f118445f2c5c411636bb41ddf8b456db09af74cd38f9ede8a93a01020505f05' },
    darwin: { file: 'Dexed-1.0.1-macOS.zip', sha256: '4269448bc1312424cafd29aff615d891bc5905ebfc54b42ce70c56b9b10dc401' },
  },
};

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const build = DEXED.builds[platform];
  if (!build) throw new Error(`No bundled plugins for ${platform}`);
  const marker = path.join(OUT, `.dexed-${DEXED.version}-${platform}`);
  if (!force && (await exists(marker))) return console.log('Bundled plugins are up to date.');

  console.log(`Downloading ${build.file}…`);
  const res = await fetch(`https://github.com/asb2m10/dexed/releases/download/v${DEXED.version}/${build.file}`);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== build.sha256) throw new Error(`Checksum mismatch for ${build.file}: ${hash}`);

  await fs.rm(OUT, { recursive: true, force: true });
  const tmp = path.join(OUT, '.download');
  await fs.mkdir(tmp, { recursive: true });
  const zip = path.join(tmp, build.file);
  await fs.writeFile(zip, bytes);
  // unzip on Linux; bsdtar (built into Windows 10+ and macOS) reads zips elsewhere.
  if (process.platform === 'linux') execFileSync('unzip', ['-q', zip, 'Dexed.vst3/*', 'LICENSE', '-d', tmp]);
  else execFileSync('tar', ['-xf', zip, '-C', tmp]);
  await fs.rename(path.join(tmp, 'Dexed.vst3'), path.join(OUT, 'Dexed.vst3'));
  await fs.rename(path.join(tmp, 'LICENSE'), path.join(OUT, 'Dexed-LICENSE.txt'));
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.writeFile(path.join(OUT, 'README.md'), `# Bundled plugins

**Dexed ${DEXED.version}** — a multi-platform, multi-format plugin synth closely modelled on the
Yamaha DX7, by Pascal Gauthier and contributors. Licensed under the GNU GPL v3 (Dexed-LICENSE.txt).

- Project: https://github.com/asb2m10/dexed
- Source code for this exact release: ${DEXED.source}

Basement Band runs Dexed as a separate plugin; Basement Band's own code is MIT licensed.
`);
  await fs.writeFile(marker, '');
  console.log(`Bundled Dexed ${DEXED.version} for ${platform} in plugins/`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
