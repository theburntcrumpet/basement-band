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

  await check('a clip trimmed from the start plays the same audio at the same time, on both engines', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack, trimClipStart } = await import('./state.js');
    const { songForNative, renderNative } = await import('./engine/native-engine.js');
    const rate = Tone.getContext().sampleRate;
    // A recording whose level changes all the time, so a shift would show up.
    const rec = new AudioBuffer({ length: rate * 5, sampleRate: rate, numberOfChannels: 1 });
    const d = rec.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const t = i / rate; d[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * t)); }
    app.engine.audioPool.set('trimrec', rec);
    const project = region => {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack('audio', null, 'Clip'), { reverb: 0, echo: 0 });
      t.regions.push({ id: 'r', offset: 0, audioId: 'trimrec', ...region });
      p.tracks.push(t);
      return p;
    };
    const render = async (p, native) => {
      app.engine.project = p;
      await app.engine.prepareAudio(p);
      if (!native) return renderProject(p, app.engine.audioPool, { start: 0, end: 8, tail: 0, sampleRate: rate, bufferFor: app.engine.bufferFor });
      await new Promise(r => setTimeout(r, 200));
      return renderNative(songForNative(p, new Map(), { bufferFor: app.engine.bufferFor }), { start: 0, end: 8, tail: 0, sampleRate: rate });
    };
    const rms = (b, from, to) => {
      const x = b.getChannelData(0); let e = 0, n = 0;
      for (let i = Math.round(from * rate); i < Math.min(x.length, Math.round(to * rate)); i++) { e += x[i] * x[i]; n++; }
      return Math.sqrt(e / Math.max(1, n));
    };
    const report = [];
    const fails = [];
    for (const [name, region] of [['plain', { start: 1, length: 6, loopLength: 6 }], ['looped', { start: 1, length: 6, loopLength: 2 }]]) {
      for (const native of [false, true]) {
        const whole = await render(project(region), native);
        const p = project(region);
        const clip = p.tracks[0].regions[0];
        trimClipStart(clip, 3, p, { ...clip });
        const trimmed = await render(p, native);
        const engine = native ? 'native' : 'web';
        // Silence where it was cut off (beats 1 to 3, 0.5 s to 1.5 s).
        const cut = rms(trimmed, 0.55, 1.45);
        if (cut > 1e-3) fails.push(name + ' ' + engine + ' still plays what was trimmed: ' + cut);
        // Sample-for-sample after the cut (past the clip's short fade-in).
        const a = whole.getChannelData(0), b = trimmed.getChannelData(0);
        let worst = 0, level = 0;
        for (let i = Math.round(1.55 * rate); i < Math.round(3.4 * rate); i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); level = Math.max(level, Math.abs(a[i])); }
        if (level < 0.02 || worst > level * 0.02) fails.push(name + ' ' + engine + ' moved: difference ' + worst.toFixed(4) + ' of ' + level.toFixed(3));
        report.push(name + ' ' + engine + ' ' + worst.toFixed(5));
      }
    }
    app.engine.project = store.project;
    return fails.length ? fails.join('; ') : 'ok worst difference: ' + report.join(', ');`);

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

  await check('native rendering stays within its real-time budget at every chord change', `
    const { resolveInstrument } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { songForNative } = await import('./engine/native-engine.js');
    const { bridge } = await import('./engine/plugins.js');
    const p = newProject(); p.bpm = 120;
    const loaded = new Map();
    // Chords on the synths that build wavetables, changing every bar, plus cymbals every eighth.
    for (const [i, id] of ['glass-pad', 'vibes', 'saw-lead', 'electric-piano', 'warm-pad'].entries()) {
      const t = newTrack('instrument', id, id);
      t.regions.push({ id: 'r' + i, start: 0, length: 16, loopLength: 16, notes: [0, 4, 8, 12].flatMap((b, k) => [48, 52, 55, 59].map(n => ({ t: b, d: 4, n: n + k * 2 + i, v: 0.8 }))) });
      p.tracks.push(t);
      loaded.set(t.id, await resolveInstrument(id));
    }
    const kit = newTrack('drums', 'kit-electro', 'kit');
    kit.regions.push({ id: 'k', start: 0, length: 16, loopLength: 16, notes: Array.from({ length: 32 }, (_, k) => ({ t: k / 2, d: 0.25, n: k % 4 === 3 ? 46 : 42, v: 0.8 })) });
    p.tracks.push(kit);
    loaded.set(kit.id, await resolveInstrument('kit-electro'));
    const song = songForNative(p, loaded);
    const res = await bridge.call('song:render', { song, start: 0, end: 16, tail: 0, rate: 48000, block: 128, profile: true }, 120000);
    const budget = 128 / 48, worst = Math.max(...res.blockTimes), at = res.blockTimes.indexOf(worst) * 128 / 48000;
    return worst < budget / 2 ? 'ok slowest 128-sample block ' + worst.toFixed(2) + ' ms of a ' + budget.toFixed(2) + ' ms budget' : 'block at ' + at.toFixed(2) + ' s took ' + worst.toFixed(2) + ' ms (budget ' + budget.toFixed(2) + ' ms)';`);

  await check('the app plays songs through the native engine (virtual interface)', `
    app.settings.native = { type: 'Test', buffer: 128 };
    app.settings.nativeAudio = true;
    app.settings.nativePlayback = true;
    await app.configureNativeAudio();
    if (!app.engine.nativePlayback) return 'native playback not on';
    store.dirty = false;
    await app.newSong();
    app.countIn = false;
    store.update(p => { p.bpm = 120; });
    const drums = app.addTrack('drums', 'kit-rock', 'Drums');
    const keys = app.addTrack('instrument', 'grand-piano', 'Keys');
    store.update(() => {
      drums.regions.push({ id: 'd', start: 0, length: 4, loopLength: 4, notes: [0, 1, 2, 3].map(t => ({ t, d: 0.25, n: 36, v: 1 })) });
      // (The piano plays after the kicks, so it can't blur where each kick starts.)
      keys.regions.push({ id: 'k', start: 4, length: 4, loopLength: 4, notes: [{ t: 0, d: 2, n: 60, v: 0.5 }] });
      drums.reverb = 0; keys.reverb = 0;
    });
    await app.engine.whenLoaded();
    await new Promise(r => setTimeout(r, 300));
    const { bridge } = await import('./engine/plugins.js');
    const decode = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
    // Play: kicks every half second must come out exactly 24000 frames apart.
    app.seek(0);
    await app.togglePlay();
    let meter = -Infinity, positions = [];
    for (let i = 0; i < 22; i++) { await new Promise(r => setTimeout(r, 100)); meter = Math.max(meter, app.engine.meterDb(drums.id)); positions.push(app.engine.position()); }
    const cap = await bridge.call('test:capture', { frames: 96000 });
    await app.stop();
    const x = decode(cap.audio), onsets = [];
    let quiet = 9999;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > 0.05 && quiet > 4800) onsets.push(i); quiet = a > 0.05 ? 0 : quiet + 1; }
    // Kicks one beat apart (the capture also catches the piano coming in at beat 4, and maybe the
    // tail of a kick at its start).
    const gaps = onsets.slice(1).map((o, i) => o - onsets[i]).filter(g => Math.abs(g - 24000) < 600);
    if (gaps.length < 2 || gaps.some(g => Math.abs(g - 24000) > 2)) return 'kick onsets ' + onsets + ' gaps ' + gaps;
    if (!(meter > -40)) return 'track meter ' + meter;
    const rising = positions.every((p, i) => i === 0 || p >= positions[i - 1] - 0.01);
    if (!rising || !(positions[positions.length - 1] > 3)) return 'positions ' + positions.map(p => p.toFixed(2));
    // A live note: from sending it to hearing it.
    await new Promise(r => setTimeout(r, 400));
    const before = await bridge.call('audio:clock');
    app.engine.noteOn(keys.id, 72, 1);
    await new Promise(r => setTimeout(r, 300));
    app.engine.noteOff(keys.id, 72);
    const cap2 = await bridge.call('test:capture', { frames: 24000 });
    const y = decode(cap2.audio);
    const firstLoud = y.findIndex(v => Math.abs(v) > 0.01);
    const offset = cap2.deviceEnd - cap2.frame;            // device clock vs ours
    const onsetOurs = cap2.deviceEnd - y.length + firstLoud - offset;
    const sentAt = before.frame + (before.now - before.frameTime) * 48000;
    const latencyMs = (onsetOurs - sentAt) / 48;
    if (firstLoud < 0 || !(latencyMs >= 0 && latencyMs < 15)) return 'live note latency ' + latencyMs + ' ms (onset ' + firstLoud + ')';
    // Export through the native engine matches the app's own mix.
    const { renderProject } = await import('./engine/engine.js');
    const web = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 8, tail: 1, sampleRate: 48000 });
    const nat = await app.engine.renderNativeExport(store.project, { start: 0, end: 8, tail: 1, sampleRate: 48000 });
    const rms = b => { let e = 0; const d = b.getChannelData(0); for (let i = 0; i < Math.min(web.length, nat.length); i++) e += d[i] * d[i]; return 10 * Math.log10(e / web.length); };
    const diff = Math.abs(rms(web) - rms(nat));
    if (diff > 0.5) return 'export level differs by ' + diff.toFixed(2) + ' dB';
    return 'ok kicks exactly 24000 frames apart, meters and playhead follow, live note in ' + latencyMs.toFixed(1) + ' ms (128-sample buffer), export matches within ' + diff.toFixed(2) + ' dB';`);

  await check('native playback stops at the end of the song and returns to the start', `
    if (!app.engine.nativePlayback) return 'native playback not on';
    if (app.engine.playing) await app.stop();
    const end = Math.max(...store.project.tracks.flatMap(t => t.regions.map(r => r.start + r.length)));
    app.seek(end - 1);
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 200));
    const midway = app.engine.playing;
    await new Promise(r => setTimeout(r, 1200));
    return midway && !app.engine.playing && store.ui.playhead === 0 ? 'ok' : JSON.stringify({ midway, playing: app.engine.playing, at: store.ui.playhead, end });`);

  await check('the tuner hears the native input, and recording still works afterwards', `
    if (!app.engine.nativePlayback) return 'native playback not on';
    await app.tuner.start();
    if (!app.engine.tuner) return 'not listening';
    // The virtual interface's input is a click once a second, which is enough to prove audio arrives.
    let peak = 0, rate = 0;
    for (let i = 0; i < 30 && peak < 0.3; i++) {
      await new Promise(r => setTimeout(r, 50));
      const input = app.engine.tunerInput();
      rate = input.rate;
      peak = Math.max(peak, input.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    }
    if (peak < 0.3) return 'no input reached the tuner (peak ' + peak + ')';
    const t = app.addTrack('audio', null, 'After tuner');
    store.ui.selectedTrack = t.id;
    app.countIn = false;
    app.seek(0);
    await app.toggleRecord();
    const closed = !app.tuner.on && !app.engine.tuner;
    await new Promise(r => setTimeout(r, 1500));
    await app.stop();
    const take = t.regions[0];
    // A helper crash mustn't leave the tuner deaf.
    await app.tuner.start();
    window.host.plugins.send({ cmd: 'test:crash' });
    await new Promise(r => setTimeout(r, 3500));
    const tapped = !!app.engine.native.tap;
    await app.tuner.stop();
    if (!tapped) return 'the tuner stopped listening after a helper crash';
    await new Promise(r => setTimeout(r, 300));
    return closed && take && rate > 0 ? 'ok peak ' + peak.toFixed(2) + ' at ' + rate + ' Hz, then a take of ' + take.length.toFixed(2) + ' beats' : JSON.stringify({ closed, take: !!take });`);

  await check('the native engine recovers from a helper crash', `
    if (!app.engine.nativePlayback) return 'native playback not on';
    const { bridge } = await import('./engine/plugins.js');
    window.host.plugins.send({ cmd: 'test:crash' });
    await new Promise(r => setTimeout(r, 2500));
    if (!app.engine.native.device) return 'device not reopened';
    app.seek(0);
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 1200));
    const cap = await bridge.call('test:capture', { frames: 48000 });
    await app.stop();
    const bin = atob(cap.audio); let peak = 0;
    for (let i = 0; i < bin.length; i += 4) { const v = new DataView(new Uint8Array([bin.charCodeAt(i), bin.charCodeAt(i + 1), bin.charCodeAt(i + 2), bin.charCodeAt(i + 3)]).buffer).getFloat32(0, true); peak = Math.max(peak, Math.abs(v)); }
    return peak > 0.05 ? 'ok reopened the device, resent the song and its samples, and plays again (peak ' + peak.toFixed(2) + ')' : 'silent after recovery (' + peak + ')';`);

  for (const r of results) console.log(r);
  app.quit();
};
