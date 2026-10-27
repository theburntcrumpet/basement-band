// Smart Controls: channel knobs for the selected track, plus Drummer/band controls for generated regions.

import { h, knob, drag, canvas2d } from './dom.js';
import { EQ_BANDS, EQ_RANGE, response } from '../engine/eq.js';
import { EFFECTS, defaultFx } from '../engine/effects.js';
import { AMP_MODELS, AMP_KNOBS, defaultAmp } from '../engine/amp.js';
import { store, regenerate } from '../state.js';
import { STYLES, PARTS, PART_LABELS } from '../music/band.js';
import { getInstrument } from '../engine/instruments.js';
import { parseProgression } from '../music/theory.js';

export class SmartControls {
  constructor(app, body, tools) {
    this.app = app;
    this.body = body;
    this.tools = tools;
  }

  render() {
    const track = store.selectedTrack;
    this.tools.replaceChildren();
    if (!track) {
      this.body.replaceChildren(h('div', { class: 'editor-placeholder' }, 'Select a track to see its controls.'));
      return;
    }
    const live = (key, v) => { track[key] = v; this.app.engine.sync(store.project); };
    const k = (label, key, opts = {}) => knob({
      label, value: track[key] ?? opts.def ?? 0, ...opts,
      onStart: () => store.beginGesture(),
      onInput: v => live(key, v),
      onCommit: () => store.endGesture(),
    });

    const channel = h('div', {},
      h('h3', {}, track.type === 'audio' ? 'Audio Track' : getInstrument(track.instrument).name),
      h('div', { class: 'knobs' },
        k('Volume', 'volume', { min: -40, max: 6, center: -4, format: v => v.toFixed(1) + ' dB' }),
        k('Pan', 'pan', { min: -1, max: 1, center: 0, format: v => Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100) }),
        k('Tone', 'tone', { def: 1, center: 1 }),
        k('Drive', 'drive', { center: 0 }),
        k('Reverb', 'reverb', { center: 0.2 }),
        k('Echo', 'echo', { center: 0 }),
      ),
    );

