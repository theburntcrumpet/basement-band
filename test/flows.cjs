// Exercises editing flows end to end in the real app (headless).
// BB_SMOKE=test/flows.cjs xvfb-run -a npx electron . --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function flows(win, app) {
  const out = path.join(__dirname, '..', 'dist', 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const js = code => win.webContents.executeJavaScript(`(async () => { ${code} })().catch(e => 'ERROR ' + e.stack)`);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const results = [];
  const check = async (name, code) => {
    const r = await js(code);
    const ok = typeof r === 'string' && r.startsWith('ok');
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${r}`);
  };
  await new Promise(r => setTimeout(r, 1200));

  await check('drummer quick start', `
    app.quickStart('drums');
    const t = store.project.tracks[0];
    return t.type === 'drums' && t.regions[0].notes.length > 20 ? 'ok ' + t.regions[0].notes.length + ' hits' : 'bad';`);

  await check('re-roll drummer via gen', `
    const r = store.project.tracks[0].regions[0];
    const before = JSON.stringify(r.notes);
    const { regenerate } = await import('./state.js');
    store.update(() => { r.gen.complexity = 1; r.gen.intensity = 1; regenerate(r, store.project); });
    return JSON.stringify(r.notes) !== before ? 'ok' : 'unchanged';`.replace('(await import', '(window.__s').replace("('./state.js'))", ')'));

  await check('loop add + key follow', `
    const { LOOPS } = await import('./ui/library.js');
    app.addLoop(LOOPS.find(l => l.id === 'pop-bass'), null, 8);
    const t = store.project.tracks.find(t => t.regions.some(r => r.gen?.part === 'bass'));
    const r = t.regions.find(r => r.gen);
    const first = r.notes[0].n;
    app.setKey(2, 'major');
    const moved = r === store.findRegion(r.id)?.region ? store.findRegion(r.id).region.notes[0].n : null;
    return (moved - first + 12) % 12 === 2 ? 'ok ' + first + '->' + moved : 'key did not follow ' + first + ' ' + moved;`);

  await check('undo / redo', `
    const n = store.project.tracks.length;
    app.addTrack('instrument', 'electric-piano');
    if (store.project.tracks.length !== n + 1) return 'add failed';
    store.undo();
    if (store.project.tracks.length !== n) return 'undo failed';
    store.redo();
    return store.project.tracks.length === n + 1 ? 'ok' : 'redo failed';`);

  await check('piano roll note editing', `
    const t = store.project.tracks.at(-1);
    app.createEmptyRegion(t, 0);
    const r = t.regions[0];
    store.update(() => { r.notes.push({ t: 0, d: 1, n: 60, v: .8 }, { t: 1, d: 1, n: 64, v: .8 }); });
    app.editor.selected = new Set(r.notes);
    app.editor.nudge(0, 12);
    app.editor.quantize();
    return r.notes[0].n === 72 && r.notes[1].n === 76 ? 'ok' : JSON.stringify(r.notes);`);

  await check('split + duplicate', `
    const t = store.project.tracks[0];
    const r = t.regions[0];
    store.ui.selectedRegions = new Set([r.id]);
    app.seek(r.start + 8);
    app.splitAtPlayhead();
    if (t.regions.length !== 2) return 'split failed ' + t.regions.length;
    const total = t.regions.reduce((a, x) => a + x.notes.length, 0);
    store.ui.selectedRegions = new Set([t.regions[1].id]);
    app.duplicateRegions();
    return t.regions.length === 3 ? 'ok notes=' + total : 'dup failed';`);

  await check('audio import (sample drag)', `
    const bytes = await (await fetch('samples/drums-808/808_Clap.flac')).arrayBuffer();
    await app.importAudio(bytes, 'Clap', null, 4);
    const t = store.project.tracks.find(t => t.type === 'audio');
    return t && t.regions[0].length > 0 ? 'ok len=' + t.regions[0].length.toFixed(2) : 'no audio track';`);

  await check('mic recording (fake device)', `
    const t = store.project.tracks.find(t => t.type === 'audio');
    store.ui.selectedTrack = t.id;
    app.countIn = false;
    app.seek(8);
    await app.toggleRecord();
    await new Promise(r => setTimeout(r, 2500));
    await app.stop();
    const rec = t.regions.find(r => r.name === 'Recording');
    if (!rec) return 'no recording region';
    const buf = app.engine.audioPool.get(rec.audioId);
    let peak = 0; const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return 'ok start=' + rec.start.toFixed(2) + ' secs=' + buf.duration.toFixed(2) + ' peak=' + peak.toFixed(2);`);

  await check('midi recording (musical typing)', `
    const t = store.project.tracks.find(t => t.instrument === 'electric-piano');
    store.ui.selectedTrack = t.id;
    const before = t.regions.length;
    app.seek(16);
    await app.toggleRecord();
    for (const n of [60, 64, 67, 72]) { app.noteOn(n, .8); await new Promise(r => setTimeout(r, 200)); app.noteOff(n); }
    await app.stop();
    const r = t.regions.at(-1);
    return t.regions.length === before + 1 && r.notes.length === 4 ? 'ok start=' + r.start + ' notes=' + r.notes.map(n => n.t.toFixed(2)).join(',') : 'regions ' + t.regions.length + ' notes ' + r?.notes.length;`);

  await check('save/open round trip', `
    const { toBase64, encodeWav, fromBase64 } = await import('./engine/wav.js');
    const used = store.project.tracks.flatMap(t => t.regions.map(r => r.audioId).filter(Boolean));
    const audio = Object.fromEntries(used.map(id => [id, toBase64(encodeWav(app.engine.audioPool.get(id)))]));
    const file = JSON.parse(JSON.stringify({ format: 'basement-band', version: 1, project: store.project, audio }));
    const back = await Tone.getContext().rawContext.decodeAudioData(fromBase64(audio[used[0]]));
    const orig = app.engine.audioPool.get(used[0]);
    return Math.abs(back.duration - orig.duration) < 0.01 && file.project.tracks.length === store.project.tracks.length ? 'ok ' + used.length + ' audio clips' : 'mismatch';`);

  await check('export full song', `
    const { renderProject, songEnd } = await import('./engine/engine.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: songEnd(store.project) });
    const d = buf.getChannelData(0); let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return peak > 0.05 && peak <= 1 ? 'ok secs=' + buf.duration.toFixed(1) + ' peak=' + peak.toFixed(2) : 'peak ' + peak;`);

  await check('switch song to 3/4', `
    const before = store.project.tracks.flatMap(t => t.regions.map(r => r.start / 4));
    app.setTimeSig('3/4');
    const after = store.project.tracks.flatMap(t => t.regions.map(r => r.start / 3));
    if (before.some((b, i) => Math.abs(b - after[i]) > 1e-6)) return 'bars moved ' + before + ' / ' + after;
    const gen = store.project.tracks.flatMap(t => t.regions).find(r => r.gen);
    if (gen.loopLength % 3 !== 0) return 'generated region not whole 3/4 bars: ' + gen.loopLength;
    if (gen.notes.some(n => n.t >= gen.loopLength)) return 'notes past region';
    store.undo();
    if (store.project.timeSig.num !== 4) return 'undo failed';
    store.redo();
    return document.querySelector('#lcd-time').value === '3/4' ? 'ok' : 'lcd not updated';`);

  await check('6/8 band, playback position and export', `
    // Start fresh without the unsaved-changes dialog (tests must never wait on a click).
    store.dirty = false;
    await app.newSong();
    app.setTimeSig('6/8');
    app.createBand({ style: 'ballad', progression: 'I | vi | IV | V', bars: 4, parts: ['drums', 'bass', 'keys', 'pad'], complexity: 0.5, intensity: 0.6, setTempo: true });
    const lens = store.project.tracks.map(t => t.regions[0].length);
    if (lens.some(l => l !== 12)) return 'region lengths ' + lens;
    app.engine.metronome = true;
    app.seek(3);
    await app.engine.whenLoaded();
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 400));
    const lcd = document.querySelector('#lcd-pos').textContent;
    await app.stop();
    app.engine.metronome = false;
    if (!lcd.startsWith('2.')) return 'lcd ' + lcd;
    const { renderProject, songEnd } = await import('./engine/engine.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: songEnd(store.project) });
    const d = buf.getChannelData(0); let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return peak > 0.05 ? 'ok lcd=' + lcd + ' secs=' + buf.duration.toFixed(1) : 'silent';`);

  await check('7/8 grid and drummer', `
    app.setTimeSig('7/8');
    const t = store.project.tracks.find(t => t.type === 'drums');
    const r = t.regions[0];
    const bar = 3.5;
    const downbeats = [0, 1, 2, 3].every(b => r.notes.some(n => Math.abs(n.t - b * bar) < 0.02));
    return downbeats && r.loopLength === 14 ? 'ok' : 'loop ' + r.loopLength + ' downbeats ' + downbeats;`);

  await check('dragging a drummer region longer writes new bars', `
    store.dirty = false;
    await app.newSong();
    app.quickStart('drums');
    const t = store.project.tracks[0];
    const r = t.regions[0];
    const el = document.querySelector('.region[data-id="' + r.id + '"] .handle-resize');
    const box = el.getBoundingClientRect();
    const x = box.right - 2, y = box.bottom - 4;
    const px = 8 * 4 * store.ui.zoom; // eight more bars
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    for (let i = 1; i <= 10; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + (px * i) / 10, clientY: y }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + px, clientY: y }));
    const region = store.project.tracks[0].regions[0];
    const lastBarHits = region.notes.filter(n => n.t >= 60).length;
    if (region.length !== 64 || region.loopLength !== 64) return 'length ' + region.length + '/' + region.loopLength;
    if (!region.gen) return 'lost its drummer settings';
    if (lastBarHits < 4) return 'last bar has ' + lastBarHits + ' hits';
    store.undo();
    return store.project.tracks[0].regions[0].length === 32 ? 'ok 8 -> 16 bars, ' + region.notes.length + ' hits, undo restores' : 'undo failed';`);

  await check('track EQ shapes bass and treble in the mix', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const render = async eq => {
      const p = newProject();
      const t = Object.assign(newTrack('instrument', 'chip'), { reverb: 0, ...eq });
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes: [36, 60].map(n => ({ t: 0, d: 3, n, v: 0.8 })) });
      p.tracks.push(t);
      return renderProject(p, new Map(), { start: 0, end: 4, tail: 0.2 });
    };
    // Energy below 150 Hz and above 4 kHz, measured through steep filters.
    const bandRms = async (buf, type, freq) => {
      const out = await Tone.Offline(() => {
        const p = new Tone.Player(buf);
        p.chain(new Tone.Filter({ type, frequency: freq, rolloff: -48 }), Tone.getDestination());
        p.start(0);
      }, buf.duration);
      const d = out.getChannelData(0); let e = 0; for (let i = 0; i < d.length; i++) e += d[i] * d[i];
      return Math.sqrt(e / d.length);
    };
    const bands = async buf => ({ lo: await bandRms(buf, 'lowpass', 150), hi: await bandRms(buf, 'highpass', 4000) });
    const bassUp = await bands(await render({ eqLow: 12, eqHigh: -12 }));
    const trebleUp = await bands(await render({ eqLow: -12, eqHigh: 12 }));
    const loRatio = bassUp.lo / trebleUp.lo, hiRatio = trebleUp.hi / bassUp.hi;
    app.quickStart('instrument');
    app.bottomMode = 'smart'; app.refresh();
    const labels = [...document.querySelectorAll('.knob label')].map(l => l.textContent);
    const ok = loRatio > 4 && hiRatio > 4 && ['Bass', 'Mid', 'Treble'].every(l => labels.includes(l)) && document.querySelector('.eq-curve');
    return ok ? 'ok bass x' + loRatio.toFixed(1) + ', treble x' + hiRatio.toFixed(1) : 'lo ' + loRatio + ' hi ' + hiRatio + ' labels ' + labels;`);

  await check('generated FX: tempo-sized and shaped right', `
    const { GEN_FX, renderFx } = await import('./engine/fxgen.js');
    const rms = (buf, a, b) => { const d = buf.getChannelData(0); const i0 = Math.floor(a * d.length), i1 = Math.floor(b * d.length); let e = 0; for (let i = i0; i < i1; i++) e += d[i] * d[i]; return Math.sqrt(e / Math.max(1, i1 - i0)); };
    const out = [];
    for (const fx of GEN_FX) {
      for (const bars of fx.bars || [null]) {
        const buf = await renderFx(fx.id, { bars: bars || 1, bpm: 120, barBeats: 4 });
        const want = fx.seconds ?? bars * 2;
        if (Math.abs(buf.duration - want) > 0.01) return fx.id + ' length ' + buf.duration + ' want ' + want;
        let peak = 0; for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
        if (peak < 0.5 || peak > 0.9) return fx.id + ' peak ' + peak;
        const early = rms(buf, 0, 0.25), late = rms(buf, 0.7, 0.95);
        const rising = ['riser', 'synth-riser', 'reverse-cymbal'].includes(fx.id), falling = ['downlifter', 'impact', 'noise-hit'].includes(fx.id);
        if (rising && !(late > early * 3)) return fx.id + ' does not rise ' + early + ' -> ' + late;
        if (falling && !(early > late * 3)) return fx.id + ' does not fall ' + early + ' -> ' + late;
        out.push(fx.id + (bars ? '/' + bars : ''));
      }
    }
    return 'ok ' + out.length + ' renders';`);

  await check('drop a 2-bar riser into a 90 bpm song', `
    store.dirty = false;
    await app.newSong();
    store.update(p => { p.bpm = 90; });
    const data = { kind: 'sample', gen: 'riser', bars: 2, name: 'Noise Riser · 2 bars' };
    await app.handleDrop({ dataTransfer: { files: [], getData: () => JSON.stringify(data) } }, null, 8);
    const t = store.project.tracks.find(t => t.type === 'audio');
    const r = t?.regions[0];
    return r && Math.abs(r.length - 8) < 0.01 && r.start === 8 ? 'ok riser region spans bars 3-4 exactly' : JSON.stringify(r);`);

  await check('all bundled FX and atmospheres decode', `
    const { builtinSamples, loadBuffer } = await import('./engine/instruments.js');
    const fx = builtinSamples().filter(s => s.credit);
    let total = 0;
    for (const s of fx) { const b = await loadBuffer(s.url); if (!(b.duration > 0.2)) return s.name + ' broken'; total += b.duration; }
    return fx.length === 45 ? 'ok ' + fx.length + ' sounds, ' + Math.round(total) + ' s' : 'count ' + fx.length;`);

  await check('export dialog and every format', `
    store.dirty = false;
    await app.newSong();
    app.quickStart('drums');
    app.exportSong();
    const options = [...document.querySelectorAll('#modal select')[0].options].map(o => o.value);
    document.querySelector('#modal .actions .text').click();
    if (options.length !== 6) return 'formats ' + options;
    const { renderProject } = await import('./engine/engine.js');
    const { encodeAudio } = await import('./engine/export.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 8, sampleRate: 44100 });
    const sizes = {};
    for (const id of options) {
      const bytes = await encodeAudio(buf, id);
      const head = String.fromCharCode(...bytes.slice(0, 4));
      const ok = id.startsWith('mp3') ? (head.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) : id === 'flac' ? head === 'fLaC' : head === 'RIFF';
      if (!ok) return id + ' bad header ' + head;
      sizes[id] = Math.round(bytes.length / 1024) + 'KB';
    }
    return 'ok ' + JSON.stringify(sizes);`);

  await check('cycle range: draw, move, resize edges, toggle', `
    const ruler = document.querySelector('#ruler');
    const r = ruler.getBoundingClientRect();
    const xAt = beat => r.left + beat * store.ui.zoom;
    const y = r.top + 6;
    const dragFrom = (a, b) => {
      ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: xAt(a), clientY: y, button: 0 }));
      for (let i = 1; i <= 6; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: xAt(a + ((b - a) * i) / 6), clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: xAt(b), clientY: y }));
    };
    const c = () => store.project.cycle;
    store.update(p => { p.cycle = { on: false, start: 0, end: 16 }; });
    dragFrom(2, 9);             // forwards, starting inside the old (dim) range
    if (!(c().on && c().start === 0 && c().end === 12)) return 'forward draw ' + JSON.stringify(c());
    dragFrom(6, 10);            // middle: move by a bar
    if (!(c().start === 4 && c().end === 16)) return 'move ' + JSON.stringify(c());
    dragFrom(16, 23);           // right edge
    if (c().end !== 24) return 'end edge ' + JSON.stringify(c());
    dragFrom(4, 0.5);           // left edge
    if (c().start !== 0) return 'start edge ' + JSON.stringify(c());
    dragFrom(30, 21);           // backwards draw outside the range
    if (!(c().start === 20 && c().end === 32)) return 'backward draw ' + JSON.stringify(c());
    ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: xAt(25), clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: xAt(25), clientY: y }));
    return c().on === false ? 'ok' : 'click did not toggle';`);

  await check('resizing a looped clip keeps the repeats', `
    const t = app.addTrack('instrument', 'grand-piano', 'Looped');
    app.createEmptyRegion(t, 0);
    const reg = t.regions[0];
    store.update(() => { reg.notes = [{ t: 0, d: 1, n: 60, v: 0.8 }, { t: 2, d: 1, n: 64, v: 0.8 }]; reg.length = 16; reg.loopLength = 4; });
    app.refresh();
    const { expandRegion } = await import('./engine/engine.js');
    const before = JSON.stringify(expandRegion(reg).map(n => [n.t, n.n]));
    const el = document.querySelector('.region[data-id="' + reg.id + '"] .handle-resize');
    const box = el.getBoundingClientRect();
    const x = box.right - 2, yy = box.bottom - 3, px = 4 * store.ui.zoom;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: yy, button: 0 }));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x - (px * 2 * i) / 6, clientY: yy }));
    for (let i = 1; i <= 6; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x - px * 2 + (px * 3 * i) / 6, clientY: yy }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + px, clientY: yy }));
    const after = store.findRegion(reg.id).region;
    const played = JSON.stringify(expandRegion(after).filter(n => n.t < 16).map(n => [n.t, n.n]));
    if (after.length !== 20 || after.loopLength !== 20) return 'length ' + after.length + '/' + after.loopLength;
    return played === before && after.notes.length === 8 ? 'ok 4 loop passes kept, 4 beats added' : 'notes ' + after.notes.length + ' ' + played;`);

  await check('effects: vinyl crackles and ages, radio narrows, track lo-fi', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { defaultFx } = await import('./engine/effects.js');
    const song = (masterFx, trackFx) => {
      const p = newProject();
      p.masterFx = masterFx;
      const t = Object.assign(newTrack('instrument', 'chip'), { reverb: 0, fx: trackFx || { type: 'none' } });
      t.regions.push({ id: 'r', start: 0, length: 8, loopLength: 8, notes: [36, 60, 84].map(n => ({ t: 0, d: 3, n, v: 0.8 })) });
      p.tracks.push(t);
      return renderProject(p, new Map(), { start: 0, end: 8, tail: 0.1 });
    };
    const band = async (buf, type, freq, from = 0, to = buf.duration) => {
      const out = await Tone.Offline(() => { const pl = new Tone.Player(buf); pl.chain(new Tone.Filter({ type, frequency: freq, rolloff: -48 }), Tone.getDestination()); pl.start(0); }, buf.duration);
      const d = out.getChannelData(0), a = Math.floor(from * out.sampleRate), b = Math.floor(to * out.sampleRate);
      let e = 0; for (let i = a; i < b; i++) e += d[i] * d[i];
      return Math.sqrt(e / Math.max(1, b - a));
    };
    const rmsAt = (buf, from, to) => { const d = buf.getChannelData(0), a = Math.floor(from * buf.sampleRate), b = Math.floor(to * buf.sampleRate); let e = 0; for (let i = a; i < b; i++) e += d[i] * d[i]; return Math.sqrt(e / (b - a)); };
    const dry = await song({ type: 'none' });
    const vinyl = await song({ ...defaultFx('vinyl'), age: 0.8, crackle: 0.8, pops: 0.6 });
    const aged = await song({ ...defaultFx('vinyl'), age: 0.8, crackle: 0, pops: 0 });
    const radio = await song(defaultFx('radio'));
    const lofi = await song({ type: 'none' }, { ...defaultFx('lofi'), crush: 0.9 });
    // 8 beats at 110 bpm is 4.36 s; notes last 3 beats (1.64 s). After ~2.4 s the dry mix is silent.
    const quietDry = rmsAt(dry, 2.6, 4.2), quietVinyl = rmsAt(vinyl, 2.6, 4.2);
    const topDry = await band(dry, 'highpass', 9000, 0.1, 1.5), topVinyl = await band(aged, 'highpass', 9000, 0.1, 1.5);
    const lowDry = await band(dry, 'lowpass', 150, 0.1, 1.5), lowRadio = await band(radio, 'lowpass', 150, 0.1, 1.5);
    const lofiLevel = rmsAt(lofi, 0.1, 1.5);
    const checks = { crackle: quietVinyl > 0.003 && quietVinyl > quietDry * 20, aged: topVinyl < topDry * 0.5, radio: lowRadio < lowDry * 0.2, lofi: lofiLevel > 0.01 };
    const ok = Object.values(checks).every(Boolean);
    const detail = 'tail ' + quietDry.toExponential(1) + '->' + quietVinyl.toFixed(4) + ', >9k ' + (topVinyl / topDry).toFixed(2) + 'x, radio <150Hz ' + (lowRadio / lowDry).toFixed(3) + 'x';
    return ok ? 'ok ' + detail : JSON.stringify(checks) + ' ' + detail;`);

  await check('master fx noise stops with the transport', `
    store.update(p => { p.masterFx = { type: 'vinyl', crackle: 0.5, pops: 0.3, age: 0.5, wow: 0.3, mix: 1 }; });
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 300));
    const playing = app.engine.buses.masterFx.graph.noise[0].gain.value;
    await app.stop();
    await new Promise(r => setTimeout(r, 300));
    const stopped = app.engine.buses.masterFx.graph.noise[0].gain.value;
    app.bottomMode = 'master'; app.refresh();
    const knobs = [...document.querySelectorAll('#bottom .knob label')].map(l => l.textContent).join(',');
    return playing > 0.9 && stopped < 0.01 && knobs.includes('Crackle') ? 'ok noise ' + playing.toFixed(2) + ' -> ' + stopped.toFixed(3) : 'noise ' + playing + ' -> ' + stopped + ' knobs ' + knobs;`);

  await new Promise(r => setTimeout(r, 300));
  await shot('12-master-fx');
  await js(`store.update(p => { p.tracks[0] && (p.tracks[0].fx = { type: 'tape', saturation: 0.4, warmth: 0.4, wow: 0.25, hiss: 0.15, mix: 1 }); }); store.ui.selectedTrack = store.project.tracks[0]?.id; app.bottomMode = 'smart'; app.refresh();`);
  await new Promise(r => setTimeout(r, 300));
  await shot('13-track-fx');
  await check('guitar amp: models add drive, gate kills hum', `
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { defaultAmp } = await import('./engine/amp.js');
    // A fake guitar DI: hum, then a plucked low E-ish note, then hum.
    const rate = 44100, n = rate * 3;
    const di = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
    const d = di.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const t = i / rate;
      let v = Math.sin(2 * Math.PI * 50 * t) * 0.0015 + (seed / 2 ** 32 - 0.5) * 0.001;
      if (t >= 1 && t < 2.5) { const k = t - 1; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 82.4 * h * t) * 0.3 / h * Math.exp(-k * 1.5); }
      d[i] = v;
    }
    const pool = new Map([['di', di]]);
    const render = amp => {
      const p = newProject();
      p.bpm = 120;
      const t = Object.assign(newTrack('audio', null, 'Gtr'), { reverb: 0, amp });
      t.regions.push({ id: 'r', start: 0, length: 6, offset: 0, audioId: 'di' });
      p.tracks.push(t);
      return renderProject(p, pool, { start: 0, end: 6, tail: 0.1 });
    };
    const bandRms = async (buf, type, freq, from, to) => {
      const out = await Tone.Offline(() => { const pl = new Tone.Player(buf); pl.chain(new Tone.Filter({ type, frequency: freq, rolloff: -48 }), Tone.getDestination()); pl.start(0); }, buf.duration);
      const x = out.getChannelData(0), a = Math.floor(from * out.sampleRate), b = Math.floor(to * out.sampleRate);
      let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i];
      return Math.sqrt(e / (b - a));
    };
    const rms = (buf, from, to) => { const x = buf.getChannelData(0), a = Math.floor(from * buf.sampleRate), b = Math.floor(to * buf.sampleRate); let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / (b - a)); };
    const bright = {};
    for (const model of ['off', 'clean', 'crunch', 'lead']) {
      const buf = await render(model === 'off' ? { model: 'off' } : { ...defaultAmp(model), gain: 0.7, gate: 0 });
      const total = rms(buf, 1.1, 1.8);
      if (!(total > 0.01)) return model + ' silent';
      bright[model] = (await bandRms(buf, 'highpass', 1500, 1.1, 1.8)) / total;
    }
    const order = bright.off < bright.clean && bright.clean < bright.crunch && bright.crunch < bright.lead;
    const ungated = await render({ ...defaultAmp('lead'), gain: 0.8, gate: 0 });
    const gated = await render({ ...defaultAmp('lead'), gain: 0.8, gate: 0.75 });
    // The gate must exist inside export renders too (its worklet is loaded per context).
    const { AmpSlot } = await import('./engine/amp.js');
    const { loadWorklets } = await import('./engine/engine.js');
    const probe = await Tone.Offline(async () => { await loadWorklets(); const a = new AmpSlot(); a.setConfig(defaultAmp('lead')); window.__gateBuilt = !!a.nodes.gate; }, 0.1);
    if (!window.__gateBuilt) return 'gate missing in offline render';
    // ...and live, on the guitar track's amp.
    app.quickStart('guitar');
    const liveAmp = app.engine.nodes.get(store.selectedTrack.id).amp;
    if (!liveAmp.nodes.gate) return 'gate missing live';
    const humOpen = rms(ungated, 0.2, 0.8), humGated = rms(gated, 0.2, 0.8), noteGated = rms(gated, 1.1, 1.8);
    const gateOk = humGated < humOpen * 0.05 && noteGated > 0.02;
    const desc = Object.entries(bright).map(([k, v]) => k + ' ' + v.toFixed(3)).join(', ') + '; hum ' + humOpen.toFixed(4) + ' -> ' + humGated.toExponential(1);
    return order && gateOk ? 'ok ' + desc : 'order ' + order + ' gate ' + gateOk + ' ' + desc;`);

  await check('guitar track: monitor through the amp, record clean', `
    app.countIn = false;
    app.quickStart('guitar');
    const t = store.selectedTrack;
    if (t.amp.model !== 'crunch') return 'amp ' + JSON.stringify(t.amp);
    await app.toggleMonitor(t);
    // The fake input beeps on and off, so watch the levels for a couple of seconds.
    const node = app.engine.nodes.get(t.id);
    let level = -Infinity, trackMeter = -Infinity;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      level = Math.max(level, app.engine.inputLevel('left'));
      const m = node.meter.getValue();
      trackMeter = Math.max(trackMeter, typeof m === 'number' ? m : Math.max(...m));
    }
    if (!(level > -40)) return 'no input level ' + level;
    if (!(trackMeter > -60)) return 'nothing reaching the track ' + trackMeter;
    app.seek(4);
    await app.toggleRecord();
    await new Promise(r => setTimeout(r, 1500));
    await app.stop();
    const take = t.regions.find(r => r.name === 'Recording');
    if (!take) return 'no take';
    const buf = app.engine.audioPool.get(take.audioId);
    const stillMonitoring = !!app.engine.monitor;
    return buf.numberOfChannels === 1 && stillMonitoring ? 'ok input ' + level.toFixed(1) + ' dB, mono take ' + buf.duration.toFixed(2) + ' s, latency ~' + app.engine.inputInfo().monitorLatencyMs + ' ms' : 'channels ' + buf.numberOfChannels + ' monitoring ' + stillMonitoring;`);

  await new Promise(r => setTimeout(r, 300));
  await shot('14-guitar');
  await check('stop monitoring releases the input', `
    app.stopMonitoring();
    return app.engine.inputStream === null && !app.engine.monitor ? 'ok' : 'input still open';`);

  await check('audio clips: extend with silence, loop, snap to bars, split', `
    store.dirty = false;
    await app.newSong();
    store.update(p => { p.bpm = 120; });
    // A 7.6-beat clip (a little short of 2 bars): a click at the start of each beat.
    const rate = 44100, spb = 0.5;
    const clip = new AudioBuffer({ length: Math.round(7.6 * spb * rate), sampleRate: rate, numberOfChannels: 1 });
    for (let b = 0; b < 8; b++) { const i = Math.round(b * spb * rate); for (let k = 0; k < 200 && i + k < clip.length; k++) clip.getChannelData(0)[i + k] = Math.sin(k * 0.3) * 0.8; }
    app.addAudioBuffer(clip, 'Clip', null, 0);
    const t = store.project.tracks.find(t => t.type === 'audio');
    const r = t.regions[0];
    app.refresh();
    const drag = (handle, dxBeats) => {
      const el = document.querySelector('.region[data-id="' + r.id + '"] ' + handle);
      const box = el.getBoundingClientRect();
      const x = handle === '' ? box.left + 5 : box.right - 2, y = handle === '.handle-loop' ? box.top + 3 : box.bottom - 3;
      const target = handle === '' ? document.querySelector('.region[data-id="' + r.id + '"] .label') : el;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
      for (let i = 1; i <= 6; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + (dxBeats * store.ui.zoom * i) / 6, clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + dxBeats * store.ui.zoom, clientY: y }));
      app.refresh();
    };
    drag('.handle-resize', 0.6);   // 7.6 -> 8 beats: pads with silence
    const reg = () => store.findRegion(r.id).region;
    if (Math.abs(reg().length - 8) > 1e-6 || Math.abs(reg().loopLength - 8) > 1e-6) return 'extend ' + reg().length + '/' + reg().loopLength;
    drag('.handle-loop', 24);      // repeat to 32 beats (4 passes)
    if (Math.abs(reg().length - 32) > 1e-6 || reg().loopLength !== 8) return 'loop ' + reg().length + '/' + reg().loopLength;
    // Render and check a click starts every pass exactly on the bar.
    const { renderProject, audioSegments } = await import('./engine/engine.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 32, tail: 0.1 });
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    const at = beat => { let m = 0; const i = Math.round(beat * spb * sr); for (let k = 0; k < 400; k++) m = Math.max(m, Math.abs(d[i + k] || 0)); return m; };
    const gap = beat => { let m = 0; const i = Math.round(beat * spb * sr); for (let k = 0; k < 0.15 * sr; k++) m = Math.max(m, Math.abs(d[i + k] || 0)); return m; };
    // Each repeat starts with its click right on the bar (the render's very first click sits under the clip fade-in).
    if (!([8, 16, 24].every(b => at(b) > 0.1) && at(0) > 0.02)) return 'pass starts ' + [0, 8, 16, 24].map(at);
    if (!(gap(7.65) < 0.02)) return 'padding not silent ' + gap(7.65);
    // Move an off-grid copy onto a bar line.
    store.update(() => { t.regions.push({ ...JSON.parse(JSON.stringify(reg())), id: 'copy', start: 33.4, length: 8, loopLength: 8 }); });
    store.ui.selectedRegions = new Set(['copy']); app.refresh();
    const c = document.querySelector('.region[data-id="copy"] .label'), cb = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cb.left + 5, clientY: cb.top + 5, button: 0 }));
    for (let i = 1; i <= 4; i++) window.dispatchEvent(new MouseEvent('mousemove', { clientX: cb.left + 5 + store.ui.zoom * 2.3 * i / 4, clientY: cb.top + 5 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: cb.left + 5 + store.ui.zoom * 2.3, clientY: cb.top + 5 }));
    const moved = store.findRegion('copy').region.start;
    if (Math.abs(moved - Math.round(moved)) > 1e-6) return 'move did not snap: ' + moved;
    // Duplicating the short clip lands the copy on the next bar.
    store.update(() => { t.regions = t.regions.filter(x => x.id === r.id); });
    store.update(() => { reg().length = 7.6; reg().loopLength = 7.6; });
    store.ui.selectedRegions = new Set([r.id]);
    app.duplicateRegions();
    const dup = t.regions.find(x => x.id !== r.id);
    if (dup.start !== 8) return 'duplicate landed at ' + dup.start;
    // Splitting a looped clip plays exactly the same.
    store.update(() => { t.regions = [reg()]; reg().length = 32; reg().loopLength = 8; });
    const before = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 32, tail: 0 });
    store.ui.selectedRegions = new Set([r.id]);
    app.seek(13.25); // between clicks: the new half's 3 ms anti-click fade-in shouldn't land on one
    app.splitAtPlayhead();
    const after = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 32, tail: 0 });
    const a = before.getChannelData(0), b2 = after.getChannelData(0);
    // Compare loudness in 10 ms windows: resampling a 44.1 kHz clip in a 48 kHz context can shift a
    // mid-clip start by a fraction of a sample, which is inaudible but not sample-identical.
    const win = Math.round(before.sampleRate * 0.01);
    let diff = 0, where = 0;
    for (let i = 0; i + win < a.length; i += win) {
      let ea = 0, eb = 0; for (let k = i; k < i + win; k++) { ea += a[k] * a[k]; eb += b2[k] * b2[k]; }
      const x = Math.abs(Math.sqrt(ea / win) - Math.sqrt(eb / win));
      if (x > diff) { diff = x; where = i; }
    }
    const beatsAt = where / before.sampleRate / spb;
    const regs = JSON.stringify(t.regions.map(x => ({ s: x.start, l: x.length, ll: x.loopLength, ph: x.phase, o: x.offset })));
    return diff < 0.02 ? 'ok extend, loop x4 on the bar, snap-to-bar move to ' + moved + ', duplicate at bar 3, split identical (max diff ' + diff.toFixed(4) + ')' : 'split changed audio by ' + diff.toFixed(3) + ' at beat ' + beatsAt.toFixed(3) + ' ' + regs;`);

  await check('piano roll tools: box, pencil, eraser, copy/paste/duplicate, key glow', `
    store.dirty = false;
    await app.newSong();
    const t = app.addTrack('instrument', 'grand-piano', 'Keys');
    app.createEmptyRegion(t, 0);
    const r = t.regions[0];
    store.update(() => { r.notes = [{ t: 0, d: 1, n: 60, v: 0.8 }, { t: 1, d: 1, n: 64, v: 0.8 }, { t: 2, d: 1, n: 67, v: 0.8 }]; });
    app.openEditor(r.id);
    const ed = app.editor;
    await new Promise(res => setTimeout(res, 100));
    const grid = ed.grid, box = grid.getBoundingClientRect();
    const at = (beat, midi) => ({ clientX: box.left + beat * ed.ppb + 2, clientY: box.top + ed.rowY(midi) + ed.rowH / 2 });
    const mouse = (type, target, p) => (target || window).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...p }));
    const dragFrom = (a, b) => { mouse('mousedown', grid, a); for (let i = 1; i <= 5; i++) mouse('mousemove', null, { clientX: a.clientX + (b.clientX - a.clientX) * i / 5, clientY: a.clientY + (b.clientY - a.clientY) * i / 5 }); mouse('mouseup', null, b); };
    // Box tool: drag around the first two notes.
    ed.setTool('box');
    dragFrom(at(-0.02, 65), at(1.9, 59));
    if (ed.selected.size !== 2) return 'box selected ' + ed.selected.size;
    // Key glow: the C4 row of the keyboard is tinted while selected.
    const kc = ed.keys.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const px = kc.getImageData(Math.round(50 * dpr), Math.round((ed.rowY(60) + ed.rowH / 2) * dpr), 1, 1).data;
    if (px[0] === 255 && px[1] === 255 && px[2] === 255 || px[0] === 232 && px[1] === 232) return 'C4 key not highlighted ' + Array.from(px);
    // Copy, paste at the playhead (beat 4), duplicate.
    app.bottomMode = 'editor';
    app.copy(false);
    app.seek(4);
    app.paste();
    if (r.notes.length !== 5) return 'paste -> ' + r.notes.length;
    const pasted = [...ed.selected].map(n => n.t).sort();
    if (pasted[0] !== 4 || pasted[1] !== 5) return 'pasted at ' + pasted;
    if (r.length < 8) return 'region did not grow to fit: ' + r.length;
    ed.duplicate();
    const dup = [...ed.selected].map(n => n.t).sort();
    if (dup[0] !== 6 || r.notes.length !== 7) return 'duplicate at ' + dup + ' count ' + r.notes.length;
    // Pencil: draw a new note on E5.
    ed.setTool('pencil');
    dragFrom(at(3, 76), at(3.9, 76));
    if (!r.notes.some(n => n.n === 76 && n.t === 3)) return 'pencil did not draw';
    // Eraser: sweep across C4 and E4 at beats 0-1.
    ed.setTool('eraser');
    dragFrom(at(0.1, 60), at(0.2, 60));
    if (r.notes.some(n => n.n === 60 && n.t === 0)) return 'eraser missed';
    // Cut and undo.
    ed.selected = new Set(r.notes.filter(n => n.t >= 4));
    const before = r.notes.length;
    app.copy(true);
    if (r.notes.length !== before - 4) return 'cut left ' + r.notes.length;
    store.undo();
    return store.findRegion(r.id).region.notes.length === before ? 'ok box 2, paste @4, duplicate @6, pencil, eraser, cut + undo' : 'undo after cut';`);

  await check('regions: copy and paste at the playhead', `
    const t = store.project.tracks[0];
    store.ui.selectedRegions = new Set([t.regions[0].id]);
    app.bottomMode = null; app.refresh();
    app.copy(false);
    app.seek(16);
    app.paste();
    const copy = t.regions.find(x => x.start === 16);
    return copy && copy.notes.length === t.regions[0].notes.length ? 'ok' : JSON.stringify(t.regions.map(x => x.start));`);

  await check('light mode and settings screen', `
    app.applyTheme('light');
    await new Promise(r => setTimeout(r, 100));
    const bg = getComputedStyle(document.body).backgroundColor;
    if (document.documentElement.dataset.theme !== 'light' || bg === 'rgb(27, 28, 32)') return 'theme ' + document.documentElement.dataset.theme + ' bg ' + bg;
    app.openSettings();
    const modes = [...document.querySelectorAll('#modal input[name=audio-mode]')].map(i => i.value).join(',');
    document.querySelector('#modal input[value=stable]').click();
    await new Promise(r => setTimeout(r, 100));
    const note = document.querySelector('#modal .settings-note').textContent;
    const saved = (await window.host.getSettings()).audioMode;
    document.querySelector('#modal input[value=balanced]').click();
    await new Promise(r => setTimeout(r, 100));
    return modes === 'stable,balanced,low' && note.includes('Restart') && saved === 'stable' ? 'ok bg ' + bg : 'modes ' + modes + ' note ' + note + ' saved ' + saved;`);

  await new Promise(r => setTimeout(r, 200));
  await shot('15-settings-light');
  await js(`document.querySelector('#modal .actions .text').click(); const t = store.project.tracks[0]; app.openEditor(t.regions[0].id); app.editor.selected = new Set(t.regions[0].notes.slice(0, 3)); app.editor.setTool('pointer'); app.library.show('sounds');`);
  await new Promise(r => setTimeout(r, 300));
  await shot('16-editor-light');
  await js(`app.applyTheme('dark');`);
  await new Promise(r => setTimeout(r, 200));
  await shot('17-editor-dark');

  await check('automation: lane editing and playback follow the curve', `
    store.dirty = false;
    await app.newSong();
    const t = app.addTrack('instrument', 'chip', 'Auto');
    store.update(() => { t.reverb = 0; t.regions.push({ id: 'r', start: 0, length: 16, loopLength: 16, notes: [{ t: 0, d: 16, n: 60, v: 0.8 }] }); });
    // Open the lane and draw a volume ramp with the mouse: -40 dB at beat 0 up to +0 dB at beat 8.
    app.arrange.toggleAutomation(t);
    await new Promise(r => setTimeout(r, 100));
    // Each edit redraws the arrangement, so find the lane's canvas afresh for every click.
    const click = (beat, v) => {
      const cv = document.querySelector('.auto-lane[data-id="' + t.id + '"] canvas');
      const box = cv.getBoundingClientRect(), g = app.arrange.autoGeom(cv, 'volume');
      const p = { clientX: box.left + beat * store.ui.zoom, clientY: box.top + g.y(v), bubbles: true, button: 0 };
      cv.dispatchEvent(new MouseEvent('mousedown', p));
      window.dispatchEvent(new MouseEvent('mouseup', p));
    };
    click(0, -40);
    click(8, 0);
    const pts = t.automation?.volume || [];
    if (pts.length !== 2 || Math.abs(pts[0].v + 40) > 1 || Math.abs(pts[1].v) > 1 || pts[1].t !== 8) return 'points ' + JSON.stringify(pts);
    // Parked at beat 4, the channel sits halfway (-20 dB).
    app.seek(4);
    await new Promise(r => setTimeout(r, 150));
    const parked = app.engine.nodes.get(t.id).channel.volume.value;
    if (Math.abs(parked + 20) > 2) return 'parked volume ' + parked;
    // Rendered, the level rises across the ramp; pan automation moves it left to right.
    const { renderProject } = await import('./engine/engine.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 12, tail: 0 });
    const spb = 60 / store.project.bpm;
    const rms = (b, beat, ch = 0) => { const d = b.getChannelData(ch), a = Math.floor(beat * spb * b.sampleRate), n = Math.floor(0.2 * b.sampleRate); let e = 0; for (let i = a; i < a + n; i++) e += d[i] * d[i]; return Math.sqrt(e / n); };
    const early = rms(buf, 1), mid = rms(buf, 4), late = rms(buf, 9);
    if (!(early < mid && mid < late && late > early * 10)) return 'volume ramp ' + [early, mid, late].map(v => v.toFixed(4));
    store.update(() => { t.automation = { pan: [{ t: 0, v: -1 }, { t: 8, v: 1 }] }; });
    const pb = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 12, tail: 0 });
    const leftEarly = rms(pb, 1, 0) / (rms(pb, 1, 1) + 1e-9), leftLate = rms(pb, 9, 0) / (rms(pb, 9, 1) + 1e-9);
    // Starting playback partway through also picks up the curve.
    const part = await renderProject(store.project, app.engine.audioPool, { start: 6, end: 10, tail: 0 });
    const ratioPart = rms(part, 0, 0) / (rms(part, 0, 1) + 1e-9);
    return leftEarly > 5 && leftLate < 0.2 && ratioPart < 1 ? 'ok volume ' + early.toFixed(3) + ' -> ' + late.toFixed(3) + ', pan L/R ' + leftEarly.toFixed(1) + ' -> ' + leftLate.toFixed(2) : 'pan ' + leftEarly + ' ' + leftLate + ' part ' + ratioPart;`);

  await new Promise(r => setTimeout(r, 200));
  await shot('18-automation');

  await check('sustain pedal: held notes last until the pedal lifts', `
    store.dirty = false;
    await app.newSong();
    const t = app.addTrack('instrument', 'grand-piano', 'Pedal');
    app.countIn = false;
    app.seek(0);
    await app.toggleRecord();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(200);
    app.setSustain(true);
    app.noteOn(60, 0.8); await wait(150); app.noteOff(60);     // released by hand, held by the pedal
    app.noteOn(64, 0.8); await wait(150); app.noteOff(64);
    await wait(700);
    app.noteOn(60, 0.8); await wait(100); app.noteOff(60);     // re-strike while held: new note
    await wait(300);
    app.setSustain(false);                                      // pedal up: both held notes end
    app.noteOn(67, 0.8); await wait(300);                       // still down when Stop is pressed
    await app.stop();
    const notes = t.regions.at(-1)?.notes || [];
    const spb = 60 / store.project.bpm;
    const by = n => notes.filter(x => x.n === n).sort((a, b) => a.t - b.t);
    const [c1, c2] = by(60), [e] = by(64), [g] = by(67);
    if (!c1 || !c2 || !e || !g) return 'notes ' + JSON.stringify(notes.map(x => [x.n, x.t.toFixed(2), x.d.toFixed(2)]));
    const secs = x => x.d * spb;
    // First C is cut when it is re-struck; E rings until the pedal lifts; G ends at Stop, not as a blip.
    const ok = secs(c1) > 0.8 && Math.abs(c1.t + c1.d - c2.t) < 0.05 && secs(e) > 1.1 && secs(g) > 0.2;
    return ok ? 'ok C ' + secs(c1).toFixed(2) + 's (re-struck), E ' + secs(e).toFixed(2) + 's (pedal), G ' + secs(g).toFixed(2) + 's (held at Stop)' : JSON.stringify(notes.map(x => [x.n, x.t.toFixed(2), secs(x).toFixed(2)]));`);

  await check('piano roll follows the selected track and region', `
    store.dirty = false;
    await app.newSong();
    const a = app.addTrack('instrument', 'grand-piano', 'Piano A');
    app.createEmptyRegion(a, 0);
    const b = app.addTrack('instrument', 'electric-piano', 'Keys B');
    app.createEmptyRegion(b, 4);
    const c = app.addTrack('instrument', 'warm-pad', 'Empty Pad');
    const regionOf = () => store.findRegion(app.editor.regionId)?.track.name;
    app.arrange.selectTrack(a.id);
    if (regionOf() !== 'Piano A') return 'select A -> ' + regionOf();
    app.arrange.selectTrack(b.id);
    if (regionOf() !== 'Keys B') return 'select B -> ' + regionOf();
    store.ui.selectedRegions = new Set([a.regions[0].id]); store.ui.selectedTrack = a.id; app.refresh();
    if (regionOf() !== 'Piano A') return 'click region A -> ' + regionOf();
    app.arrange.selectTrack(c.id);
    const text = document.querySelector('#bottom-body').textContent;
    return app.editor.regionId === null && text.includes('Empty Pad has no regions') ? 'ok' : 'empty track shows: ' + text;`);

  await check('recording shows a live clip', `
    const t = store.project.tracks.find(t => t.name === 'Keys B');
    store.ui.selectedTrack = t.id;
    app.countIn = false;
    app.seek(8);
    await app.toggleRecord();
    await new Promise(r => setTimeout(r, 300));
    app.noteOn(60, .8); await new Promise(r => setTimeout(r, 400));
    app.noteOn(64, .8); await new Promise(r => setTimeout(r, 400));
    const live = document.querySelector('.track[data-id="' + t.id + '"] .region.recording');
    const w1 = live ? live.offsetWidth : 0;
    await new Promise(r => setTimeout(r, 500));
    const w2 = live ? live.offsetWidth : 0;
    app.noteOff(60); app.noteOff(64);
    await app.stop();
    const leftover = document.querySelector('.region.recording');
    const rec = t.regions.find(r => r.name === 'Recording');
    if (!live) return 'no live clip while recording';
    return w2 > w1 && !leftover && rec?.notes.length === 2 ? 'ok live clip grew ' + w1 + '->' + w2 + 'px, then became a region with 2 notes' : 'w ' + w1 + '/' + w2 + ' leftover ' + !!leftover + ' notes ' + rec?.notes.length;`);

  await check('audio recording shows a live waveform', `
    const t = app.addTrack('audio', null, 'Mic');
    store.ui.selectedTrack = t.id;
    app.seek(16);
    await app.toggleRecord();
    await new Promise(r => setTimeout(r, 1200));
    const live = document.querySelector('.track[data-id="' + t.id + '"] .region.recording canvas');
    let inked = 0;
    if (live) { const d = live.getContext('2d').getImageData(0, 0, live.width, live.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) inked++; }
    await app.stop();
    return live && inked > 50 ? 'ok ' + inked + ' waveform pixels' : 'live ' + !!live + ' inked ' + inked;`);

  await js(`const t = store.project.tracks[0]; Object.assign(t, { eqLow: 5, eqMid: -3, eqHigh: 4 }); store.ui.selectedTrack = t.id; app.bottomMode = 'smart'; app.refresh();`);
  await new Promise(r => setTimeout(r, 400));
  await shot('10-eq');
  await js(`app.library.expanded.add('Waves'); app.library.show('samples'); document.querySelector('#library-body').scrollTop = 0;`);
  await new Promise(r => setTimeout(r, 400));
  await shot('11-fx-samples');
  await js(`app.openEditor(store.project.tracks[0].regions[0].id); app.library.show('band');`);
  await new Promise(r => setTimeout(r, 400));
  await shot('06-flows-drum-editor');
  await js(`const t = store.project.tracks.find(t => t.instrument === 'electric-piano'); app.openEditor(t.regions[0].id); app.toggleTyping();`);
  await new Promise(r => setTimeout(r, 400));
  await shot('07-flows-pianoroll-typing');

  console.log('\n' + results.join('\n'));
  app.quit();
};
