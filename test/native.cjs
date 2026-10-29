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

  await check('native chain matches the app (octave bands)', `
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
    // The reverb is random noise in both engines, so the case with reverb gets a little more room.
    return worst <= 2 ? 'ok worst band difference ' + worst.toFixed(2) + ' dB: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  await check('monitoring and recording through the native engine (virtual interface)', `
    store.dirty = false;
    await app.newSong();
    app.settings.native = { type: 'Test', buffer: 128 };
    app.settings.nativeAudio = true;
    await app.configureNativeAudio();
    if (!app.engine.nativeSettings) return 'native engine not enabled';
    app.countIn = false;
    app.quickStart('guitar');
    const t = store.selectedTrack;
    // The virtual input's clicks last one sample: too short to open the noise gate.
    store.update(() => { t.amp = { ...t.amp, gate: 0 }; });
    await app.toggleMonitor(t);
    const info = app.engine.inputInfo();
    if (!info.native) return 'not monitoring natively: ' + JSON.stringify(info);
    await new Promise(r => setTimeout(r, 2300));
    const { bridge } = await import('./engine/plugins.js');
    const { latencies } = await bridge.call('test:stats');
    if (!latencies.length || Math.max(...latencies) > 128) return 'clicks through the chain: ' + JSON.stringify(latencies);
    // Amp changes reach the native chain while monitoring.
    store.update(() => { t.amp = { ...t.amp, model: 'metal', gate: 0 }; });
    await new Promise(r => setTimeout(r, 300));
    // Record two and a half seconds; the virtual input clicks once a second.
    app.seek(4);
    await app.toggleRecord();
    await new Promise(r => setTimeout(r, 2600));
    await app.stop();
    const take = t.regions.find(r => r.name === 'Recording');
    if (!take) return 'no take';
    const buf = app.engine.audioPool.get(take.audioId);
    const d = buf.getChannelData(0), clicks = [];
    for (let i = 0; i < d.length; i++) if (d[i] > 0.4) clicks.push(i);
    const spacing = clicks.slice(1).map((c, i) => c - clicks[i]);
    if (clicks.length < 2 || spacing.some(x => Math.abs(x - buf.sampleRate) > 1)) return 'clicks ' + clicks + ' rate ' + buf.sampleRate;
    if (!(take.start >= 4 && take.start < 4.5)) return 'take starts at beat ' + take.start;
    const stillMonitoring = app.monitorTrack === t.id;
    app.stopMonitoring();
    return 'ok monitoring ' + info.monitorLatencyMs + ' ms (chain ' + Math.max(...latencies) + ' frames), take ' + buf.duration.toFixed(2) + ' s at beat ' + take.start.toFixed(3) + ', clicks exactly 1 s apart' + (stillMonitoring ? ', still monitoring after recording' : '');`);

  await check('native song engine matches the app: sampled instruments and drum kits', `
    const { renderProject, resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const rate = Tone.getContext().sampleRate;
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
        let e = 0; for (let i = 0; i < r.length; i++) e += r[i] * r[i];
        out.push(10 * Math.log10(e / r.length + 1e-20));
      }
      return out;
    };
    const mono = (b, n) => { const m = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 }); const d = m.getChannelData(0), l = b.getChannelData(0), r = b.getChannelData(1); for (let i = 0; i < n; i++) d[i] = 0.5 * ((l[i] || 0) + (r[i] || 0)); return m; };
    const env = (b, n) => { const out = []; const l = b.getChannelData(0); for (let w = 0; w + 2400 <= n; w += 2400) { let p = 0; for (let i = w; i < w + 2400; i++) p = Math.max(p, Math.abs(l[i])); out.push(20 * Math.log10(p + 1e-9)); } return out; };
    const chord = (t, notes, d = 1.5, v = 0.8) => notes.map(n => ({ t, d, n, v }));
    const cases = [
      ['grand piano', 'grand-piano', [...chord(0, [48, 60, 64, 67]), ...chord(2, [53, 57, 60, 65], 0.5, 0.5), { t: 3, d: 0.25, n: 84, v: 1 }], {}],
      ['electric bass', 'electric-bass', [0, 0.5, 1, 1.5, 2, 3].map((t, i) => ({ t, d: 0.4, n: [36, 36, 43, 41, 38, 31][i], v: 0.6 + i * 0.05 })), { eqLow: 4 }],
      ['strings (slow attack), panned', 'strings', chord(0, [43, 55, 62, 71], 3), { pan: -0.5, reverb: 0.3 }],
      ['rock kit', 'kit-rock', [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((t, i) => [{ t, d: 0.25, n: 42, v: 0.5 + (i % 2) * 0.3 }, ...(i % 4 === 0 ? [{ t, d: 0.25, n: 36, v: 0.9 }] : []), ...(i % 4 === 2 ? [{ t, d: 0.25, n: 38, v: 0.85 }] : [])]).concat([{ t: 3.75, d: 0.25, n: 46, v: 0.7 }]), { echo: 0.3 }],
      ['strings dry', 'strings', chord(0, [43, 55, 62, 71], 3), {}],
      ['rock kit dry', 'kit-rock', [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((t, i) => [{ t, d: 0.25, n: 42, v: 0.5 + (i % 2) * 0.3 }, ...(i % 4 === 0 ? [{ t, d: 0.25, n: 36, v: 0.9 }] : [])]).concat([{ t: 3.75, d: 0.25, n: 46, v: 0.7 }]), {}],
      ['808 kit', 'kit-808', [0, 1, 2, 3].flatMap(t => [{ t, d: 0.25, n: 36, v: 1 }, { t: t + 0.5, d: 0.25, n: 39, v: 0.7 }]), { volume: -8 }],
    ];
    const report = [];
    let worst = 0, worstEnv = 0;
    for (const [name, inst, notes, settings] of cases) {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack(inst.startsWith('kit') ? 'drums' : 'instrument', inst, name), { reverb: 0, ...settings });
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes });
      p.tracks.push(t);
      const web = await renderProject(p, new Map(), { start: 0, end: 4, tail: 1.5, sampleRate: rate });
      const loaded = new Map([[t.id, await resolveInstrument(inst)]]);
      const song = songForNative(p, loaded);
      if (!song.tracks[0].instrument) return name + ': not supported natively';
      await new Promise(r => setTimeout(r, 300));   // let the uploads land
      const nat = await renderNative(song, { start: 0, end: 4, tail: 1.5, sampleRate: rate });
      const n = Math.min(web.length, nat.length);
      const a = await bandDb(mono(web, n)), b = await bandDb(mono(nat, n));
      const diffs = a.map((v, i) => (Math.max(v, b[i]) > -75 ? Math.abs(v - b[i]) : 0));
      const ea = env(web, n), eb = env(nat, n);
      const envDiff = Math.max(...ea.map((v, i) => (Math.max(v, eb[i]) > -50 ? Math.abs(v - eb[i]) : 0)));
      const max = Math.max(...diffs);
      // Reverb and echo tails differ slightly (random reverb noise; Chromium's delay smears each
      // repeat a little), so envelopes are held exact only for dry tracks.
      const wet = (settings.reverb || 0) > 0 || (settings.echo || 0) > 0;
      worst = Math.max(worst, max); if (!wet) worstEnv = Math.max(worstEnv, envDiff);
      const where = ea.map((v, i) => (Math.max(v, eb[i]) > -50 && Math.abs(v - eb[i]) > 1.5 ? (i * 0.05).toFixed(2) + 's ' + v.toFixed(1) + '/' + eb[i].toFixed(1) : null)).filter(Boolean).slice(0, 6).join(', ');
      report.push(name + ' ' + max.toFixed(2) + ' dB (envelope ' + envDiff.toFixed(1) + ' dB' + (where ? ' at ' + where : '') + ')' + (max > 1 ? ' [' + a.map((v, i) => v.toFixed(1) + '/' + b[i].toFixed(1)).join(' ') + ']' : ''));
    }
    return worst <= 1 && worstEnv <= 1.5 ? 'ok ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  await check('native song engine matches the app: synth presets and instrument effects', `
    const { renderProject, resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const { INSTRUMENTS } = await import('./engine/instruments.js');
    const rate = Tone.getContext().sampleRate;
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
        let e = 0; for (let i = 0; i < r.length; i++) e += r[i] * r[i];
        out.push(10 * Math.log10(e / r.length + 1e-20));
      }
      return out;
    };
    const mono = (b, n) => { const m = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 }); const d = m.getChannelData(0), l = b.getChannelData(0), r = b.getChannelData(1); for (let i = 0; i < n; i++) d[i] = 0.5 * ((l[i] || 0) + (r[i] || 0)); return m; };
    // Loudness (RMS) per 50 ms: robust to the waveform details of dense chords.
    const env = (b, n) => { const out = []; const l = b.getChannelData(0); for (let w = 0; w + 2400 <= n; w += 2400) { let e = 0; for (let i = w; i < w + 2400; i++) e += l[i] * l[i]; out.push(10 * Math.log10(e / 2400 + 1e-18)); } return out; };
    const ids = INSTRUMENTS.filter(i => i.type === 'synth' || (i.type === 'sampler' && i.fx) || i.id === 'kit-lofi' || i.id === 'kit-electro').map(i => i.id);
    const report = [];
    let worst = 0, worstEnv = 0;
    for (const id of ids) {
      const kit = id.startsWith('kit');
      const notes = kit ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap(t => [{ t, d: 0.25, n: t === 3.5 ? 46 : 42, v: 0.7 }, { t, d: 0.25, n: [36, 38, 36, 39, 45, 38, 48, 49][t * 2], v: 0.9 }])
        : [{ t: 0, d: 1.5, n: 48, v: 0.8 }, { t: 0, d: 1.5, n: 55, v: 0.7 }, { t: 0.5, d: 1, n: 64, v: 0.9 }, { t: 2, d: 0.5, n: 60, v: 0.6 }, { t: 2.5, d: 1.2, n: 72, v: 1 }];
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack(kit ? 'drums' : 'instrument', id, id), { reverb: 0, echo: 0 });
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes });
      p.tracks.push(t);
      const web = await renderProject(p, new Map(), { start: 0, end: 4, tail: 2.5, sampleRate: rate });
      const song = songForNative(p, new Map([[t.id, await resolveInstrument(id)]]));
      if (!song.tracks[0].instrument) { report.push(id + ' not supported'); worst = 99; continue; }
      await new Promise(r => setTimeout(r, 200));
      const nat = await renderNative(song, { start: 0, end: 4, tail: 2.5, sampleRate: rate });
      const n = Math.min(web.length, nat.length);
      const a = await bandDb(mono(web, n)), b = await bandDb(mono(nat, n));
      const max = Math.max(...a.map((v, i) => (Math.max(v, b[i]) > -60 ? Math.abs(v - b[i]) : 0)));
      const ea = env(web, n), eb = env(nat, n);
      const envDiff = Math.max(...ea.map((v, i) => (Math.max(v, eb[i]) > -45 ? Math.abs(v - eb[i]) : 0)));
      // Where an echo (FeedbackDelay) overlaps a new note, Chromium's result shifts with where the
      // notes fall in time, so those presets get more room on the envelope.
      const echoes = song.tracks[0].instrument.effects?.some(e => e.name === 'FeedbackDelay');
      // The Electro kit's cymbals are square waves frequency-modulated into noise; allow a little more.
      worst = Math.max(worst, max); worstEnv = Math.max(worstEnv, echoes ? envDiff / 2.5 : id === 'kit-electro' ? envDiff / 1.25 : envDiff);
      const where = ea.map((v, i) => (Math.max(v, eb[i]) > -45 && Math.abs(v - eb[i]) > 2 ? (i * 0.05).toFixed(2) + 's ' + v.toFixed(1) + '/' + eb[i].toFixed(1) : null)).filter(Boolean).slice(0, 5).join(', ');
      report.push(id + ' ' + max.toFixed(2) + '/' + envDiff.toFixed(1) + ' dB' + (where ? ' at ' + where : ''));
    }
    return worst <= 1.5 && worstEnv <= 2 ? 'ok (band/envelope) ' + report.join('; ') : 'differences (band/envelope): ' + report.join('; ');`);

  await check('native song engine matches the app: SoundFont instruments (FluidR3)', `
    const path = '/usr/share/soundfonts/FluidR3_GM.sf2';
    if (!(await window.host.allowInstrumentFile(path))) return 'ok skipped (no FluidR3 here)';
    await app.importInstrumentPaths([path]);
    const entry = app.settings.userInstruments.find(e => e.path === path);
    if (!entry) return 'import failed';
    const { instrumentId } = await import('./engine/user-instruments.js');
    const { renderProject, resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const rate = Tone.getContext().sampleRate;
    const rmsEnv = (b, n) => { const out = []; const l = b.getChannelData(0), r = b.getChannelData(1); for (let w = 0; w + 2400 <= n; w += 2400) { let e = 0; for (let i = w; i < w + 2400; i++) { const m = 0.5 * (l[i] + r[i]); e += m * m; } out.push(10 * Math.log10(e / 2400 + 1e-18)); } return out; };
    const cases = [
      ['piano', { bank: 0, program: 0 }, [{ t: 0, d: 1, n: 60, v: 0.8 }, { t: 0, d: 1, n: 64, v: 0.6 }, { t: 1.5, d: 2, n: 43, v: 1 }]],
      ['strings (loop)', { bank: 0, program: 48 }, [{ t: 0, d: 3.5, n: 55, v: 0.9 }, { t: 0, d: 3.5, n: 62, v: 0.7 }]],
      ['synth lead', { bank: 0, program: 81 }, [{ t: 0, d: 1, n: 69, v: 0.9 }, { t: 1, d: 1, n: 72, v: 0.5 }, { t: 2, d: 1.5, n: 76, v: 1 }]],
      ['drums', { bank: 128, program: 0 }, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((t, i) => [{ t, d: 0.25, n: 42, v: 0.7 }, { t, d: 0.25, n: i % 2 ? 38 : 36, v: 0.9 }])],
    ];
    const report = [];
    let worst = 0;
    for (const [name, preset, notes] of cases) {
      const id = instrumentId(entry, preset);
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack(preset.bank === 128 ? 'drums' : 'instrument', id, name), { reverb: 0, echo: 0 });
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes });
      p.tracks.push(t);
      const web = await renderProject(p, new Map(), { start: 0, end: 4, tail: 1.5, sampleRate: rate });
      const song = songForNative(p, new Map([[t.id, await resolveInstrument(id)]]));
      if (!song.tracks[0].instrument?.regions?.length) return name + ': no regions';
      await new Promise(r => setTimeout(r, 500));
      const nat = await renderNative(song, { start: 0, end: 4, tail: 1.5, sampleRate: rate });
      const n = Math.min(web.length, nat.length);
      const a = rmsEnv(web, n), b = rmsEnv(nat, n);
      const diffs = a.map((v, i) => (Math.max(v, b[i]) > -50 ? Math.abs(v - b[i]) : 0));
      const max = Math.max(...diffs);
      worst = Math.max(worst, max);
      const where = diffs.map((d, i) => (d > 1 ? (i * 0.05).toFixed(2) + 's ' + a[i].toFixed(1) + '/' + b[i].toFixed(1) : null)).filter(Boolean).slice(0, 4).join(', ');
      report.push(name + ' ' + max.toFixed(1) + ' dB' + (where ? ' at ' + where : ''));
    }
    return worst <= 1.5 ? 'ok loudness per 50 ms: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  await check('native song engine plays plugins in-process (Dexed)', `
    store.dirty = false;
    await app.newSong();
    await app.rescanPlugins();
    const { pluginList } = await import('./engine/plugins.js');
    const dexed = pluginList().find(d => /dexed/i.test(d.name));
    if (!dexed) return 'ok skipped (Dexed not bundled here)';
    const t = app.addTrack('instrument', dexed.id, 'FM');
    store.update(() => { t.regions.push({ id: 'p', start: 0, length: 4, loopLength: 4, notes: [0, 1, 2, 3].map(b => ({ t: b, d: 0.5, n: 60 + b * 3, v: 0.9 })) }); t.reverb = 0; t.echo = 0; });
    await app.engine.whenLoaded();
    const inst = app.engine.nodes.get(t.id).instrument;
    if (!inst?.selfScheduled) return 'Dexed not loaded';
    const { renderProject } = await import('./engine/engine.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const rate = Tone.getContext().sampleRate;
    // The app's path: a fresh copy of the plugin rendered offline, mixed in.
    const pluginAudio = await app.engine.renderPlugins(store.project, { start: 0, end: 4, sampleRate: rate });
    const web = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 4, tail: 1, sampleRate: rate, pluginAudio });
    // Native: the loaded instance, driven by the song engine.
    inst.setStreaming(false);
    await new Promise(r => setTimeout(r, 200));
    const song = songForNative(store.project, new Map([[t.id, { id: t.instrument, plugin: inst }]]));
    const nat = await renderNative(song, { start: 0, end: 4, tail: 1, sampleRate: rate });
    inst.setStreaming(true);
    const env = b => { const out = []; const l = b.getChannelData(0); for (let w = 0; w + 2400 <= Math.min(web.length, nat.length); w += 2400) { let e = 0; for (let i = w; i < w + 2400; i++) e += l[i] * l[i]; out.push(10 * Math.log10(e / 2400 + 1e-18)); } return out; };
    const a = env(web), b = env(nat);
    const max = Math.max(...a.map((v, i) => (Math.max(v, b[i]) > -50 ? Math.abs(v - b[i]) : 0)));
    const peak = Math.max(...b);
    return max <= 1.5 && peak > -40 ? 'ok Dexed through the native song engine matches within ' + max.toFixed(1) + ' dB (peak ' + peak.toFixed(1) + ' dB)' : 'difference ' + max.toFixed(1) + ' dB, native peak ' + peak.toFixed(1);`);

  await check('native song engine matches the app: audio clips', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const { defaultAmp } = await import('./engine/amp.js');
    const rate = Tone.getContext().sampleRate;
    // A plucked DI note every half second (1.5 s of audio).
    const n = Math.round(rate * 1.5), di = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
    const d = di.getChannelData(0);
    for (let i = 0; i < n; i++) { const t = (i / rate) % 0.5; let v = 0; for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * 110 * k * i / rate) / k; d[i] = 0.3 * v * Math.exp(-t * 6); }
    const loudness = (b, len) => { const out = []; const l = b.getChannelData(0), r = b.getChannelData(1); for (let w = 0; w + 2400 <= len; w += 2400) { let e = 0; for (let i = w; i < w + 2400; i++) { const m = 0.5 * (l[i] + r[i]); e += m * m; } out.push(10 * Math.log10(e / 2400 + 1e-18)); } return out; };
    const cases = [
      ['DI through a crunch amp', { amp: { ...defaultAmp('crunch'), gate: 0 } }, { start: 0, length: 4 }, {}, 0],
      ['looped and extended with silence', {}, { start: 1, length: 6, loopLength: 4 }, {}, 0],
      ['following a tempo change (stretched)', {}, { start: 0, length: 4, bpm: 90 }, {}, 0],
      ['starting playback partway into a clip', { reverb: 0.2 }, { start: 0, length: 4 }, {}, 1.3],
    ];
    const report = [];
    let worst = 0;
    for (const [name, trackSettings, region, , from] of cases) {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack('audio', null, 'Gtr'), { reverb: 0, echo: 0, ...trackSettings });
      t.regions.push({ id: 'r', offset: 0, audioId: 'di', ...region });
      p.tracks.push(t);
      app.engine.audioPool.set('di', di);
      app.engine.project = p;
      await app.engine.prepareAudio(p);
      const web = await renderProject(p, app.engine.audioPool, { start: from, end: 8, tail: 0.5, sampleRate: rate, bufferFor: app.engine.bufferFor });
      const song = songForNative(p, new Map(), { bufferFor: app.engine.bufferFor });
      if (!song.tracks[0]?.clips?.length) return name + ': no clips';
      await new Promise(r => setTimeout(r, 300));
      const nat = await renderNative(song, { start: from, end: 8, tail: 0.5, sampleRate: rate });
      const len = Math.min(web.length, nat.length);
      const a = loudness(web, len), b = loudness(nat, len);
      // Windows 25 dB or more below the notes (e.g. the amp's ringing after a clip ends) don't count.
      const diffs = a.map((v, i) => (Math.max(v, b[i]) > -40 ? Math.abs(v - b[i]) : 0));
      const max = Math.max(...diffs);
      const wet = (trackSettings.reverb || 0) > 0;
      worst = Math.max(worst, wet ? max / 3 : max);
      const where = diffs.map((x, i) => (x > 1 ? (i * 0.05).toFixed(2) + 's ' + a[i].toFixed(1) + '/' + b[i].toFixed(1) : null)).filter(Boolean).slice(0, 4).join(', ');
      report.push(name + ' ' + max.toFixed(1) + ' dB' + (where ? ' at ' + where : ''));
    }
    app.engine.project = store.project;
    return worst <= 1.5 ? 'ok loudness per 50 ms: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  await check('native song engine matches the app: track and master effects', `
    const { renderProject, resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const { defaultFx } = await import('./engine/effects.js');
    const rate = Tone.getContext().sampleRate;
    const bands = [125, 500, 2000, 8000];
    const bandDb = async (b, len) => {
      const m = new AudioBuffer({ length: len, sampleRate: rate, numberOfChannels: 1 });
      const d = m.getChannelData(0), l = b.getChannelData(0), r = b.getChannelData(1);
      for (let i = 0; i < len; i++) d[i] = 0.5 * (l[i] + r[i]);
      const out = [];
      for (const f of bands) {
        const ctx = new OfflineAudioContext(1, len, rate);
        const src = ctx.createBufferSource(); src.buffer = m;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.4;
        src.connect(bp).connect(ctx.destination); src.start();
        const x = (await ctx.startRendering()).getChannelData(0);
        let e = 0; for (let i = 0; i < len; i++) e += x[i] * x[i];
        out.push(10 * Math.log10(e / len + 1e-20));
      }
      return out;
    };
    const notes = [{ t: 0, d: 1, n: 48, v: 0.8 }, { t: 0, d: 1, n: 60, v: 0.7 }, { t: 1, d: 1, n: 64, v: 0.8 }, { t: 2, d: 2, n: 67, v: 0.9 }];
    const cases = [['vinyl', { fx: defaultFx('vinyl') }, null], ['tape', { fx: defaultFx('tape') }, null], ['radio', { fx: defaultFx('radio') }, null],
      ['lo-fi', { fx: defaultFx('lofi') }, null], ['master vinyl', {}, defaultFx('vinyl')]];
    const report = [];
    let worst = 0;
    for (const [name, trackFx, masterFx] of cases) {
      const p = newProject(); p.bpm = 120;
      if (masterFx) p.masterFx = masterFx;
      const t = Object.assign(newTrack('instrument', 'grand-piano', 'P'), { reverb: 0, echo: 0, ...trackFx });
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes });
      p.tracks.push(t);
      const web = await renderProject(p, new Map(), { start: 0, end: 4, tail: 1, sampleRate: rate });
      const song = songForNative(p, new Map([[t.id, await resolveInstrument('grand-piano')]]));
      await new Promise(r => setTimeout(r, 200));
      const nat = await renderNative(song, { start: 0, end: 4, tail: 1, sampleRate: rate });
      const len = Math.min(web.length, nat.length);
      const a = await bandDb(web, len), b = await bandDb(nat, len);
      const max = Math.max(...a.map((v, i) => (Math.max(v, b[i]) > -65 ? Math.abs(v - b[i]) : 0)));
      worst = Math.max(worst, max);
      report.push(name + ' ' + max.toFixed(2) + ' dB' + (max > 1 ? ' [' + a.map((v, i) => v.toFixed(1) + '/' + b[i].toFixed(1)).join(' ') + ']' : ''));
    }
    return worst <= 1 ? 'ok per band: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  await check('native song engine matches the app: automation', `
    const { renderProject, resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const rate = Tone.getContext().sampleRate;
    const loudness = (b, len, ch) => { const out = []; const x = b.getChannelData(ch); for (let w = 0; w + 2400 <= len; w += 2400) { let e = 0; for (let i = w; i < w + 2400; i++) e += x[i] * x[i]; out.push(10 * Math.log10(e / 2400 + 1e-18)); } return out; };
    const notes = [{ t: 0, d: 8, n: 48, v: 0.8 }, { t: 0, d: 8, n: 55, v: 0.7 }, { t: 0, d: 8, n: 64, v: 0.7 }];
    const cases = [
      ['volume ramp', { volume: [{ t: 0, v: -30 }, { t: 4, v: 0 }, { t: 6, v: -10 }] }, 0],
      ['pan sweep', { pan: [{ t: 0, v: -1 }, { t: 8, v: 1 }] }, 0],
      ['tone and EQ', { tone: [{ t: 0, v: 0.2 }, { t: 8, v: 1 }], eqHigh: [{ t: 2, v: -12 }, { t: 6, v: 12 }] }, 0],
      ['reverb send', { reverb: [{ t: 0, v: 0 }, { t: 4, v: 1 }] }, 0],
      ['starting mid-ramp', { volume: [{ t: 0, v: -30 }, { t: 8, v: 0 }] }, 3],
    ];
    const report = [];
    let worst = 0;
    for (const [name, automation, from] of cases) {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack('instrument', 'warm-pad', 'Pad'), { reverb: 0, echo: 0, automation });
      t.regions.push({ id: 'r', start: 0, length: 8, loopLength: 8, notes });
      p.tracks.push(t);
      const web = await renderProject(p, new Map(), { start: from, end: 8, tail: 0.5, sampleRate: rate });
      const song = songForNative(p, new Map([[t.id, await resolveInstrument('warm-pad')]]));
      const nat = await renderNative(song, { start: from, end: 8, tail: 0.5, sampleRate: rate });
      const len = Math.min(web.length, nat.length);
      let max = 0;
      for (const ch of [0, 1]) {
        const a = loudness(web, len, ch), b = loudness(nat, len, ch);
        max = Math.max(max, ...a.map((v, i) => (Math.max(v, b[i]) > -50 ? Math.abs(v - b[i]) : 0)));
      }
      // With the send open the (random) reverb tail dominates individual windows, so the reverb case
      // compares the overall level instead.
      if (automation.reverb) {
        const total = b => { let e = 0; for (const ch of [0, 1]) { const x = b.getChannelData(ch); for (let i = 0; i < len; i++) e += x[i] * x[i]; } return 10 * Math.log10(e / len); };
        max = Math.abs(total(web) - total(nat));
      }
      worst = Math.max(worst, max);
      report.push(name + ' ' + max.toFixed(1) + ' dB');
    }
    return worst <= 1.5 ? 'ok loudness per 50 ms, each side: ' + report.join('; ') : 'differences: ' + report.join('; ');`);

  for (const r of results) console.log(r);
  app.quit();
};
