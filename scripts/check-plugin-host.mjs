#!/usr/bin/env node
// End-to-end check of the native plugin helper with the bundled Dexed (run in CI on every OS):
// finds and scans the plugin, loads it, plays a note, and reads its settings back.
//   node scripts/check-plugin-host.mjs [path/to/bb-plugin-host]

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(ROOT, 'native', 'plugin-host', 'build', 'bb-plugin-host_artefacts', 'Release');
const helper = process.argv[2] || path.join(base, process.platform === 'win32' ? 'bb-plugin-host.exe' : 'bb-plugin-host');
const pluginsDir = path.join(ROOT, 'plugins');
const fail = msg => { console.error('FAIL ' + msg); process.exit(1); };
const lastJson = out => JSON.parse(String(out).trim().split('\n').pop());

const found = lastJson(execFileSync(helper, ['--find', pluginsDir], { timeout: 60000 }));
const dexedFile = found.find(f => f.format === 'VST3' && /dexed/i.test(f.file));
if (!dexedFile) fail('Dexed not found: ' + JSON.stringify(found));
const scanned = lastJson(execFileSync(helper, ['--scan', 'VST3', dexedFile.file], { timeout: 60000 }));
const dexed = scanned.find(p => /dexed/i.test(p.name));
if (!dexed?.isInstrument) fail('scan: ' + JSON.stringify(scanned));
console.log(`found ${dexed.name} ${dexed.version} (${dexed.format}) by ${dexed.manufacturer}`);

const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let pending = Buffer.alloc(0);
proc.stdout.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const type = String.fromCharCode(pending[4]), body = pending.subarray(5, 4 + len);
    const key = type === 'J' ? 'J' + JSON.parse(body).req : 'A' + body.readUInt32LE(0);
    waiting.get(key)?.(type === 'J' ? JSON.parse(body) : body);
    pending = pending.subarray(4 + len);
  }
});
const write = (type, body) => {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(body.length + 1, 0);
  head[4] = type.charCodeAt(0);
  proc.stdin.write(Buffer.concat([head, body]));
};
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
let req = 0;
const call = (cmd, props = {}) => {
  const id = ++req;
  const p = new Promise(resolve => waiting.set('J' + id, resolve));
  write('J', Buffer.from(JSON.stringify({ cmd, req: id, ...props })));
  return timeout(p, 30000, cmd);
};
let seq = 0;
const render = (frames, events) => {
  const s = ++seq;
  const b = Buffer.alloc(36 + events.length * 8);
  b.writeUInt32LE(s, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(frames, 8);
  b.writeDoubleLE(120, 12); b.writeDoubleLE(0, 20); b[28] = 1; b.writeUInt32LE(events.length, 32);
  events.forEach(([offset, s0, d1, d2], i) => { b.writeUInt32LE(offset, 36 + i * 8); b[40 + i * 8] = s0; b[41 + i * 8] = d1; b[42 + i * 8] = d2; });
  const p = new Promise(resolve => waiting.set('A' + s, resolve));
  write('R', b);
  return timeout(p, 10000, 'render');
};

try {
  const loaded = await call('load', { inst: 1, xml: dexed.xml, rate: 48000, block: 512 });
  if (!loaded.ok) fail('load: ' + loaded.error);
  let peak = 0;
  for (let k = 0; k < 40; k++) {
    const audio = await render(1024, k === 0 ? [[0, 0x90, 60, 110]] : k === 30 ? [[0, 0x80, 60, 0]] : []);
    const frames = audio.readUInt32LE(8);
    for (let i = 0; i < frames * 2; i++) peak = Math.max(peak, Math.abs(audio.readFloatLE(16 + i * 4)));
  }
  if (!(peak > 0.01 && peak < 4)) fail('note level ' + peak);
  const state = await call('getState', { inst: 1 });
  if (!state.ok || !(state.state?.length > 10)) fail('state ' + JSON.stringify(state).slice(0, 200));
  // The plugin window opens, and asking for 200% makes it twice the size of 100%.
  const one = await call('show', { inst: 1, title: 'Dexed check', scale: 1 });
  const two = await call('show', { inst: 1, title: 'Dexed check', scale: 2 });
  if (!one.ok || !two.ok || !(one.width > 100)) fail('editor ' + JSON.stringify([one, two]));
  const ratio = two.width / one.width;
  if (Math.abs(ratio - 2) > 0.1) fail(`window scale: ${one.width}px at 100%, ${two.width}px at 200%`);
  console.log(`editor window ${one.width}×${one.height} at 100%, ${two.width}×${two.height} at 200%`);
  console.log(`ok: Dexed played a note (peak ${peak.toFixed(3)}), state ${state.state.length} bytes, editor: ${loaded.hasEditor}`);
} catch (err) {
  fail(err.message);
} finally {
  proc.stdin.end();
  setTimeout(() => proc.kill(), 2000).unref();
}