    const sync = () => this.app.engine.sync(store.project);
    const sections = [channel, this.eqSection(track, live), fxPanel(() => track.fx, v => { track.fx = v; }, sync)];
    const guitarish = track.type === 'audio' || ['Guitar', 'Bass'].includes(getInstrument(track.instrument).cat);
    if (guitarish) sections.unshift(this.ampSection(track, sync));
    if (track.type === 'audio') sections.unshift(this.inputSection(track));
    const region = this.selectedGenRegion(track);
    if (region) sections.push(this.genControls(track, region));
    else if (track.type !== 'audio') {
      sections.push(h('div', { class: 'lib-note', style: { maxWidth: '260px' } },
        track.type === 'drums'
          ? 'Tip: select a Drummer region to change its style, complexity and loudness here.'
          : 'Tip: pick a different sound for this track in the Library → Sounds tab.'));
    }
    this.body.replaceChildren(h('div', { class: 'smart' }, ...sections));
  }

  // Bass / Mid / Treble with a response curve that redraws as you turn the knobs.
  eqSection(track, live) {
    const curve = h('canvas', { class: 'eq-curve', title: 'EQ response (20 Hz – 20 kHz, ±12 dB)' });
    const draw = () => drawEq(curve, track);
    const knobs = EQ_BANDS.map(b => knob({
      label: b.label, value: track[b.key] || 0, min: -EQ_RANGE, max: EQ_RANGE, center: 0,
      format: v => (Math.abs(v) < 0.05 ? '0 dB' : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'),
      onStart: () => store.beginGesture(),
      onInput: v => { live(b.key, v); draw(); },
      onCommit: () => store.endGesture(),
    }));
    const flat = h('button', {
      class: 'text small-text', title: 'Reset the EQ to flat',
      onclick: () => store.update(() => { EQ_BANDS.forEach(b => { track[b.key] = 0; }); }),
    }, 'Flat');
    requestAnimationFrame(draw);
    return h('div', {},
      h('h3', { class: 'eq-title' }, 'EQ', flat),
      h('div', { class: 'eq-body' }, curve, h('div', { class: 'knobs' }, ...knobs)));
  }

  // Interface input: device, which input jack, monitoring, level and latency.
  inputSection(track) {
    const app = this.app;
    const monitoring = app.monitorTrack === track.id;
    const device = h('select', { class: 'wide-select', onchange: e => app.setInputDevice(e.target.value) },
      h('option', { value: '' }, 'Default input'));
    navigator.mediaDevices?.enumerateDevices().then(list => {
      for (const d of list.filter(x => x.kind === 'audioinput' && x.deviceId !== 'default')) {
        device.append(h('option', { value: d.deviceId, selected: d.deviceId === app.settings.inputDevice }, d.label || 'Audio input'));
      }
    });
    const channel = track.input?.channel || 'left';
    const channels = h('select', { class: 'wide-select', onchange: e => app.setInputChannel(track, e.target.value) },
      [['left', 'Input 1 (mono)'], ['right', 'Input 2 (mono)'], ['stereo', 'Inputs 1+2 (stereo)']].map(([v, l]) => h('option', { value: v, selected: v === channel }, l)));
    const info = app.engine.inputInfo();
    return h('div', { class: 'input-panel' },
      h('h3', {}, 'Input'),
      h('label', { class: 'field' }, h('span', {}, 'Interface'), device),
      h('label', { class: 'field' }, h('span', {}, 'Plugged into'), channels),
      h('div', { class: 'monitor-row' },
        h('button', { class: 'text' + (monitoring ? ' accent' : ''), onclick: () => app.toggleMonitor(track) }, monitoring ? '🎧 Monitoring' : '🎧 Monitor'),
        h('canvas', { id: 'input-meter', width: 120, height: 10, title: 'Input level — keep the peaks out of the red' })),
      h('label', { class: 'check', style: { marginTop: '8px' }, title: 'Uses the smallest audio buffers (takes effect after a restart) and, on Linux with PipeWire, asks for 128-frame blocks while monitoring. Can crackle on slower computers.' },
        h('input', { type: 'checkbox', checked: !!app.settings.lowLatency, onchange: e => app.setLowLatency(e.target.checked) }), 'Low-latency mode'),
      h('div', { class: 'lib-note', style: { padding: '6px 0 0' } },
        monitoring && info.open ? `${info.label || 'Input'} · about ${info.monitorLatencyMs} ms monitoring latency` : 'Use headphones while monitoring. Recordings are kept clean, so you can change the amp later.'));
  }

  ampSection(track, sync) {
    const amp = track.amp || { model: 'off' };
    const model = h('select', { class: 'wide-select', onchange: e => store.update(() => { track.amp = e.target.value === 'off' ? { model: 'off' } : { ...defaultAmp(e.target.value), cab: amp.cab ?? true }; }) },
      Object.entries(AMP_MODELS).map(([id, m]) => h('option', { value: id, selected: id === (amp.model || 'off') }, m.name)));
    const on = amp.model && amp.model !== 'off';
    const cab = h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: amp.cab !== false, disabled: !on, onchange: e => store.update(() => { track.amp = { ...track.amp, cab: e.target.checked }; }) }), 'Speaker cabinet');
    const knobs = on ? AMP_KNOBS.map(k => knob({
      label: k.label, value: amp[k.key] ?? k.def, center: k.def,
      onStart: () => store.beginGesture(),
      onInput: v => { track.amp = { ...track.amp, [k.key]: v }; sync(); },
      onCommit: () => store.endGesture(),
    })) : [];
    return h('div', { class: 'amp-panel' },
      h('h3', {}, 'Amp'),
      h('div', { class: 'amp-top' }, model, cab),
      on ? h('div', { class: 'knobs amp-knobs' }, ...knobs) : h('div', { class: 'lib-note' }, 'Pick Clean, Crunch, Lead or Bass to run this track through an amp.'));
  }

  // Effects on the whole mix (playback and export).
  renderMaster() {
    const p = store.project;
    this.tools.replaceChildren();
    const sync = () => this.app.engine.sync(p);
    this.body.replaceChildren(h('div', { class: 'smart' },
      fxPanel(() => p.masterFx, v => { p.masterFx = v; }, sync, 'Master Effect'),
      h('div', { class: 'lib-note', style: { maxWidth: '300px' } },
        'Master effects colour the whole song, in playback and in exports. Try Vinyl for an old-record feel, ',
        'Tape for warmth, Radio for a lo-fi intro, or Lo-Fi for crunchy beats. Crackle and hiss only play while the song does.')));
  }

  selectedGenRegion(track) {
    for (const id of store.ui.selectedRegions) {
      const r = track.regions.find(x => x.id === id);
      if (r?.gen) return r;
    }
    return track.regions.length === 1 && track.regions[0].gen ? track.regions[0] : null;
  }

  genControls(track, region) {
    const gen = region.gen;
    const key = store.project.key;
    const reroll = () => { regenerate(region, store.project); };
    const apply = fn => store.update(() => { fn(); reroll(); });

    const xy = h('div', { class: 'xy', title: 'Left/right: simple → complex • Down/up: soft → loud' },
      h('span', { class: 'lbl', style: { left: '8px', bottom: '6px' } }, 'Simple'),
      h('span', { class: 'lbl', style: { right: '8px', bottom: '6px' } }, 'Complex'),
      h('span', { class: 'lbl', style: { left: '8px', top: '6px' } }, 'Loud'),
      h('span', { class: 'lbl', style: { left: '8px', bottom: '24px' } }, 'Soft'));
    const dot = h('div', { class: 'dot' });
    xy.append(dot);
    const place = () => {
      dot.style.left = gen.complexity * 100 + '%';
      dot.style.top = (1 - gen.intensity) * 100 + '%';
    };
    place();
    const setFrom = ev => {
      const r = xy.getBoundingClientRect();
      gen.complexity = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      gen.intensity = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
      place();
    };
    xy.addEventListener('mousedown', e => {
      store.beginGesture();
      setFrom(e);
      drag(e, (_dx, _dy, ev) => setFrom(ev), () => { reroll(); store.endGesture(); });
    });

    const styleSel = h('select', { onchange: e => apply(() => { gen.style = e.target.value; region.name = `${STYLES[gen.style].name} ${PART_LABELS[gen.part]}`; }) },
      Object.entries(STYLES).map(([id, s]) => h('option', { value: id, selected: id === gen.style }, s.name)));
    const fields = [
      h('label', { class: 'field' }, h('span', {}, 'Style'), styleSel),
    ];
    if (gen.part === 'drums') {
      fields.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: gen.fills !== false, onchange: e => apply(() => { gen.fills = e.target.checked; }) }), 'Fills'));
    } else {
      const prog = h('input', { type: 'text', value: gen.progression || STYLES[gen.style].progression, onkeydown: e => e.stopPropagation() });
      prog.addEventListener('change', () => {
        try {
          parseProgression(prog.value, key);
          apply(() => { gen.progression = prog.value; });
        } catch (err) {
          prog.style.borderColor = 'var(--red)';
          prog.title = err.message;
        }
      });
      fields.push(h('label', { class: 'field' }, h('span', {}, 'Chords (e.g. "C G | Am F" or "I V vi IV")'), prog));
      fields.push(h('label', { class: 'field' }, h('span', {}, 'Part'),
        h('select', { onchange: e => apply(() => { gen.part = e.target.value; }) },
          PARTS.filter(p => p !== 'drums').map(p => h('option', { value: p, selected: p === gen.part }, PART_LABELS[p])))));
    }
    fields.push(h('button', { class: 'text', onclick: () => apply(() => { gen.seed = Math.floor(Math.random() * 1e6); }) }, '🎲 New Variation'));

    return h('div', { style: { display: 'flex', gap: '24px' } },
      h('div', {}, h('h3', {}, gen.part === 'drums' ? 'Drummer' : 'Session Player'), xy),
      h('div', { style: { width: '260px' } }, h('h3', {}, region.name || 'Region'), ...fields),
    );
  }
}

