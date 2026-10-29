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
  // A dark-sounding cabinet IR (one-pole low-pass at ~700 Hz) for the IR test, written as a WAV.
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
    // The real save format: recordings are stored as FLAC inside the song file.
    const used = store.project.tracks.flatMap(t => t.regions.map(r => r.audioId).filter(Boolean));
    const data = app.serializeSong();
    const file = JSON.parse(data);
    const wavBytes = used.reduce((n, id) => { const b = app.engine.audioPool.get(id); return n + b.length * b.numberOfChannels * 2; }, 0);
    const flacBytes = Object.values(file.audio).reduce((n, b64) => n + b64.length * 0.75, 0);
    const { fromBase64 } = await import('./engine/wav.js');
    for (const id of used) {
      const back = await Tone.getContext().rawContext.decodeAudioData(fromBase64(file.audio[id]));
      const orig = app.engine.audioPool.get(id);
      if (Math.abs(back.duration - orig.duration) > 0.01) return 'duration ' + back.duration + ' vs ' + orig.duration;
    }
    return file.version === 2 && file.project.tracks.length === store.project.tracks.length ? 'ok ' + used.length + ' audio clips as FLAC (' + Math.round(flacBytes / 1024) + ' KB vs ' + Math.round(wavBytes / 1024) + ' KB WAV)' : 'mismatch';`);

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
    if (options.length !== 7 || !options.includes('midi')) return 'formats ' + options;
    const { renderProject } = await import('./engine/engine.js');
    const { encodeAudio } = await import('./engine/export.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 8, sampleRate: 44100 });
    const sizes = {};
    for (const id of options.filter(o => o !== 'midi')) {
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

  await check('MIDI import and export round trip', `
    store.dirty = false;
    await app.newSong();
    const { writeMidi, parseMidi } = await import('./music/midifile.js');
    const { songEnd } = await import('./engine/engine.js');
    const src = writeMidi({ bpm: 87, timeSig: { num: 3, den: 4 }, tracks: [
      { name: 'Strings', program: 48, notes: [{ t: 0, d: 3, n: 55, v: 0.6 }, { t: 3, d: 3, n: 57, v: 0.6 }] },
      { name: 'Bass', program: 33, notes: [{ t: 0, d: 1, n: 43, v: 0.9 }, { t: 3, d: 1, n: 45, v: 0.9 }] },
      { name: 'Kit', drums: true, notes: [{ t: 0, d: 0.25, n: 36, v: 1 }, { t: 1, d: 0.25, n: 42, v: 0.7 }] },
    ] });
    app.importMidi(src.buffer, 'test.mid');
    const p = store.project;
    if (p.bpm !== 87 || p.timeSig.num !== 3) return 'tempo/meter ' + p.bpm + ' ' + JSON.stringify(p.timeSig);
    const kinds = p.tracks.map(t => t.name + ':' + t.type + ':' + t.instrument).join(', ');
    if (!kinds.includes('Strings:instrument:strings') || !kinds.includes('Bass:instrument:electric-bass') || !kinds.includes('Kit:drums:kit-rock')) return 'tracks ' + kinds;
    const out = parseMidi(app.exportMidi({ start: 0, end: songEnd(p) }).buffer);
    const notes = out.tracks.flatMap(t => t.notes.map(n => n.n + '@' + n.t)).sort().join(' ');
    return out.bpm === 87 && notes === '36@0 42@1 43@0 45@3 55@0 57@3' && out.tracks.find(t => t.drums) ? 'ok ' + kinds : 'export ' + out.bpm + ' ' + notes;`);

  await check('audio keeps playing through mixer changes and edits', `
    store.dirty = false;
    await app.newSong();
    const rate = 44100, secs = 6;
    const tone = new AudioBuffer({ length: rate * secs, sampleRate: rate, numberOfChannels: 1 });
    const d = tone.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * 220 * i / rate) * 0.4;
    app.addAudioBuffer(tone, 'Tone', null, 0);
    const keys = app.addTrack('instrument', 'chip', 'Keys');
    const t = store.project.tracks.find(x => x.type === 'audio');
    await app.engine.whenLoaded();
    app.seek(0);
    await app.togglePlay();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const meter = () => { const m = app.engine.nodes.get(t.id).meter.getValue(); return typeof m === 'number' ? m : Math.max(...m); };
    const state = () => ({ sources: app.engine.audioSources.size, level: meter() });
    await wait(400);
    const before = state();
    store.update(() => { t.volume = -8; });           // knob-style mixer change
    await wait(250);
    store.update(() => { t.reverb = 0.5; t.echo = 0.3; });
    await wait(400);
    const afterMixer = state();
    store.update(() => { keys.regions.push({ id: 'k', start: 0, length: 8, loopLength: 8, notes: [{ t: 6, d: 1, n: 60, v: 0.8 }] }); }); // forces a re-plan
    await wait(500);
    const afterEdit = state();
    await app.stop();
    const ok = s => s.sources === 1 && s.level > -50;
    return ok(before) && ok(afterMixer) && ok(afterEdit) ? 'ok one source playing throughout (' + [before, afterMixer, afterEdit].map(s => s.level.toFixed(0) + ' dB').join(', ') + ')' : JSON.stringify({ before, afterMixer, afterEdit });`);

  await check('cycle: starting mid-loop still plays the notes before the start on repeats', `
    store.dirty = false;
    await app.newSong();
    store.update(p => { p.bpm = 240; p.cycle = { on: true, start: 0, end: 4 }; });
    const t = app.addTrack('instrument', 'chip', 'Loop');
    store.update(() => { t.regions.push({ id: 'c', start: 0, length: 4, loopLength: 4, notes: [{ t: 0, d: 0.5, n: 60, v: 0.8 }, { t: 1, d: 0.5, n: 62, v: 0.8 }, { t: 3, d: 0.5, n: 67, v: 0.8 }] }); });
    await app.engine.whenLoaded();
    const inst = app.engine.nodes.get(t.id).instrument;
    const heard = [];
    const orig = inst.play.bind(inst);
    inst.play = (n, ...rest) => { heard.push(n); return orig(n, ...rest); };
    app.seek(2);
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 2300));   // 1 s per pass: the tail of pass 1, then two full repeats
    await app.stop();
    store.update(p => { p.cycle.on = false; });
    const count = n => heard.filter(x => x === n).length;
    return count(60) >= 2 && count(62) >= 2 && count(67) >= 2 ? 'ok heard ' + heard.join(',') : 'heard ' + heard.join(',');`);

  await check('audio follows tempo changes (time-stretch)', `
    store.dirty = false;
    await app.newSong();
    store.update(p => { p.bpm = 120; });
    // A click on each of 8 beats at 120 bpm (0.5 s apart).
    const rate = 44100;
    const clip = new AudioBuffer({ length: rate * 4, sampleRate: rate, numberOfChannels: 1 });
    for (let b = 0; b < 8; b++) { const i = Math.round(b * 0.5 * rate); for (let k = 0; k < 400; k++) clip.getChannelData(0)[i + k] = Math.sin(k * 0.25) * 0.8 * (1 - k / 400); }
    app.addAudioBuffer(clip, 'Clicks', null, 0);
    const t = store.project.tracks.find(x => x.type === 'audio'), r = t.regions[0];
    if (r.bpm !== 120) return 'region bpm ' + r.bpm;
    store.update(p => { p.bpm = 90; });
    const { renderProject } = await import('./engine/engine.js');
    await app.engine.prepareAudio(store.project);
    const render = () => renderProject(store.project, app.engine.audioPool, { start: 0, end: 8, tail: 0.2, bufferFor: app.engine.bufferFor });
    // Where each click lands (strongest peak near each expected time).
    const clickAt = (buf, sec) => { const d = buf.getChannelData(0), sr = buf.sampleRate; let m = 0, w = 0; for (let i = Math.max(0, Math.round((sec - 0.12) * sr)); i < Math.round((sec + 0.12) * sr); i++) if (Math.abs(d[i]) > m) { m = Math.abs(d[i]); w = i; } return { sec: w / sr, peak: m }; };
    const stretched = await render();
    const spb90 = 60 / 90;
    const errs = [1, 2, 3, 4, 5, 6, 7].map(b => { const c = clickAt(stretched, b * spb90); return { off: Math.abs(c.sec - b * spb90), peak: c.peak }; });
    if (errs.some(e => e.off > 0.03 || e.peak < 0.1)) return 'stretched clicks ' + JSON.stringify(errs.map(e => [e.off.toFixed(3), e.peak.toFixed(2)]));
    if (Math.abs(r.length - 8) > 1e-6) return 'region length changed ' + r.length;
    // Follow tempo off: clicks keep their original 0.5 s spacing.
    store.update(() => { r.followTempo = false; });
    const fixed = await render();
    const fixedErr = [1, 2, 3].map(b => Math.abs(clickAt(fixed, b * 0.5).sec - b * 0.5));
    if (fixedErr.some(e => e > 0.01)) return 'unstretched clicks ' + fixedErr;
    store.update(() => { r.followTempo = true; });
    // Live playback uses the stretched clip.
    await app.togglePlay();
    const used = app.engine.bufferFor(r);
    await app.stop();
    return used.factor > 1.3 ? 'ok clicks on every 90 bpm beat (max error ' + Math.max(...errs.map(e => e.off * 1000)).toFixed(1) + ' ms), factor ' + used.factor.toFixed(3) : 'live factor ' + used.factor;`);

  await check('tempo changes: playback, export, LCD and MIDI follow the tempo map', `
    store.dirty = false;
    await app.newSong();
    store.update(p => { p.bpm = 120; p.tempoChanges = [{ beat: 8, bpm: 60 }]; });
    const t = app.addTrack('drums', 'kit-808', 'Beat');
    store.update(() => { t.reverb = 0; t.regions.push({ id: 'b', start: 0, length: 16, loopLength: 16, notes: Array.from({ length: 16 }, (_, b) => ({ t: b, d: 0.25, n: 36, v: 1 })) }); });
    const { renderProject } = await import('./engine/engine.js');
    const { secAt } = await import('./music/tempo.js');
    const buf = await renderProject(store.project, app.engine.audioPool, { start: 0, end: 16, tail: 0.5 });
    // Kicks every 0.5 s for 8 beats, then every 1 s.
    const onsetNear = sec => { const d = buf.getChannelData(0), sr = buf.sampleRate; for (let i = Math.round((sec - 0.06) * sr); i < (sec + 0.1) * sr; i++) if (Math.abs(d[i]) > 0.05) return i / sr; return null; };
    const errs = [2, 6, 8, 9, 12, 15].map(b => { const o = onsetNear(secAt(store.project, b)); return o == null ? 99 : Math.abs(o - secAt(store.project, b)); });
    if (errs.some(e => e > 0.012)) return 'kick timing ' + errs.map(e => e.toFixed(3));
    if (Math.abs(buf.duration - (4 + 8 + 0.5)) > 0.05) return 'export length ' + buf.duration;
    // The LCD shows the tempo where the playhead is; editing it edits that section.
    app.seek(10); app.showTempo();
    if (document.querySelector('#lcd-bpm').value !== '60') return 'lcd ' + document.querySelector('#lcd-bpm').value;
    const lcd = document.querySelector('#lcd-bpm'); lcd.value = 70; lcd.dispatchEvent(new Event('change'));
    if (store.project.tempoChanges[0].bpm !== 70 || store.project.bpm !== 120) return 'lcd edit ' + JSON.stringify(store.project.tempoChanges);
    // A marker shows in the ruler.
    if (!document.querySelector('.tempo-marker')) return 'no marker';
    // Live: the transport switches tempo as it passes the change.
    app.seek(6);
    await app.togglePlay();
    await new Promise(r => setTimeout(r, 1500));
    const live = app.engine.transport.bpm.value;
    await app.stop();
    if (Math.abs(live - 70) > 0.5) return 'live tempo ' + live;
    // MIDI keeps the tempo change.
    const { parseMidi } = await import('./music/midifile.js');
    const m = parseMidi(app.exportMidi({ start: 0, end: 16 }).buffer);
    const tempos = m.tempos.map(x => x.beat + '@' + Math.round(x.bpm)).join(',');
    return tempos === '0@120,8@70' ? 'ok kicks on time across the change (max ' + Math.max(...errs.map(e => e * 1000)).toFixed(1) + ' ms), live 120 -> ' + live.toFixed(0) + ', MIDI ' + tempos : 'midi tempos ' + tempos;`);

  await new Promise(r => setTimeout(r, 200));
  await shot('19-tempo');

  await check('amp: new models and cabinet impulse responses', `
    store.dirty = false;
    await app.newSong();
    const { renderProject } = await import('./engine/engine.js');
    const { newProject, newTrack } = await import('./state.js');
    const { defaultAmp, irBuffers } = await import('./engine/amp.js');
    const rate = 44100, n = rate * 2;
    const di = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
    const d = di.getChannelData(0);
    for (let i = 0; i < n; i++) { const t = i / rate; let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 82.4 * h * t) * 0.3 / h * Math.exp(-t * 1.2); d[i] = v; }
    const pool = new Map([['di', di]]);
    const render = amp => {
      const p = newProject(); p.bpm = 120;
      const t = Object.assign(newTrack('audio', null, 'G'), { reverb: 0, amp });
      t.regions.push({ id: 'r', start: 0, length: 4, offset: 0, audioId: 'di' });
      p.tracks.push(t);
      return renderProject(p, pool, { start: 0, end: 4, tail: 0.1 });
    };
    const ratio = async buf => {
      const total = (() => { const x = buf.getChannelData(0); let e = 0; for (let i = 4410; i < 66150; i++) e += x[i] * x[i]; return Math.sqrt(e / 61740); })();
      const hp = await Tone.Offline(() => { const pl = new Tone.Player(buf); pl.chain(new Tone.Filter({ type: 'highpass', frequency: 2500, rolloff: -48 }), Tone.getDestination()); pl.start(0); }, buf.duration);
      const x = hp.getChannelData(0); let e = 0; for (let i = 4410; i < 66150; i++) e += x[i] * x[i];
      return { total, bright: Math.sqrt(e / 61740) / total };
    };
    const vintage = await ratio(await render({ ...defaultAmp('vintage'), gate: 0 }));
    const metal = await ratio(await render({ ...defaultAmp('metal'), gate: 0 }));
    if (!(vintage.total > 0.01 && metal.total > 0.01 && metal.bright > vintage.bright * 1.5)) return 'models ' + JSON.stringify({ vintage, metal });
    // Load the IR through the real path, then compare the same amp with a built-in cabinet and the IR.
    const path = '/tmp/basement-band-test-ir/dark-cab.wav';
    await app.engine.loadIR(path);
    if (!irBuffers.has(path)) return 'IR not loaded';
    const builtIn = await ratio(await render({ ...defaultAmp('crunch'), gate: 0, cab: 'closed412' }));
    const withIr = await ratio(await render({ ...defaultAmp('crunch'), gate: 0, cab: 'ir', ir: { path, name: 'dark-cab' } }));
    const missing = await ratio(await render({ ...defaultAmp('crunch'), gate: 0, cab: 'ir', ir: { path: '/nope/missing.wav', name: 'gone' } }));
    if (!(withIr.total > 0.005 && withIr.bright < builtIn.bright * 0.5)) return 'IR effect ' + JSON.stringify({ builtIn, withIr });
    return Math.abs(missing.bright - (await ratio(await render({ ...defaultAmp('crunch'), gate: 0 }))).bright) < 0.02
      ? 'ok metal brighter than vintage (' + metal.bright.toFixed(3) + ' vs ' + vintage.bright.toFixed(3) + '), IR darkens the cab (' + withIr.bright.toFixed(3) + ' vs ' + builtIn.bright.toFixed(3) + '), missing IR falls back'
      : 'missing IR fallback ' + missing.bright;`);

  await check('song sections: duplicate, delete, loop, with everything after moving along', `
    store.dirty = false;
    await app.newSong();
    const { expandRegion } = await import('./engine/engine.js');
    const { sections } = await import('./arrangement.js');
    const drums = app.addTrack('drums', 'kit-rock', 'Drums');
    const keys = app.addTrack('instrument', 'grand-piano', 'Keys');
    store.update(p => {
      drums.regions.push({ id: 'd', start: 0, length: 16, loopLength: 4, notes: [{ t: 0, d: 0.25, n: 36, v: 1 }, { t: 2, d: 0.25, n: 38, v: 1 }] });
      keys.regions.push({ id: 'k', start: 4, length: 8, loopLength: 8, notes: [{ t: 0, d: 2, n: 60, v: 0.8 }, { t: 5, d: 2, n: 64, v: 0.8 }] }); // crosses bar 3
      keys.automation = { volume: [{ t: 10, v: -12 }] };
      p.tempoChanges = [{ beat: 12, bpm: 90 }];
    });
    app.seek(0); app.addSectionAtPlayhead();
    app.seek(8); app.addSectionAtPlayhead();
    let secs = sections(store.project);
    if (secs.map(s => s.name + ':' + s.start + '-' + s.end).join(',') !== 'Intro:0-8,Verse:8-16') return 'sections ' + JSON.stringify(secs);
    if (!document.querySelector('.section-block')) return 'no blocks drawn';
    const notesIn = (a, b, shift = 0) => store.project.tracks.flatMap(t => t.regions.flatMap(r => expandRegion(r)).filter(n => n.t >= a && n.t < b).map(n => t.name + n.n + '@' + (n.t - shift))).sort().join(' ');
    const verse = notesIn(8, 16);
    // Duplicate the Verse: a copy at 16-24, everything later (nothing yet) moves along.
    const { duplicateSection, deleteSection } = await import('./arrangement.js');
    store.update(p => duplicateSection(p, secs[1]));
    secs = sections(store.project);
    if (secs.map(s => s.name + ':' + s.start).join(',') !== 'Intro:0,Verse:8,Verse:16') return 'after duplicate ' + secs.map(s => s.name + ':' + s.start);
    if (notesIn(16, 24, 8) !== verse) return 'copy differs: ' + notesIn(16, 24, 8) + ' vs ' + verse;
    if (!store.project.tempoChanges.some(c => c.beat === 20) || !keys.automation.volume.some(p => p.t === 18)) return 'tempo/automation not copied ' + JSON.stringify([store.project.tempoChanges, keys.automation]);
    // Delete the Intro: everything moves up 8 beats.
    store.update(p => deleteSection(p, sections(p)[0]));
    secs = sections(store.project);
    if (secs.map(s => s.name + ':' + s.start).join(',') !== 'Verse:0,Verse:8') return 'after delete ' + secs.map(s => s.name + ':' + s.start);
    if (notesIn(0, 8) !== verse.split(' ').map(x => x.replace(/@([0-9.]+)$/, (m, t) => '@' + (Number(t) - 8))).sort().join(' ')) return 'shifted notes ' + notesIn(0, 8);
    if (store.project.tempoChanges.map(c => c.beat).sort((a, b) => a - b).join(',') !== '4,12') return 'tempo after delete ' + JSON.stringify(store.project.tempoChanges);
    // Loop a section.
    app.sectionMenu(0, 0, secs[1]);
    [...document.querySelectorAll('#menu button')].find(b => b.textContent.startsWith('Loop')).click();
    const c = store.project.cycle;
    if (!(c.on && c.start === 8 && c.end === 16)) return 'loop ' + JSON.stringify(c);
    // Undo brings the Intro back.
    store.undo(); store.undo();
    return sections(store.project).length === 3 ? 'ok duplicate copies notes, tempo and automation; delete closes the gap; loop; undo' : 'undo ' + sections(store.project).length;`);

  await new Promise(r => setTimeout(r, 200));
  await shot('20-sections');

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
