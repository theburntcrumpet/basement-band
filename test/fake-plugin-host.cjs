#!/usr/bin/env node
// A stand-in for native/plugin-host that speaks the same protocol, so the smoke tests can exercise
// plugin scanning, streaming, export and saved settings without a native build. Its one "plugin" is
// a sine synth: each held note plays a sine at gain × velocity; "show" turns the gain down to 0.5
// (as if the user changed a setting in the plugin window).
const args = process.argv.slice(2);
const FILE = '/fake/Test Synth.vst3';
const DESC = { name: 'Test Synth', manufacturer: 'Basement Band Tests', category: 'Synth', format: 'VST3', file: FILE, id: 'VST3-Test Synth-1234', isInstrument: true, version: '1.0', xml: '<PLUGIN name="Test Synth"/>' };

if (args[0] === '--find') { process.stdout.write(JSON.stringify([{ format: 'VST3', file: FILE }]) + '\n'); process.exit(0); }
if (args[0] === '--scan') { process.stdout.write(JSON.stringify(args[2] === FILE ? [DESC] : []) + '\n'); process.exit(0); }

const instances = new Map();
const frame = (type, body) => {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(body.length + 1, 0);
  head[4] = type.charCodeAt(0);
  process.stdout.write(Buffer.concat([head, body]));
};
const json = o => frame('J', Buffer.from(JSON.stringify(o)));

function render(p) {
  const seq = p.readUInt32LE(0), inst = p.readUInt32LE(4), frames = p.readUInt32LE(8), count = p.readUInt32LE(32);
  const out = Buffer.alloc(16 + frames * 8);
  out.writeUInt32LE(seq, 0); out.writeUInt32LE(inst, 4); out.writeUInt32LE(frames, 8); out.writeUInt32LE(2, 12);
  const s = instances.get(inst);
  if (s) {
    let e = 0;
    for (let i = 0; i < frames; i++) {
      for (; e < count && p.readUInt32LE(36 + e * 8) <= i; e++) {
        const o = 36 + e * 8 + 4, st = p[o] & 0xf0, d1 = p[o + 1], d2 = p[o + 2];
        if (st === 0x90 && d2 > 0) s.notes.set(d1, { v: d2 / 127, ph: 0 });
        else if (st === 0x80 || st === 0x90) s.notes.delete(d1);
        else if (st === 0xb0 && d1 === 123) s.notes.clear();
      }
      let v = 0;
      for (const [n, note] of s.notes) {
        v += Math.sin(note.ph) * note.v * s.state.gain;
        note.ph += 2 * Math.PI * 440 * 2 ** ((n - 69) / 12) / s.rate;
      }
      out.writeFloatLE(v * 0.3, 16 + i * 4);
      out.writeFloatLE(v * 0.3, 16 + (frames + i) * 4);
    }
  }
  frame('A', out);
}

function command(m) {
  const reply = (extra = {}) => m.req != null && json({ req: m.req, ok: true, ...extra });
  if (m.cmd === 'load') {
    let state = { gain: 1 };
    try { if (m.state) state = JSON.parse(Buffer.from(m.state, 'base64').toString()); } catch { /* default */ }
    instances.set(m.inst, { rate: m.rate, notes: new Map(), state });
    return reply({ latency: 0, hasEditor: true, outputs: 2 });
  }
  const s = instances.get(m.inst);
  if (m.cmd === 'unload') return instances.delete(m.inst);
  if (m.cmd === 'show') { if (s) s.state.gain = 0.5; return reply(); }
  if (m.cmd === 'getState') return reply({ state: Buffer.from(JSON.stringify(s?.state || {})).toString('base64') });
  if (m.cmd === 'crash') process.exit(3);
  return reply();
}

let pending = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const type = String.fromCharCode(pending[4]), body = pending.subarray(5, 4 + len);
    if (type === 'R') render(body);
    else if (type === 'J') command(JSON.parse(body.toString()));
    pending = pending.subarray(4 + len);
  }
});
process.stdin.on('end', () => process.exit(0));
