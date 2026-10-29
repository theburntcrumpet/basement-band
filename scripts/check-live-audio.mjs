#!/usr/bin/env node
// Checks the native live-audio path on a virtual test interface (no real devices, no sound):
// monitoring latency through the guitar chain, recording timestamps, and the offline render.
//   node scripts/check-live-audio.mjs [path/to/bb-plugin-host]
import { connect, defaultHelper } from './lib/helper-client.mjs';

const fail = msg => { console.error('FAIL ' + msg); process.exit(1); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const h = connect(process.argv[2] || defaultHelper, { BB_TEST_AUDIO: '1' });

try {
  const list = await h.call('audio:devices');
  const types = list.types.map(t => `${t.type} (${t.outputs.length} out)`);
  console.log('audio systems: ' + types.join(', '));
  if (!list.types.some(t => t.type === 'Test')) fail('no test device');

  const opened = await h.call('audio:open', { type: 'Test', rate: 48000, buffer: 128 });
  if (!opened.ok) fail('open: ' + opened.error);
  console.log(`opened ${opened.type} at ${opened.rate} Hz, ${opened.buffer}-frame buffer`);

  // Monitor through a crunch amp: each input click should reach the output within a buffer or so.
  const track = { volume: -4, reverb: 0, echo: 0, amp: { model: 'crunch', gain: 0.5, gate: 0 } };
  await h.call('monitor:set', { on: true, input: 'left', track, bpm: 120, masterVolume: 0 });
  await wait(2600);
  const { latencies } = await h.call('test:stats');
  if (latencies.length < 2) fail('no clicks came through: ' + JSON.stringify(latencies));
  const worst = Math.max(...latencies);
  console.log(`monitoring: ${latencies.length} clicks, ${worst} frames (${(worst / 48).toFixed(2)} ms) inside the chain`);
  if (worst > 128) fail('chain latency too high: ' + latencies);

  // Recording: the click lands at frame (rate/10) of every second of the device clock.
  const chunks = [];
  h.on('I', b => chunks.push(b));
  await h.call('record:start');
  await wait(2200);
  await h.call('record:stop');
  await wait(200);
  if (!chunks.length) fail('nothing recorded');
  const first = Number(chunks[0].readBigInt64LE(0));
  const samples = chunks.flatMap(b => Array.from(new Float32Array(b.buffer.slice(b.byteOffset + 24, b.byteOffset + b.length))));
  const clicks = samples.map((v, i) => (v > 0.4 ? first + i : null)).filter(x => x != null);
  // Gap-free and sample-accurate: the test interface clicks exactly once a second.
  if (clicks.length < 2 || clicks.slice(1).some((f, i) => f - clicks[i] !== 48000)) fail('recorded clicks at frames ' + clicks.slice(0, 4));
  const clock = await h.call('audio:clock');
  console.log(`recording: ${samples.length} frames from device frame ${first}, clicks exactly 48000 frames apart; clock frame ${clock.frame}`);

  // Offline render of the same chain (what the app compares against its own playback).
  const n = 48000, input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin(2 * Math.PI * 110 * i / 48000) * 0.3 * Math.exp(-i / 24000);
  const r = await h.call('monitor:render', { track, bpm: 120, masterVolume: 0, rate: 48000, input: Buffer.from(input.buffer).toString('base64') });
  const out = new Float32Array(Buffer.from(r.output, 'base64').buffer.slice(0));
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (!(peak > 0.05 && peak < 1)) fail('render peak ' + peak);
  console.log(`offline render: peak ${peak.toFixed(3)}`);
  await h.call('audio:close');
  console.log('ok');
} catch (err) {
  fail(err.message);
} finally {
  h.close();
}