const EQ_FREQS = Array.from({ length: 120 }, (_, i) => 20 * Math.pow(1000, i / 119));

function drawEq(canvas, track) {
  const w = 200, ht = 86;
  const ctx = canvas2d(canvas, w, ht);
  const x = f => (Math.log10(f / 20) / 3) * w;
  const y = db => ht / 2 - (db / (EQ_RANGE + 3)) * (ht / 2);
  ctx.fillStyle = '#1a1c21';
  ctx.fillRect(0, 0, w, ht);
  ctx.strokeStyle = '#2f323a';
  ctx.lineWidth = 1;
  for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(x(f) + 0.5, 0); ctx.lineTo(x(f) + 0.5, ht); ctx.stroke(); }
  for (const db of [-12, -6, 6, 12]) { ctx.beginPath(); ctx.moveTo(0, y(db) + 0.5); ctx.lineTo(w, y(db) + 0.5); ctx.stroke(); }
  ctx.strokeStyle = '#4a4e58';
  ctx.beginPath(); ctx.moveTo(0, y(0) + 0.5); ctx.lineTo(w, y(0) + 0.5); ctx.stroke();
  ctx.fillStyle = '#6c707c';
  ctx.font = '9px system-ui, sans-serif';
  [[100, '100'], [1000, '1k'], [10000, '10k']].forEach(([f, l]) => ctx.fillText(l, x(f) + 3, ht - 4));
  const gains = response(track, EQ_FREQS);
  ctx.beginPath();
  gains.forEach((g, i) => (i ? ctx.lineTo(x(EQ_FREQS[i]), y(g)) : ctx.moveTo(x(EQ_FREQS[i]), y(g))));
  ctx.lineTo(w, y(0)); ctx.lineTo(0, y(0)); ctx.closePath();
  ctx.fillStyle = '#f0a63a22';
  ctx.fill();
  ctx.beginPath();
  gains.forEach((g, i) => (i ? ctx.lineTo(x(EQ_FREQS[i]), y(g)) : ctx.moveTo(x(EQ_FREQS[i]), y(g))));
  ctx.strokeStyle = '#f0a63a';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Effect type picker plus that effect's knobs, for a track or the master bus.
export function fxPanel(get, set, sync, title = 'Effect') {
  const cfg = get() || { type: 'none' };
  const def = EFFECTS[cfg.type] || EFFECTS.none;
  const picker = h('select', {
    class: 'wide-select',
    onchange: e => store.update(() => set(defaultFx(e.target.value))),
  }, Object.entries(EFFECTS).map(([id, fx]) => h('option', { value: id, selected: id === cfg.type }, fx.name)));
  const knobs = def.params.map(p => knob({
    label: p.label, value: cfg[p.key] ?? p.def, center: p.def,
    onStart: () => store.beginGesture(),
    onInput: v => { set({ ...get(), [p.key]: v }); sync(); },
    onCommit: () => store.endGesture(),
  }));
  return h('div', { class: 'fx-panel' },
    h('h3', {}, title),
    picker,
    knobs.length ? h('div', { class: 'knobs', style: { marginTop: '12px' } }, ...knobs) : h('div', { class: 'lib-note' }, 'Pick Vinyl, Tape, Radio or Lo-Fi.'));
}
