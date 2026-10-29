// Checks the native engine against the app's Web Audio engine (run with the real helper:
// npm run test:native). The same DI guitar goes through both with the same track settings; their
// levels in each octave band must agree, so what you hear while monitoring is what plays back.
const fs = require('node:fs');

module.exports = async function native(win, app) {
  const js = code => win.webContents.executeJavaScript(`(async () => { ${code} })().catch(e => 'ERROR ' + e.stack)`);
  const results = [];
  const check = async (name, code) => {
    const r = await js(code);
    results.push(`${typeof r === 'string' && r.startsWith('ok') ? 'PASS' : 'FAIL'} ${name}: ${r}`);
  };
  await new Promise(r => setTimeout(r, 1500));
  // A dark cabinet IR, as in flows.cjs.
  const irDir = '/tmp/basement-band-test-ir';
  fs.mkdirSync(irDir, { recursive: true });
  {
    const sr = 48000, n = 4096, a = Math.exp(-2 * Math.PI * 700 / sr);
    const pcm = Buffer.alloc(n * 2);
    let y = 0;
    for (let i = 0; i < n; i++) { y = (1 - a) * (i === 0 ? 1 : 0) + a * y; pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y * 20)) * 32767), i * 2); }
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
    head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(sr, 24);
    head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(irDir + '/dark-cab.wav', Buffer.concat([head, pcm]));
  }

  await check('native chain matches the app (octave bands within 1.5 dB)', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { defaultAmp } = await import('./engine/amp.js');
    const { bridge } = await import('./engine/plugins.js');
    const rate = 48000, n = rate * 2;
    const di = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
    const d = di.getChannelData(0);
    for (let i = 0; i < n; i++) { const t = i / rate; let v = 0; for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * 82.4 * k * t + k) * 0.35 / k; d[i] = v * Math.exp(-t * 1.5) * (t < 1 ? 1 : 0.6); }
    const b64 = arr => { let s = ''; const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
    const bands = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
    const bandDb = async buf => {
      const out = [];
      for (const f of bands) {
        const ctx = new OfflineAudioContext(1, buf.length, rate);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const bp1 = ctx.createBiquadFilter(), bp2 = ctx.createBiquadFilter();
        for (const bp of [bp1, bp2]) { bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.4; }
        src.connect(bp1).connect(bp2).connect(ctx.destination); src.start();
        const r = (await ctx.startRendering()).getChannelData(0);
        let e = 0; for (let i = 2400; i < r.length; i++) e += r[i] * r[i];
        out.push(10 * Math.log10(e / (r.length - 2400) + 1e-20));
      }
      return out;
    };
    const cases = [
      ['clean', { amp: defaultAmp('clean') }],
      ['crunch, 4x12, EQ', { amp: { ...defaultAmp('crunch'), cab: 'closed412' }, eqLow: 6, eqHigh: -4 }],
      ['metal', { amp: { ...defaultAmp('metal'), gate: 0 } }],
      ['bass, tone, drive', { amp: defaultAmp('bass'), tone: 0.55, drive: 0.4 }],
      ['no amp, reverb + echo', { reverb: 0.5, echo: 0.35 }],
      ['crunch through an IR', { amp: { ...defaultAmp('crunch'), cab: 'ir', ir: { path: '/tmp/basement-band-test-ir/dark-cab.wav', name: 'dark' } } }],
    ];
    await app.engine.loadIR('/tmp/basement-band-test-ir/dark-cab.wav');
    const report = [];
    let worst = 0;
    for (const [name, settings] of cases) {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack('audio', null, 'G'), { reverb: 0, echo: 0, ...settings });
      t.regions.push({ id: 'r', start: 0, length: 4, offset: 0, audioId: 'di' });
      p.tracks.push(t);
      const web = await renderProject(p, new Map([['di', di]]), { start: 0, end: 4, tail: 0, sampleRate: rate });
      const res = await bridge.call('monitor:render', { track: t, bpm: 120, masterVolume: p.masterVolume ?? 0, rate, input: b64(d) });
      const raw = unb64(res.output);
      const nat = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
      nat.copyToChannel(raw.subarray(0, n), 0);
      const webMono = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
      webMono.copyToChannel(web.getChannelData(0).subarray(0, n), 0);
      const a = await bandDb(webMono), b = await bandDb(nat);
      // Only bands with real energy count.
      const diffs = a.map((v, i) => (Math.max(v, b[i]) > -70 ? Math.abs(v - b[i]) : 0));
      const max = Math.max(...diffs);
      worst = Math.max(worst, max);
      report.push(name + ' ' + max.toFixed(2) + ' dB' + (max > 1.5 ? ' [' + a.map((v, i) => v.toFixed(1) + '/' + b[i].toFixed(1)).join(' ') + ']' : ''));
    }
    return worst <= 1.5 ? 'ok worst band difference ' + worst.toFixed(2) + ' dB: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  for (const r of results) console.log(r);
  app.quit();
};
