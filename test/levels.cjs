// Renders each instrument alone and prints its loudness, to balance preset volumes.
// A report rather than a test: run with `npm run levels`.
module.exports = async function levels(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  await new Promise(r => setTimeout(r, 1200));
  await js(`(() => { const w = console.warn; console.warn = (...a) => { if (a.join(' ').includes('scheduled callbacks')) console.log('WARN TRACE ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 12).join(' | ')); w(...a); }; })()`);
  const result = await js(`(async () => {
    const { renderProject } = await import('./engine/engine.js');
    const { INSTRUMENTS } = await import('./engine/instruments.js');
    const { newProject, newTrack } = await import('./state.js');
    const rows = [];
    for (const inst of INSTRUMENTS) {
      const p = newProject();
      p.bpm = 120;
      const kit = inst.type === 'kit';
      const t = newTrack(kit ? 'drums' : 'instrument', inst.id);
      t.volume = 0; t.reverb = 0;
      const notes = kit
        ? [0,1,2,3,4,5,6,7].flatMap(b => [{ t: b/2, d: .25, n: 42, v: .8 }, ...(b%4===0 ? [{ t: b/2, d: .25, n: 36, v: .8 }] : []), ...(b%4===2 ? [{ t: b/2, d: .25, n: 38, v: .8 }] : [])])
        : [{ t: 0, d: 2, n: 60, v: .8 }, { t: 0, d: 2, n: 64, v: .8 }, { t: 0, d: 2, n: 67, v: .8 }, { t: 2, d: 1, n: 48, v: .8 }, { t: 3, d: 1, n: 72, v: .8 }];
      if (inst.cat === 'Bass') notes.forEach(n => n.n -= 24);
      t.regions.push({ id: 'r', start: 0, length: 4, loopLength: 4, notes });
      p.tracks.push(t);
      try {
        const buf = await renderProject(p, new Map(), { start: 0, end: 4, tail: 0.5 });
        const d = buf.getChannelData(0); let peak = 0, sum = 0;
        for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i]*d[i]; }
        const rms = Math.sqrt(sum / d.length);
        rows.push([inst.id, (20*Math.log10(rms)).toFixed(1), (20*Math.log10(peak)).toFixed(1)].join('\\t'));
      } catch (e) { rows.push(inst.id + '\\tERROR ' + e.message); }
    }
    return rows.join('\\n');
  })()`);
  console.log('instrument\trmsDb\tpeakDb\n' + result);
  app.quit();
};
