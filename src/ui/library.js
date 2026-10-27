// Library side panel: Sounds, Loops, Samples and the Session Band builder.

import { h, toast } from './dom.js';
import { store } from '../state.js';
import { INSTRUMENTS, CATEGORIES, builtinSamples } from '../engine/instruments.js';
import { STYLES, PARTS, PART_LABELS, PROGRESSION_PRESETS, generate, partInstrument } from '../music/band.js';
import { parseProgression } from '../music/theory.js';
import { meter, TIME_SIGNATURES } from '../music/meter.js';
import { getLibrary, entryDefs } from '../engine/user-instruments.js';
import { GEN_FX } from '../engine/fxgen.js';

const CAT_ICON = { Keyboards: '🎹', Bass: '🎸', Guitar: '🎸', Strings: '🎻', Brass: '🎺', Woodwinds: '🎷', Mallets: '🔔', Synth: '🎛️', 'Drum Kits': '🥁' };

// The loop library: every style × part, in simple and busy flavours. All MIDI, so they follow the song key.
export const LOOPS = Object.entries(STYLES).flatMap(([styleId, style]) =>
  PARTS.flatMap(part => {
    const flavours = part === 'drums' || part === 'bass' ? [['', 0.3], [' (Busy)', 0.9]] : [['', 0.5]];
    const bars = parseProgression(style.progression, { root: 0 }).reduce((m, c) => Math.max(m, c.start + c.length), 0) / 4;
    return flavours.map(([suffix, complexity]) => ({
      id: `${styleId}-${part}${suffix ? '-busy' : ''}`,
      name: `${style.name} ${PART_LABELS[part]}${suffix}`,
      style: styleId,
      part,
      bars: Math.max(4, bars),
      gen: { style: styleId, part, complexity, intensity: 0.6, seed: 1, progression: style.progression, fills: true },
      instrument: partInstrument(styleId, part),
    }));
  }));

