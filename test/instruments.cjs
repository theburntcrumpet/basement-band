// End-to-end checks for user instruments (SoundFont, SFZ, sample folders) in the real app.
// Run via `npm run test:instruments` (hidden X display, isolated settings).
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');

module.exports = async function instruments(win, app) {
  const out = path.join(__dirname, '..', 'dist', 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const { js, check, finish } = harness(win, app);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const sfzDir = process.env.BB_SFZ_TEST_DIR || '';
  await new Promise(r => setTimeout(r, 1200));

  // Shared helpers inside the page: render one track and measure it.
  await js(`
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    window.__render = async (instrument, notes, seconds, drums = false) => {
      const p = newProject();
      p.bpm = 60;
      const t = newTrack(drums ? 'drums' : 'instrument', instrument);
      t.reverb = 0; t.volume = 0;
      t.regions.push({ id: 'r', start: 0, length: seconds, loopLength: seconds, notes });
      p.tracks.push(t);
      return renderProject(p, new Map(), { start: 0, end: seconds, tail: 0.5 });
    };
    window.__rms = (buf, from, to) => {
      const d = buf.getChannelData(0), a = Math.floor(from * buf.sampleRate), b = Math.floor(to * buf.sampleRate);
      let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i];
      return Math.sqrt(s / Math.max(1, b - a));
    };
    // Fundamental by autocorrelation between 60 Hz and 1.2 kHz.
    window.__pitch = (buf, from) => {
      const d = buf.getChannelData(0), sr = buf.sampleRate, a = Math.floor(from * sr), n = 4096;
      let best = 0, bestLag = 0;
      for (let lag = Math.floor(sr / 1200); lag < sr / 60; lag++) {
        let c = 0; for (let i = 0; i < n; i++) c += d[a + i] * d[a + i + lag];
        if (c > best) { best = c; bestLag = lag; }
      }
      return sr / bestLag;
    };
    return 'ok';`);

  await check('import FluidR3 GM soundfont', `
    const path = '/usr/share/soundfonts/FluidR3_GM.sf2';
    if (!(await window.host.allowInstrumentFile(path))) return 'not allowed';
    await app.importInstrumentPaths([path]);
    const entry = app.settings.userInstruments.find(e => e.path === path);
    const saved = await window.host.getSettings();
    return entry && entry.presets.length > 180 && saved.userInstruments.length === 1 ? 'ok ' + entry.presets.length + ' presets' : 'missing';`);

  await check('soundfont piano plays in tune', `
    const { instrumentId } = await import('./engine/user-instruments.js');
    const entry = app.settings.userInstruments[0];
    const id = instrumentId(entry, { bank: 0, program: 0 });
    const buf = await __render(id, [{ t: 0, d: 1.5, n: 69, v: 0.8 }], 2);
    const f = __pitch(buf, 0.3);
    const level = __rms(buf, 0.1, 1.0);
    return Math.abs(f - 440) < 6 && level > 0.01 ? 'ok ' + f.toFixed(1) + ' Hz, rms ' + level.toFixed(3) : 'pitch ' + f.toFixed(1) + ' rms ' + level;`);

  await check('soundfont strings sustain on a loop', `
    const { instrumentId } = await import('./engine/user-instruments.js');
    const id = instrumentId(app.settings.userInstruments[0], { bank: 0, program: 48 });
    const buf = await __render(id, [{ t: 0, d: 6, n: 60, v: 0.9 }], 6);
    const late = __rms(buf, 5.0, 5.8), early = __rms(buf, 1, 2);
    const f = __pitch(buf, 3);
    return late > early * 0.3 && Math.abs(f - 261.6) < 5 ? 'ok sustain ' + (late / early).toFixed(2) + ', ' + f.toFixed(1) + ' Hz' : 'late ' + late + ' early ' + early + ' f ' + f;`);

  await check('soundfont drum kit plays generated drums', `
    const { instrumentId } = await import('./engine/user-instruments.js');
    const { isKit, kitPieces } = await import('./engine/instruments.js');
    const { generate } = await import('./music/band.js');
    const id = instrumentId(app.settings.userInstruments[0], { bank: 128, program: 0 });
    if (!isKit(id)) return 'not detected as kit';
    const notes = generate({ style: 'rock', part: 'drums', complexity: 0.6, intensity: 0.8, seed: 2 }, { key: { root: 0, scale: 'major' }, bars: 2, timeSig: { num: 4, den: 4 } });
    const buf = await __render(id, notes, 8, true);
    const kick = __rms(buf, 0, 0.25);
    return kick > 0.02 && kitPieces(id).includes(36) ? 'ok rms ' + kick.toFixed(3) + ', ' + kitPieces(id).length + ' pieces' : 'quiet ' + kick;`);

  await check('import SFZ libraries (jRhodes + cowsynth)', `
    const dir = ${JSON.stringify(sfzDir)};
    if (!dir) return 'ok skipped (no BB_SFZ_TEST_DIR)';
    const files = [dir + '/jlearman.jRhodes3c/jRhodes3c-looped-flac-sfz/_jRhodes-stereo-looped.sfz', dir + '/karoryfer.cowsynth/cowsynth_fancy_pluck.sfz', dir + '/karoryfer.cowsynth/cowsynth_doc.sfz'];
    for (const f of files) if (!(await window.host.allowInstrumentFile(f))) return 'not allowed ' + f;
    await app.importInstrumentPaths(files);
    return app.settings.userInstruments.length === 4 ? 'ok' : 'entries ' + app.settings.userInstruments.length;`);

  await check('SFZ electric piano: velocity layers, embedded FLAC loop, pitch', `
    if (!${JSON.stringify(sfzDir)}) return 'ok skipped';
    const { instrumentId } = await import('./engine/user-instruments.js');
    const id = instrumentId(app.settings.userInstruments.find(e => e.name.includes('jRhodes')));
    const soft = await __render(id, [{ t: 0, d: 4, n: 57, v: 0.25 }], 4);
    const hard = await __render(id, [{ t: 0, d: 4, n: 57, v: 1 }], 4);
    const ratio = __rms(hard, 0.05, 0.5) / __rms(soft, 0.05, 0.5);
    const late = __rms(hard, 3.0, 3.8);
    const f = __pitch(hard, 0.5);
    return ratio > 2 && late > 0.002 && Math.abs(f - 220) < 4 ? 'ok hard/soft ' + ratio.toFixed(1) + 'x, still ringing at 3s (' + late.toFixed(4) + '), ' + f.toFixed(1) + ' Hz' : 'ratio ' + ratio + ' late ' + late + ' f ' + f;`);

  await check('SFZ synth with CC envelopes, filter EG and keyswitches', `
    if (!${JSON.stringify(sfzDir)}) return 'ok skipped';
    const { instrumentId } = await import('./engine/user-instruments.js');
    const out = [];
    for (const name of ['cowsynth_fancy_pluck', 'cowsynth_doc']) {
      const id = instrumentId(app.settings.userInstruments.find(e => e.name === name));
      const buf = await __render(id, [{ t: 0, d: 1, n: 48, v: 0.8 }, { t: 0, d: 1, n: 55, v: 0.8 }, { t: 1, d: 1, n: 60, v: 0.8 }], 2.5);
      const level = __rms(buf, 0.05, 1.8);
      if (!(level > 0.005)) return name + ' silent ' + level;
      out.push(name + ' ' + level.toFixed(3));
    }
    return 'ok ' + out.join(', ');`);

  await check('folder instruments: melodic map and drum kit', `
    const { inspect, planFromFiles } = await import('./engine/user-instruments.js');
    const root = ${JSON.stringify(path.resolve(__dirname, '..', 'assets', 'samples'))};
    const piano = await inspect('folder', root + '/piano');
    const kit = await inspect('folder', root + '/drums-rock');
    if (piano.kit || !kit.kit) return 'kit detection wrong: piano ' + piano.kit + ' kit ' + kit.kit;
    if (!kit.pieces.includes(36) || !kit.pieces.includes(38) || !kit.pieces.includes(42)) return 'kit pieces ' + kit.pieces;
    await app.importInstrumentPaths([root + '/piano'], 'folder');
    const { instrumentId } = await import('./engine/user-instruments.js');
    const buf = await __render(instrumentId(app.settings.userInstruments.at(-1)), [{ t: 0, d: 1, n: 64, v: 0.8 }], 1.5);
    const f = __pitch(buf, 0.3);
    return Math.abs(f - 329.6) < 5 ? 'ok piano folder ' + f.toFixed(1) + ' Hz, kit pieces ' + kit.pieces.join(',') : 'pitch ' + f;`);

  await check('live playing and track use', `
    const { instrumentId } = await import('./engine/user-instruments.js');
    const id = instrumentId(app.settings.userInstruments[0], { bank: 0, program: 0 });
    store.ui.selectedTrack = null;
    app.chooseInstrument(id);
    const t = store.selectedTrack;
    await app.engine.whenLoaded();
    app.noteOn(60, 0.8); await new Promise(r => setTimeout(r, 300)); app.noteOff(60);
    const node = app.engine.nodes.get(t.id);
    return t.instrument === id && node.instrument.constructor.name === 'MultiSampler' ? 'ok track "' + t.name + '"' : 'wrong instrument ' + node.instrument.constructor.name;`);

  await check('songs remember user instruments', `
    const { exportDefs, registerDefs, getUserDef } = await import('./engine/user-instruments.js');
    const ids = store.project.tracks.map(t => t.instrument).filter(id => id?.startsWith('user:'));
    const defs = exportDefs(ids);
    const d = defs[ids[0]];
    return d && d.source.kind === 'sf2' && d.name === getUserDef(ids[0]).name ? 'ok ' + JSON.stringify(d.source).slice(0, 80) : 'missing';`);

  await check('missing file falls back gracefully', `
    const { registerDefs } = await import('./engine/user-instruments.js');
    registerDefs({ 'user:gone': { name: 'Gone Piano', source: { kind: 'sf2', path: '/nope/gone.sf2', bank: 0, program: 0 } } });
    const { resolveInstrument } = await import('./engine/engine.js');
    const res = await resolveInstrument('user:gone');
    return res.fallback && res.id === 'electric-piano' ? 'ok' : JSON.stringify(res.id);`);

  await js(`app.library.show('sounds'); document.querySelector('#library-body').scrollTop = 0;`);
  await new Promise(r => setTimeout(r, 400));
  await shot('09-my-instruments');
  finish();
};
