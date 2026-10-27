// Headless end-to-end check: BB_SMOKE=test/smoke.cjs xvfb-run -a npx electron .
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function smoke(win, app) {
  const out = path.join(__dirname, '..', 'dist', 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  try {
    await wait(1500);
    await shot('01-empty');
    console.log('steps:', await js(`(async () => {
      const app = window.app, store = window.store;
      app.createBand({ style: 'pop', progression: 'I | V | vi | IV', bars: 8, parts: ['drums','bass','keys','guitar','pad','arp'], complexity: 0.5, intensity: 0.6, setTempo: true });
      await app.engine.whenLoaded();
      const tracks = store.project.tracks.map(t => t.name + ':' + t.regions[0].notes.length);
      return JSON.stringify(tracks);
    })()`));
    await wait(500);
    await shot('02-band');
    console.log('play:', await js(`(async () => {
      await window.app.togglePlay();
      await new Promise(r => setTimeout(r, 2500));
      const pos = window.app.engine.position();
      await window.app.stop();
      return pos.toFixed(2);
    })()`));
    console.log('render:', await js(`(async () => {
      const { renderProject } = await import('./engine/engine.js');
      const p = window.store.project;
      const buf = await renderProject(p, window.app.engine.audioPool, { start: 0, end: 16 });
      const stats = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c); let peak = 0, sum = 0;
        for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i]*d[i]; }
        stats.push({ peak: peak.toFixed(3), rms: Math.sqrt(sum / d.length).toFixed(3) });
      }
      return JSON.stringify({ seconds: buf.duration.toFixed(2), stats });
    })().catch(e => 'ERROR ' + e.stack)`));
    await js(`(() => { const r = window.store.project.tracks[2].regions[0]; window.app.openEditor(r.id); })()`);
    await wait(400);
    await shot('03-editor');
    await js(`(() => { window.store.ui.selectedTrack = window.store.project.tracks[0].id; window.store.ui.selectedRegions = new Set([window.store.project.tracks[0].regions[0].id]); window.app.bottomMode = 'smart'; window.app.refresh(); window.app.library.show('loops'); })()`);
    await wait(400);
    await shot('04-smart-loops');
    await js(`(() => { window.app.openEditor(window.store.project.tracks[0].regions[0].id); window.app.library.show('samples'); })()`);
    await wait(400);
    await shot('05-drums-samples');
    await js(`(async () => { window.app.library.show('band'); window.app.createBand({ style: 'jazz', progression: 'ii7 | V7 | Imaj7 | VI7', bars: 8, parts: ['drums','bass','keys'], complexity: 0.6, intensity: 0.5, setTempo: true }); const t = window.store.project.tracks.find(t => t.instrument === 'upright-bass'); window.store.ui.selectedTrack = t.id; window.store.ui.selectedRegions = new Set([t.regions.at(-1).id]); window.app.bottomMode = 'smart'; window.app.refresh(); })()`);
    await wait(800);
    await shot('08-jazz-band-tab');
  } catch (err) {
    console.error('SMOKE FAILED', err);
  }
  app.quit();
};