export class Library {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.tab = 'sounds';
    this.loopFilter = { part: 'all', style: 'all', q: '' };
    this.stopPreview = null;
    this.previewId = null;
    this.userSamples = [];
    this.expanded = new Set(['Generated FX']);
    this.presetFilter = new Map();
    this.band = {
      style: 'pop',
      progression: STYLES.pop.progression,
      bars: 16,
      parts: new Set(STYLES.pop.parts),
      complexity: 0.5,
      intensity: 0.55,
      setTempo: true,
    };
    document.querySelectorAll('#library .tabs button').forEach(b => b.addEventListener('click', () => this.show(b.dataset.tab)));
  }

  show(tab) {
    this.tab = tab;
    document.querySelectorAll('#library .tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    this.render();
  }

  render() {
    const body = this.root;
    const scroll = body.scrollTop;
    if (this.tab === 'sounds') body.replaceChildren(this.renderSounds());
    else if (this.tab === 'loops') body.replaceChildren(this.renderLoops());
    else if (this.tab === 'samples') body.replaceChildren(this.renderSamples());
    else body.replaceChildren(this.renderBand());
    body.scrollTop = scroll;
  }

  // ------------------------------------------------------------ previews

  async togglePreview(id, start) {
    const wasPlaying = this.previewId === id;
    this.stopPreview?.();
    this.stopPreview = null;
    this.previewId = null;
    if (!wasPlaying) {
      this.previewId = id;
      this.render();
      try {
        this.stopPreview = await start();
      } catch (err) {
        toast('Could not play preview: ' + err.message);
        this.previewId = null;
      }
      if (this.previewId !== id) this.stopPreview?.();
    }
    this.render();
  }

  stopAllPreviews() {
    this.stopPreview?.();
    this.stopPreview = null;
    this.previewId = null;
  }

  // ------------------------------------------------------------ sounds

  renderSounds() {
    const track = store.selectedTrack;
    const wrap = h('div');
    if (!track) wrap.append(h('div', { class: 'lib-note' }, 'Click a sound to create a new track with it.'));
    else if (track.type === 'audio') wrap.append(h('div', { class: 'lib-note' }, 'Audio tracks play recordings and samples. Select an instrument track to change its sound, or click a sound to add a new track.'));
    wrap.append(this.renderMyInstruments(track));
    for (const cat of CATEGORIES) {
      const items = INSTRUMENTS.filter(i => i.cat === cat);
      wrap.append(h('div', { class: 'lib-section' },
        h('h4', {}, cat),
        items.map(inst => h('div', {
          class: 'lib-item' + (track?.instrument === inst.id ? ' on' : ''),
          draggable: true,
          ondragstart: e => e.dataTransfer.setData('application/x-bb', JSON.stringify({ kind: 'instrument', id: inst.id })),
          onclick: () => this.app.chooseInstrument(inst.id),
        },
        h('span', { class: 'icon' }, CAT_ICON[cat]),
        h('span', { class: 'name' }, inst.name),
        h('span', { class: 'meta' }, inst.type === 'synth' ? 'synth' : inst.type === 'kit' ? '' : 'sampled')))));
    }
    wrap.append(h('div', { class: 'lib-note' }, 'Sampled instruments use free CC-BY and GPL recordings. ', h('a', { onclick: () => window.host?.openCredits() }, 'Credits')));
    return wrap;
  }

  renderMyInstruments(track) {
    const entries = getLibrary();
    const section = h('div', { class: 'lib-section' },
      h('h4', {}, 'My Instruments'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'text', title: 'Import .sf2 SoundFonts or .sfz instruments', onclick: () => this.app.importInstruments() }, '＋ SF2 / SFZ…'),
        h('button', { class: 'text', title: 'Turn a folder of samples into an instrument or drum kit', onclick: () => this.app.importInstrumentFolder() }, '＋ Folder…')));
    if (!entries.length) {
      section.append(h('div', { class: 'lib-note' }, 'Bring your own sounds: SoundFonts (.sf2), SFZ instruments, or a folder of samples named by note (C4.wav, F#2.wav…) or drum hits (kick.wav, snare.wav…). You can also drop .sf2/.sfz files onto the window.'));
      return section;
    }
    for (const entry of entries) section.append(this.renderEntry(entry, track));
    return section;
  }

  renderEntry(entry, track) {
    const defs = entryDefs(entry);
    const remove = h('button', { class: 'icon-btn', title: 'Remove from My Instruments', onclick: e => { e.stopPropagation(); this.app.removeUserInstrument(entry); } }, '✕');
    const item = def => h('div', {
      class: 'lib-item' + (track?.instrument === def.id ? ' on' : ''),
      draggable: true,
      ondragstart: e => e.dataTransfer.setData('application/x-bb', JSON.stringify({ kind: 'instrument', id: def.id })),
      onclick: () => this.app.chooseInstrument(def.id),
      title: def.source.kind === 'sf2' ? `Bank ${def.source.bank}, program ${def.source.program}` : def.source.path,
    },
    h('span', { class: 'icon' }, def.isKit ? '🥁' : '🎼'),
    h('span', { class: 'name' }, def.name),
    entry.kind === 'sf2' ? h('span', { class: 'meta' }, `${def.source.bank}:${String(def.source.program + 1).padStart(3, '0')}`) : null);

    if (defs.length === 1) {
      const el = item(defs[0]);
      el.append(h('span', { class: 'meta' }, entry.kind === 'folder' ? 'folder' : entry.kind.toUpperCase()), remove);
      return el;
    }
    const key = 'user:' + entry.path;
    const open = this.expanded.has(key);
    const head = h('div', { class: 'lib-item folder-head', title: entry.path, onclick: () => { if (open) this.expanded.delete(key); else this.expanded.add(key); this.render(); } },
      h('span', { class: 'icon' }, open ? '▾' : '▸'),
      h('span', { class: 'name' }, entry.name),
      h('span', { class: 'meta' }, `${defs.length}`),
      remove);
    if (!open) return head;
    const q = (this.presetFilter.get(key) || '').toLowerCase();
    const filter = h('input', { class: 'lib-input', type: 'search', placeholder: `Filter ${defs.length} presets…`, value: q, onkeydown: e => e.stopPropagation() });
    const list = h('div');
    const fill = () => {
      const needle = filter.value.toLowerCase();
      this.presetFilter.set(key, filter.value);
      list.replaceChildren(...defs.filter(d => !needle || d.name.toLowerCase().includes(needle)).slice(0, 400).map(item));
    };
    filter.addEventListener('input', fill);
    fill();
    return h('div', {}, head, h('div', { class: 'sub-list' }, filter, list));
  }

  // ------------------------------------------------------------ loops

  renderLoops() {
    const f = this.loopFilter;
    const search = h('input', { class: 'lib-input', type: 'search', placeholder: 'Search loops…', value: f.q, onkeydown: e => e.stopPropagation() });
    search.addEventListener('input', () => { f.q = search.value; this.renderLoopList(list); });
    const chips = h('div', { class: 'chips' }, ['all', ...PARTS].map(p => h('button', {
      class: 'chip' + (f.part === p ? ' on' : ''),
      onclick: () => { f.part = p; this.render(); },
    }, p === 'all' ? 'All' : PART_LABELS[p])));
    const styles = h('div', { class: 'chips' }, ['all', ...Object.keys(STYLES)].map(s => h('button', {
      class: 'chip' + (f.style === s ? ' on' : ''),
      onclick: () => { f.style = s; this.render(); },
    }, s === 'all' ? 'Any style' : STYLES[s].name)));
    const list = h('div');
    this.renderLoopList(list);
    return h('div', {}, search, chips, styles,
      h('div', { class: 'lib-note' }, 'Drag a loop onto the timeline, or double-click to add it at the playhead. Loops follow the song key and tempo.'),
      list);
  }

  renderLoopList(list) {
    const f = this.loopFilter;
    const q = f.q.toLowerCase();
    const items = LOOPS.filter(l => (f.part === 'all' || l.part === f.part) && (f.style === 'all' || l.style === f.style) && (!q || l.name.toLowerCase().includes(q)));
    list.replaceChildren(...items.map(loop => {
      const playing = this.previewId === loop.id;
      return h('div', {
        class: 'lib-item',
        draggable: true,
        ondragstart: e => e.dataTransfer.setData('application/x-bb', JSON.stringify({ kind: 'loop', id: loop.id })),
        ondblclick: () => this.app.addLoop(loop, null, null),
        title: `${loop.bars} bars • ${STYLES[loop.style].bpm} bpm original • plays in the song's time signature`,
      },
      h('button', {
        class: 'play-btn' + (playing ? ' on' : ''),
        onclick: e => {
          e.stopPropagation();
          this.togglePreview(loop.id, () => {
            const { key, timeSig } = store.project;
            const notes = generate(loop.gen, { key, timeSig, bars: loop.bars });
            return this.app.engine.preview(loop.instrument, notes, { bpm: store.project.tracks.length ? store.project.bpm : STYLES[loop.style].bpm, lengthBeats: loop.bars * meter(timeSig).barBeats });
          });
        },
      }, playing ? '■' : '▶'),
      h('span', { class: 'name' }, loop.name),
      h('span', { class: 'meta' }, `${loop.bars} bars`));
    }));
  }

  // ------------------------------------------------------------ samples

  renderSamples() {
    const groups = new Map();
    // Generated effects come first and are sized to the song's tempo when used.
    groups.set('Generated FX', GEN_FX.flatMap(fx => (fx.bars || [null]).map(bars => ({
      group: 'Generated FX', gen: fx.id, bars, name: bars ? `${fx.name} · ${bars} bar${bars > 1 ? 's' : ''}` : fx.name,
    }))));
    for (const s of builtinSamples()) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const s of this.userSamples) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    const wrap = h('div', {},
      h('div', { class: 'lib-note' }, 'Drag a sample onto the timeline to make an audio region. You can also drop audio files from your computer.'),
      h('button', { class: 'text', style: { width: '100%', marginBottom: '8px' }, onclick: () => this.app.addSampleFolder() }, '＋ Add Sample Folder…'));
    for (const [group, list] of groups) {
      const open = this.expanded.has(group);
      const folder = list[0].folder;
      wrap.append(h('div', { class: 'lib-section' },
        h('div', { class: 'lib-item folder-head', onclick: () => { if (open) this.expanded.delete(group); else this.expanded.add(group); this.render(); } },
          h('span', { class: 'icon' }, open ? '▾' : '▸'),
          h('span', { class: 'name' }, group),
          h('span', { class: 'meta' }, String(list.length)),
          folder ? h('button', { title: 'Remove folder', onclick: e => { e.stopPropagation(); this.app.removeSampleFolder(folder); } }, '✕') : null),
        open ? list.slice(0, 400).map(s => {
          const id = s.url || s.path || `gen:${s.gen}:${s.bars}`;
          const playing = this.previewId === id;
          return h('div', {
            class: 'lib-item',
            draggable: true,
            ondragstart: e => e.dataTransfer.setData('application/x-bb', JSON.stringify({ kind: 'sample', url: s.url, path: s.path, gen: s.gen, bars: s.bars, name: s.name })),
            title: s.gen ? (s.bars ? 'Generated to fit the song tempo' : 'Generated') : s.credit ? `${s.name} — by ${s.credit} (CC0)` : s.rel || s.name,
          },
          h('button', {
            class: 'play-btn' + (playing ? ' on' : ''),
            onclick: e => { e.stopPropagation(); this.togglePreview(id, () => this.app.previewSample(s)); },
          }, playing ? '■' : '▶'),
          h('span', { class: 'name' }, s.name));
        }) : null));
    }
    return wrap;
  }

  async loadUserFolders() {
    const settings = await window.host?.getSettings() || {};
    const out = [];
    for (const dir of settings.sampleFolders || []) {
      const files = await window.host.scanFolder(dir);
      const group = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
      for (const f of files) out.push({ group, folder: dir, name: f.name.replace(/\.[^.]+$/, ''), path: f.path, rel: f.rel });
    }
    this.userSamples = out;
    if (this.tab === 'samples') this.render();
  }

  // ------------------------------------------------------------ session band

  renderBand() {
    const b = this.band;
    const style = STYLES[b.style];
    const progInput = h('input', { type: 'text', value: b.progression, onkeydown: e => e.stopPropagation() });
    const err = h('div', { style: { color: 'var(--red)', fontSize: '11px', minHeight: '14px' } });
    progInput.addEventListener('input', () => {
      b.progression = progInput.value;
      try { parseProgression(b.progression, store.project.key); err.textContent = ''; } catch (e) { err.textContent = e.message; }
    });
    const slider = (label, key) => h('label', { class: 'field' }, h('span', {}, label),
      h('div', { class: 'slider-row' }, h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: b[key], oninput: e => { b[key] = Number(e.target.value); } })));

    return h('div', { class: 'band-form' },
      h('div', { class: 'lib-note' }, 'Pick a style and chords, and Basement Band writes drums, bass and accompaniment that you can edit or re-roll.'),
      h('label', { class: 'field' }, h('span', {}, 'Style'),
        h('select', {
          onchange: e => {
            b.style = e.target.value;
            b.progression = STYLES[b.style].progression;
            b.parts = new Set(STYLES[b.style].parts);
            this.render();
          },
        }, Object.entries(STYLES).map(([id, s]) => h('option', { value: id, selected: id === b.style }, `${s.name} — ${s.bpm} bpm`)))),
      h('label', { class: 'field' }, h('span', {}, 'Time signature'),
        h('select', { onchange: e => { this.app.setTimeSig(e.target.value); this.render(); } },
          TIME_SIGNATURES.map(ts => h('option', { value: ts, selected: ts === meter(store.project.timeSig).label }, ts === '4/4' ? '4/4 (common time)' : ts)))),
      h('label', { class: 'field' }, h('span', {}, 'Chord progression'), progInput, err),
      h('label', { class: 'field' }, h('span', {}, 'Presets'),
        h('select', { onchange: e => { if (e.target.value) { b.progression = e.target.value; this.render(); } } },
          h('option', { value: '' }, 'Choose a progression…'),
          PROGRESSION_PRESETS.map(([name, p]) => h('option', { value: p }, name)))),
      h('div', { class: 'lib-note', style: { padding: '0 0 8px' } }, 'Use chord names (C, Am7, F/A) or numbers that follow the key (I, vi, IV, V7). Separate bars with |. Every style plays in any time signature.'),
      h('label', { class: 'field' }, h('span', {}, 'Length'),
        h('select', { onchange: e => { b.bars = Number(e.target.value); } },
          [4, 8, 16, 24, 32, 48, 64].map(n => h('option', { value: n, selected: n === b.bars }, `${n} bars`)))),
      h('span', { style: { fontSize: '11px', color: 'var(--dim)' } }, 'Players'),
      h('div', { class: 'parts' }, PARTS.map(p => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: b.parts.has(p), onchange: e => { if (e.target.checked) b.parts.add(p); else b.parts.delete(p); } }),
        PART_LABELS[p]))),
      slider('Complexity', 'complexity'),
      slider('Energy', 'intensity'),
      h('label', { class: 'check', style: { marginBottom: '8px' } },
        h('input', { type: 'checkbox', checked: b.setTempo, onchange: e => { b.setTempo = e.target.checked; } }), `Set tempo to ${style.bpm} bpm`),
      h('button', { class: 'text accent wide', onclick: () => this.app.createBand({ ...b, parts: [...b.parts] }) }, '🎸 Create Band'),
      h('div', { class: 'lib-note' }, 'Every player is a normal track: change the sound in Sounds, edit notes in the Editor, or use Smart Controls to change the style, complexity and energy.'),
    );
  }
}
