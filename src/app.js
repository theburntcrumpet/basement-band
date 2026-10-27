// App controller: wires the store, audio engine and UI together.

import { store, newProject, newTrack, newMidiRegion, generatedRegion, regenerate, trackForPart, uid, barBeats, changeTimeSig } from './state.js';
import { Engine, renderProject, songEnd } from './engine/engine.js';
import { getInstrument, isKit, loadBuffer } from './engine/instruments.js';
import { setLibrary, inspect, registerDefs, exportDefs, INSTRUMENT_FILE } from './engine/user-instruments.js';
import { encodeWav, toBase64, fromBase64 } from './engine/wav.js';
import { renderFx } from './engine/fxgen.js';
import { EXPORT_FORMATS, MP3_RATES, encodeAudio } from './engine/export.js';
import { defaultAmp } from './engine/amp.js';
import { STYLES, partInstrument } from './music/band.js';
import { KEY_NAMES } from './music/theory.js';
import { TIME_SIGNATURES, meter, parseTimeSig, barBeat } from './music/meter.js';
import { Arrange, setupBackgroundDrop } from './ui/arrange.js';
import { Editor } from './ui/editor.js';
import { SmartControls } from './ui/smart.js';
import { Library, LOOPS } from './ui/library.js';
import { $, h, toast, modal, confirmDialog, contextMenu, canvas2d } from './ui/dom.js';

const Tone = window.Tone;
const TYPING_KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';', "'"];

class App {
  constructor() {
    this.engine = new Engine();
    this.bottomMode = null;
    this.recording = null;
    this.typing = { on: false, octave: 4, velocity: 0.8, down: new Set() };
    this.countIn = true;
    this.settings = {};
  }

  async init() {
    await this.engine.init();
    this.arrange = new Arrange(this);
    this.editor = new Editor(this, $('#bottom-body'), $('#bottom-tools'));
    this.smart = new SmartControls(this, $('#bottom-body'), $('#bottom-tools'));
    this.library = new Library(this, $('#library-body'));
    setupBackgroundDrop(this);

    this.engine.addEventListener('loading', e => this.arrange.setLoading(e.detail.trackId, e.detail.loading));
    this.engine.addEventListener('warning', e => toast(e.detail, 5000));
    store.addEventListener('change', () => this.onChange());
    store.addEventListener('load', () => { this.editor.open(null); this.library.render(); });

    this.settings = (await window.host?.getSettings()) || {};
    setLibrary(this.settings.userInstruments);
    this.countIn = this.settings.countIn ?? true;
    this.wireToolbar();
    this.wireWindowDrop();
    this.wireKeyboard();
    this.wireMidi();
    this.library.render();
    this.library.loadUserFolders();
    this.onChange();
    this.tick();
  }

  // ------------------------------------------------------------ rendering

  onChange() {
    const p = store.project;
    this.engine.sync(p);
    if (this.monitorTrack && !store.track(this.monitorTrack)) this.stopMonitoring();
    if (this.engine.playing) {
      clearTimeout(this.rescheduleTimer);
      this.rescheduleTimer = setTimeout(() => this.engine.reschedule(), 60);
    }
    this.refresh();
  }

  refresh() {
    const p = store.project;
    this.arrange.render();
    this.renderBottom();
    if (this.library.tab === 'sounds') this.library.render();
    $('#lcd-bpm').value = p.bpm;
    $('#lcd-key').value = p.key.root;
    $('#lcd-scale').value = p.key.scale;
    $('#lcd-time').value = meter(p.timeSig).label;
    $('#btn-cycle').classList.toggle('on', p.cycle.on);
    $('#master-vol').value = p.masterVolume ?? 0;
    const name = store.filePath ? store.filePath.split(/[\\/]/).pop().replace(/\.bband$/, '') : p.name;
    document.title = `${store.dirty ? '• ' : ''}${name} — Basement Band`;
  }

  renderBottom() {
    const bottom = $('#bottom');
    bottom.classList.toggle('hidden', !this.bottomMode);
    $('#btn-editor').classList.toggle('on', this.bottomMode === 'editor');
    $('#btn-smart').classList.toggle('on', this.bottomMode === 'smart');
    $('#btn-master').classList.toggle('on', this.bottomMode === 'master');
    $('#btn-master').classList.toggle('fx-active', (store.project.masterFx?.type || 'none') !== 'none');
    if (!this.bottomMode) return;
    if (this.bottomMode === 'master') {
      $('#bottom-title').textContent = 'Master';
      this.editor.wrap = null;
      return this.smart.renderMaster();
    }
    const track = store.selectedTrack;
    if (this.bottomMode === 'editor') {
      this.syncEditorToSelection();
      const found = this.editor.regionId && store.findRegion(this.editor.regionId);
      $('#bottom-title').textContent = found ? `${found.track.name} — ${found.region.name || 'Region'}` : 'Editor';
      this.editor.render();
    } else {
      $('#bottom-title').textContent = track ? `${track.name}` : 'Smart Controls';
      this.editor.wrap = null;
      this.smart.render();
    }
  }

  // The editor shows the selected region; selecting a track shows that track's region at the playhead
  // (or its first one), so clicking around the arrangement moves the piano roll with you.
  syncEditorToSelection() {
    const track = store.selectedTrack;
    if (!track) return this.editor.open(null);
    const picked = [...store.ui.selectedRegions].map(id => store.findRegion(id)).find(f => f?.track === track);
    if (picked) return this.editor.open(picked.region.id);
    const current = this.editor.regionId && store.findRegion(this.editor.regionId);
    if (current?.track === track) return;
    const pos = store.ui.playhead;
    const atPlayhead = track.regions.find(r => pos >= r.start && pos < r.start + r.length);
    const first = [...track.regions].sort((a, b) => a.start - b.start)[0];
    this.editor.open((atPlayhead || first)?.id ?? null);
  }

  setBottom(mode) {
    this.bottomMode = this.bottomMode === mode ? null : mode;
    if (this.bottomMode === 'editor' && !this.editor.regionId) {
      const id = [...store.ui.selectedRegions][0] || store.selectedTrack?.regions[0]?.id;
      if (id) this.editor.open(id);
    }
    this.renderBottom();
  }

  openEditor(regionId) {
    // Opening a region selects it (and its track), so the editor keeps showing it.
    const found = store.findRegion(regionId);
    if (found) {
      store.ui.selectedTrack = found.track.id;
      store.ui.selectedRegions = new Set([regionId]);
    }
    this.editor.open(regionId);
    this.bottomMode = 'editor';
    this.renderBottom();
  }

  tick() {
    const pos = this.engine.playing ? this.engine.position() : store.ui.playhead;
    if (this.engine.playing) {
      store.ui.playhead = pos;
      this.arrange.follow(pos);
    }
    this.arrange.setPlayhead(pos);
    if (this.recording && this.engine.playing) {
      // Draw the take as it happens (the transport isn't "playing" yet during the count-in).
      this.recording.maxPos = Math.max(this.recording.maxPos ?? pos, pos);
      this.arrange.updateRecording(this.recording, pos, this.engine);
    }
    if (this.bottomMode === 'editor') this.editor.setPlayhead(pos);
    const { bar, beat } = barBeat(pos, store.project.timeSig);
    $('#lcd-pos').textContent = `${bar}.${beat}`;
    this.arrange.updateMeters();
    this.drawInputMeter();
    const m = this.engine.masterMeter.getValue();
    const ctx = canvas2d($('#master-meter'), 80, 8);
    const lvl = Math.max(0, Math.min(1, ((typeof m === 'number' ? m : m[0]) + 48) / 48));
    ctx.clearRect(0, 0, 80, 8);
    ctx.fillStyle = lvl > 0.95 ? '#e5534b' : lvl > 0.8 ? '#e0c040' : '#3fbf5f';
    ctx.fillRect(0, 0, 80 * lvl, 8);
    requestAnimationFrame(() => this.tick());
  }

  // ------------------------------------------------------------ transport

  async togglePlay() {
    if (this.engine.playing || this.recording) return this.stop();
    await this.engine.whenLoaded();
    await this.engine.play(store.ui.playhead);
    $('#btn-play').classList.add('on');
  }

  async stop() {
    const rec = this.recording;
    this.recording = null;
    this.engine.stop();
    $('#btn-play').classList.remove('on');
    $('#btn-record').classList.remove('on');
    this.arrange.clearRecording();
    if (rec) await this.finishRecording(rec);
  }

  seek(beats) {
    store.ui.playhead = Math.max(0, beats);
    if (this.engine.playing) this.engine.setPosition(store.ui.playhead);
    this.arrange.setPlayhead(store.ui.playhead);
  }

  rewind() {
    this.seek(store.project.cycle.on ? store.project.cycle.start : 0);
  }

  async toggleRecord() {
    if (this.recording) return this.stop();
    if (this.engine.playing) this.engine.stop();
    let track = store.selectedTrack;
    if (!track) {
      track = this.addTrack('instrument', 'grand-piano');
      toast('Created a piano track to record into');
    }
    await this.engine.whenLoaded();
    const start = store.ui.playhead;
    if (track.type === 'audio') {
      try {
        await this.engine.startAudioRecording(this.settings.inputDevice, track.input?.channel || 'left');
      } catch (err) {
        toast('Microphone unavailable: ' + err.message, 5000);
        return;
      }
      this.recording = { kind: 'audio', trackId: track.id, start };
    } else {
      this.recording = { kind: 'midi', trackId: track.id, start, notes: [], open: new Map() };
    }
    $('#btn-record').classList.add('on');
    $('#btn-play').classList.add('on');
    await this.engine.play(start, { countIn: this.countIn });
  }

  async finishRecording(rec) {
    const track = store.track(rec.trackId);
    if (!track) return;
    if (rec.kind === 'audio') {
      const result = await this.engine.stopAudioRecording(this.settings.latencyMs || 0);
      if (!result) return toast('Nothing was recorded');
      const id = uid();
      this.engine.audioPool.set(id, result.buffer);
      const spb = 60 / store.project.bpm;
      store.update(() => {
        track.regions.push({ id: uid(), name: 'Recording', start: result.startBeat, length: result.buffer.duration / spb, offset: 0, audioId: id });
      });
      return;
    }
    const end = this.engine.position();
    for (const [n, o] of rec.open) rec.notes.push({ t: o.t, d: Math.max(0.05, end - o.t), n, v: o.v });
    if (!rec.notes.length) return;
    const first = Math.min(...rec.notes.map(n => n.t));
    const last = Math.max(...rec.notes.map(n => n.t + n.d));
    const bar = barBeats(store.project);
    const start = Math.floor(first / bar) * bar;
    const length = Math.max(bar, Math.ceil((last - start) / bar) * bar);
    store.update(() => {
      const region = newMidiRegion(start, length, rec.notes.map(n => ({ ...n, t: n.t - start })), { name: 'Recording' });
      track.regions.push(region);
      store.ui.selectedRegions = new Set([region.id]);
    });
  }

  // Note input from musical typing or a MIDI keyboard.
  noteOn(midi, vel) {
    const track = store.selectedTrack;
    if (!track || track.type === 'audio') {
      if (!track) toast('Select or add an instrument track to play');
      return;
    }
    this.engine.resume();
    this.engine.noteOn(track.id, midi, vel);
    const rec = this.recording;
    if (rec?.kind === 'midi' && rec.trackId === track.id) {
      // Notes hit a moment early (during the count-in or before the transport starts) land on the first beat.
      rec.open.set(midi, { t: Math.max(rec.start, this.engine.position()), v: vel });
    }
  }

  noteOff(midi) {
    const track = store.selectedTrack;
    if (!track) return;
    this.engine.noteOff(track.id, midi);
    const rec = this.recording;
    const o = rec?.open?.get(midi);
    if (o) {
      rec.open.delete(midi);
      rec.notes.push({ t: o.t, d: Math.max(0.05, Math.max(rec.start, this.engine.position()) - o.t), n: midi, v: o.v });
    }
  }

  // ------------------------------------------------------------ input monitoring

  async toggleMonitor(track) {
    if (this.monitorTrack === track.id) return this.stopMonitoring();
    try {
      await this.engine.resume();
      await this.engine.openInput(this.settings.inputDevice);
      this.engine.setMonitor(track.id, track.input?.channel || 'left');
      this.monitorTrack = track.id;
      const { monitorLatencyMs } = this.engine.inputInfo();
      toast(`Monitoring through "${track.name}" — about ${monitorLatencyMs} ms latency. Use headphones to avoid feedback.`, 5000);
    } catch (err) {
      toast('Could not open the audio input: ' + err.message, 6000);
    }
    this.refresh();
  }

  drawInputMeter() {
    const canvas = document.getElementById('input-meter');
    if (!canvas) return;
    const track = store.selectedTrack;
    const db = this.engine.inputLevel(track?.input?.channel || 'left');
    const ctx = canvas2d(canvas, 120, 10);
    const lvl = Math.max(0, Math.min(1, (db + 60) / 60));
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 120, 10);
    ctx.fillStyle = lvl > 0.95 ? '#e5534b' : lvl > 0.8 ? '#e0c040' : '#3fbf5f';
    ctx.fillRect(0, 0, 120 * lvl, 10);
  }

  stopMonitoring() {
    this.monitorTrack = null;
    this.engine.setMonitor(null);
    this.engine.closeInput();
    this.refresh();
  }

  async setInputDevice(deviceId) {
    this.settings.inputDevice = deviceId;
    await window.host?.setSettings(this.settings);
    if (this.monitorTrack) {
      const track = store.track(this.monitorTrack);
      this.engine.closeInput(true);
      await this.engine.openInput(deviceId);
      this.engine.setMonitor(track.id, track.input?.channel || 'left');
    }
    this.refresh();
  }

  setInputChannel(track, channel) {
    store.update(() => { track.input = { ...(track.input || {}), channel }; });
    if (this.monitorTrack === track.id) this.engine.setMonitor(track.id, channel);
  }

  // ------------------------------------------------------------ tracks & regions

  addTrack(type, instrument, name) {
    const track = newTrack(type, instrument, name);
    store.update(p => { p.tracks.push(track); });
    store.ui.selectedTrack = track.id;
    this.refresh();
    return track;
  }

  quickStart(kind) {
    if (kind === 'band') {
      $('#library').classList.remove('hidden-panel');
      this.library.show('band');
      return;
    }
    if (kind === 'guitar') {
      // An audio track with an amp: plug in, pick the input, monitor and record.
      const track = newTrack('audio', null, 'Guitar');
      track.amp = defaultAmp('crunch');
      track.reverb = 0.15;
      store.update(p => { p.tracks.push(track); });
      store.ui.selectedTrack = track.id;
      this.bottomMode = 'smart';
      this.refresh();
      toast('Plug in your guitar, pick your interface input below, then turn on 🎧 Monitor (use headphones)', 6000);
      return;
    }
    if (kind === 'drums') {
      const track = newTrack('drums', 'kit-rock', 'Drummer');
      const region = generatedRegion({ style: 'pop', part: 'drums', complexity: 0.4, intensity: 0.5, seed: 1, fills: true }, 0, 8, store.project);
      track.regions.push(region);
      store.update(p => { p.tracks.push(track); });
      store.ui.selectedTrack = track.id;
      store.ui.selectedRegions = new Set([region.id]);
      this.bottomMode = 'smart';
      this.refresh();
      return;
    }
    this.addTrack(kind, kind === 'instrument' ? 'grand-piano' : null);
    if (kind === 'audio') toast('Select the track and press R (or ●) to record from your microphone');
    else toast('Play with your MIDI keyboard or Musical Typing (Ctrl+K)');
  }

  newTrackDialog() {
    let close;
    const pick = kind => { close(); this.quickStart(kind); };
    close = modal([
      h('h2', {}, 'Choose a track type'),
      h('div', { class: 'row' },
        h('button', { class: 'big-choice', onclick: () => pick('instrument') }, h('span', {}, '🎹'), 'Software Instrument'),
        h('button', { class: 'big-choice', onclick: () => pick('drums') }, h('span', {}, '🥁'), 'Drummer'),
        h('button', { class: 'big-choice', onclick: () => pick('audio') }, h('span', {}, '🎤'), 'Audio / Mic'),
        h('button', { class: 'big-choice', onclick: () => pick('guitar') }, h('span', {}, '🎸'), 'Guitar / Bass'),
        h('button', { class: 'big-choice', onclick: () => pick('band') }, h('span', {}, '🎸'), 'Session Band')),
    ]);
  }

  duplicateTrack(track) {
    const copy = JSON.parse(JSON.stringify(track));
    copy.id = uid();
    copy.name = track.name + ' copy';
    copy.regions.forEach(r => { r.id = uid(); });
    store.update(p => { p.tracks.splice(p.tracks.indexOf(track) + 1, 0, copy); });
  }

  async deleteTrack(track) {
    if (track.regions.length && !(await confirmDialog('Delete track?', `"${track.name}" and its ${track.regions.length} region(s) will be removed. You can undo this.`, 'Delete'))) return;
    store.update(p => { p.tracks = p.tracks.filter(t => t !== track); });
  }

  chooseInstrument(id) {
    const track = store.selectedTrack;
    const kit = isKit(id);
    if (!track || track.type === 'audio' || (track.type === 'drums') !== kit) {
      this.addTrack(kit ? 'drums' : 'instrument', id);
      return;
    }
    const oldName = getInstrument(track.instrument).name;
    store.update(() => {
      if (track.name === oldName || track.name.endsWith('– ' + oldName)) track.name = track.name.replace(oldName, getInstrument(id).name);
      track.instrument = id;
    });
    this.engine.whenLoaded().then(() => {
      const chord = kit ? [36, 42, 38] : [60, 64, 67];
      chord.forEach((n, i) => setTimeout(() => this.engine.previewNote(track.id, n, 0.75, 0.8), kit ? i * 160 : 0));
    });
  }

  createEmptyRegion(track, beat) {
    const region = newMidiRegion(beat, barBeats(store.project), [], { name: track.name });
    store.update(() => { track.regions.push(region); });
    store.ui.selectedRegions = new Set([region.id]);
    this.openEditor(region.id);
  }

  selectedRegions() {
    return [...store.ui.selectedRegions].map(id => store.findRegion(id)).filter(Boolean);
  }

  deleteRegions() {
    const list = this.selectedRegions();
    if (!list.length) return;
    store.update(() => {
      for (const { track, region } of list) track.regions.splice(track.regions.indexOf(region), 1);
    });
    store.ui.selectedRegions.clear();
    this.refresh();
  }

  duplicateRegions() {
    const list = this.selectedRegions();
    if (!list.length) return;
    const span = Math.max(...list.map(x => x.region.start + x.region.length)) - Math.min(...list.map(x => x.region.start));
    const fresh = new Set();
    store.update(() => {
      for (const { track, region } of list) {
        const copy = { ...JSON.parse(JSON.stringify(region)), id: uid(), start: region.start + span };
        track.regions.push(copy);
        fresh.add(copy.id);
      }
    });
    store.ui.selectedRegions = fresh;
    this.refresh();
  }

  splitAtPlayhead() {
    const at = store.ui.playhead;
    const list = this.selectedRegions().filter(({ region }) => at > region.start + 1e-3 && at < region.start + region.length - 1e-3);
    if (!list.length) return toast('Put the playhead inside a selected region to split it');
    const spb = 60 / store.project.bpm;
    store.update(() => {
      for (const { track, region } of list) {
        const cut = at - region.start;
        const right = JSON.parse(JSON.stringify(region));
        right.id = uid();
        right.start = at;
        right.length = region.length - cut;
        if (track.type === 'audio') {
          right.offset = (region.offset || 0) + cut * spb;
        } else {
          // Bake loop repeats so both halves keep exactly what played before.
          const loopLen = region.loopLength || region.length;
          const all = [];
          for (let off = 0; off < region.length; off += loopLen) {
            for (const n of region.notes) if (n.t < loopLen && off + n.t < region.length) all.push({ ...n, t: off + n.t });
          }
          region.notes = all.filter(n => n.t < cut).map(n => ({ ...n, d: Math.min(n.d, cut - n.t) }));
          right.notes = all.filter(n => n.t >= cut).map(n => ({ ...n, t: n.t - cut }));
          right.loopLength = right.length;
          region.loopLength = cut;
          delete region.gen;
          delete right.gen;
        }
        region.length = cut;
        track.regions.push(right);
      }
    });
  }

  regionMenu(x, y, track, region) {
    const items = [
      { label: 'Open in Editor', key: 'E', action: () => this.openEditor(region.id) },
      { label: 'Duplicate', key: 'Ctrl+D', action: () => this.duplicateRegions() },
      { label: 'Split at Playhead', key: 'Ctrl+T', action: () => this.splitAtPlayhead() },
      { label: 'Rename…', action: () => this.renameRegion(region) },
    ];
    if (region.gen) {
      items.push('-',
        { label: 'New Variation', action: () => store.update(() => { region.gen.seed = Math.floor(Math.random() * 1e6); regenerate(region, store.project); }) },
        { label: 'Make Editable', action: () => store.update(() => { delete region.gen; }) });
    }
    items.push('-', { label: 'Delete', key: 'Del', action: () => this.deleteRegions() });
    contextMenu(x, y, items);
  }

  renameRegion(region) {
    let close;
    const input = h('input', { type: 'text', value: region.name || '', style: { width: '100%' }, onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') done(); } });
    const done = () => { close(); store.update(() => { region.name = input.value.trim(); }); };
    close = modal([h('h2', {}, 'Rename region'), h('div', { class: 'field' }, input),
      h('div', { class: 'actions' }, h('button', { class: 'text accent', onclick: done }, 'Rename'))]);
    input.focus();
    input.select();
  }

  // ------------------------------------------------------------ loops, samples & drops

  canDrop(e, track) {
    const types = e.dataTransfer.types;
    if (types.includes('Files')) return !track || track.type === 'audio' || true;
    return types.includes('application/x-bb');
  }

  async handleDrop(e, track, beat) {
    const all = [...e.dataTransfer.files];
    const files = all.filter(f => !INSTRUMENT_FILE.test(f.name));
    if (all.length > files.length) await this.importDroppedInstruments(all);
    if (files.length) {
      for (const f of files) await this.importAudio(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''), track, beat);
      return;
    }
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-bb')); } catch { return; }
    if (data.kind === 'loop') this.addLoop(LOOPS.find(l => l.id === data.id), track, beat);
    else if (data.kind === 'sample') {
      try {
        this.addAudioBuffer(await this.sampleBuffer(data), data.name, track, beat);
      } catch (err) {
        toast('Could not load sample: ' + err.message);
      }
    } else if (data.kind === 'instrument') {
      if (track && track.type !== 'audio' && (track.type === 'drums') === isKit(data.id)) {
        store.ui.selectedTrack = track.id;
        this.chooseInstrument(data.id);
      } else {
        this.addTrack(isKit(data.id) ? 'drums' : 'instrument', data.id);
      }
    }
  }

  // ------------------------------------------------------------ user instruments

  async importDroppedInstruments(fileList) {
    const paths = [];
    for (const f of fileList) {
      if (!INSTRUMENT_FILE.test(f.name)) continue;
      const p = window.host?.pathForFile(f);
      if (p && (await window.host.allowInstrumentFile(p))) paths.push(p);
    }
    if (paths.length) await this.importInstrumentPaths(paths);
  }

  async importInstruments() {
    if (!window.host) return toast('Importing instruments needs the desktop app');
    const paths = await window.host.pickInstrumentFiles();
    if (paths.length) await this.importInstrumentPaths(paths);
  }

  async importInstrumentFolder() {
    if (!window.host) return toast('Importing instruments needs the desktop app');
    const dir = await window.host.pickFolder();
    if (dir) await this.importInstrumentPaths([dir], 'folder');
  }

  async importInstrumentPaths(paths, forceKind) {
    const added = [];
    for (const p of paths) {
      const kind = forceKind || (/\.sf2$/i.test(p) ? 'sf2' : 'sfz');
      const label = p.split(/[\\/]/).pop();
      toast(`Reading ${label}…`, 60000);
      try {
        const entry = await inspect(kind, p);
        const list = (this.settings.userInstruments || []).filter(e => e.path !== entry.path);
        list.push(entry);
        this.settings.userInstruments = list;
        added.push(entry);
        this.library.expanded.add('user:' + entry.path);
      } catch (err) {
        console.error(err);
        toast(`Couldn't import ${label}: ${err.message}`, 6000);
        return;
      }
    }
    setLibrary(this.settings.userInstruments);
    await window.host?.setSettings(this.settings);
    $('#library').classList.remove('hidden-panel');
    this.library.show('sounds');
    const count = added.reduce((n, e) => n + (e.presets ? e.presets.length : 1), 0);
    toast(`Added ${added.map(e => e.name).join(', ')} — ${count} instrument${count === 1 ? '' : 's'} in My Instruments`, 4000);
  }

  async removeUserInstrument(entry) {
    this.settings.userInstruments = (this.settings.userInstruments || []).filter(e => e.path !== entry.path);
    setLibrary(this.settings.userInstruments);
    await window.host?.setSettings(this.settings);
    this.library.render();
    toast(`Removed ${entry.name} from My Instruments (songs using it keep a reference)`);
  }

  // Stops Electron from navigating to a file dropped anywhere outside the timeline.
  wireWindowDrop() {
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.some(f => INSTRUMENT_FILE.test(f.name))) this.importDroppedInstruments(files);
      else if (files.length) toast('Drop audio files onto the timeline, or instruments (.sf2/.sfz) anywhere');
    });
  }

  // Audio for a sample-browser entry: a bundled file, a file in the user's folders, or a generated effect.
  async sampleBuffer(s) {
    if (s.gen) {
      const p = store.project;
      return renderFx(s.gen, { bars: s.bars || 1, bpm: p.bpm, barBeats: barBeats(p) });
    }
    if (s.url) return loadBuffer(s.url);
    return Tone.getContext().rawContext.decodeAudioData(await window.host.readFile(s.path));
  }

  async importAudio(bytes, name, track, beat) {
    let buffer;
    try {
      buffer = await Tone.getContext().rawContext.decodeAudioData(bytes.slice(0));
    } catch {
      toast(`"${name}" is not an audio file this app can read`);
      return;
    }
    this.addAudioBuffer(buffer, name, track, beat);
  }

  addAudioBuffer(buffer, name, track, beat) {
    const id = uid();
    this.engine.audioPool.set(id, buffer);
    const spb = 60 / store.project.bpm;
    store.update(p => {
      let target = track;
      if (!target || target.type !== 'audio') {
        target = newTrack('audio', null, name);
        p.tracks.push(target);
      }
      target.regions.push({ id: uid(), name, start: beat, length: buffer.duration / spb, offset: 0, audioId: id });
      store.ui.selectedTrack = target.id;
    });
  }

  addLoop(loop, track, beat) {
    if (!loop) return;
    const bar = barBeats(store.project);
    const at = beat ?? Math.floor(store.ui.playhead / bar) * bar;
    const kit = loop.part === 'drums';
    store.update(p => {
      let target = track;
      if (!target || target.type === 'audio' || (target.type === 'drums') !== kit) {
        target = trackForPart(loop.part, loop.style);
        p.tracks.push(target);
      }
      const region = generatedRegion({ ...loop.gen, seed: Math.floor(Math.random() * 1e6) }, at, loop.bars, p);
      region.name = loop.name;
      target.regions.push(region);
      store.ui.selectedTrack = target.id;
      store.ui.selectedRegions = new Set([region.id]);
    });
    this.library.stopAllPreviews();
    this.library.render();
  }

  async previewSample(s) {
    await this.engine.resume();
    const buffer = await this.sampleBuffer(s);
    const player = new Tone.Player(buffer).toDestination();
    player.start();
    const stop = () => { try { player.stop(); } catch { /* stopped */ } setTimeout(() => player.dispose(), 100); };
    player.onstop = () => {
      if (this.library.previewId === (s.url || s.path || `gen:${s.gen}:${s.bars}`)) { this.library.previewId = null; this.library.render(); }
    };
    return stop;
  }

  async addSampleFolder() {
    if (!window.host) return toast('Sample folders need the desktop app');
    const dir = await window.host.pickFolder();
    if (!dir) return;
    const folders = new Set(this.settings.sampleFolders || []);
    folders.add(dir);
    this.settings.sampleFolders = [...folders];
    await window.host.setSettings(this.settings);
    await this.library.loadUserFolders();
    this.library.expanded.add(dir.split(/[\\/]/).filter(Boolean).pop());
    this.library.render();
  }

  async removeSampleFolder(dir) {
    this.settings.sampleFolders = (this.settings.sampleFolders || []).filter(d => d !== dir);
    await window.host.setSettings(this.settings);
    await this.library.loadUserFolders();
  }

  // ------------------------------------------------------------ session band

  createBand(opts) {
    if (!opts.parts.length) return toast('Pick at least one player');
    const style = STYLES[opts.style];
    const bar = barBeats(store.project);
    const start = store.project.tracks.length ? Math.ceil(songEnd(store.project) / bar - 1e-6) * bar : 0;
    let firstRegion = null;
    store.update(p => {
      if (opts.setTempo) p.bpm = style.bpm;
      for (const part of opts.parts) {
        const instrument = partInstrument(opts.style, part);
        // Reuse a matching band track if there is one, otherwise add a new one.
        let track = p.tracks.find(t => t.instrument === instrument && t.regions.some(r => r.gen?.part === part));
        if (!track) {
          track = trackForPart(part, opts.style);
          p.tracks.push(track);
        }
        const seed = Math.floor(Math.random() * 1e6);
        const region = generatedRegion({ style: opts.style, part, complexity: opts.complexity, intensity: opts.intensity, seed, progression: opts.progression, fills: true }, start, opts.bars, p);
        track.regions.push(region);
        if (part === 'drums') firstRegion = region;
        firstRegion ??= region;
      }
    });
    store.ui.selectedTrack = store.findRegion(firstRegion.id).track.id;
    store.ui.selectedRegions = new Set([firstRegion.id]);
    this.seek(start);
    this.bottomMode = 'smart';
    this.refresh();
    toast(`${style.name} band ready — press Space to play`);
  }

  setKey(root, scale) {
    store.update(p => {
      p.key = { root, scale };
      // Band and loop regions follow the key, like Apple Loops do.
      for (const t of p.tracks) for (const r of t.regions) if (r.gen && r.gen.part !== 'drums') regenerate(r, p);
    });
  }

  setTimeSig(label) {
    const ts = parseTimeSig(label);
    if (meter(ts).label === meter(store.project.timeSig).label) return;
    store.update(p => changeTimeSig(p, ts, store.ui));
    if (this.engine.playing) this.engine.setPosition(store.ui.playhead);
    toast(`Time signature ${label} — band parts were rewritten to fit`);
  }

  // ------------------------------------------------------------ files

  async confirmDiscard() {
    if (!store.dirty || !store.project.tracks.length) return true;
    return confirmDialog('Discard unsaved changes?', 'Your current song has changes that have not been saved.', 'Discard');
  }

  async newSong() {
    if (!(await this.confirmDiscard())) return;
    this.stop();
    this.engine.audioPool.clear();
    store.load(newProject());
  }

  async save(saveAs = false) {
    const used = new Set(store.project.tracks.flatMap(t => t.regions.map(r => r.audioId).filter(Boolean)));
    const audio = {};
    for (const id of used) {
      const buf = this.engine.audioPool.get(id);
      if (buf) audio[id] = toBase64(encodeWav(buf, 16));
    }
    // Songs remember which of the user's instruments they use, so they can say what's missing elsewhere.
    const userIds = store.project.tracks.map(t => t.instrument).filter(id => id?.startsWith('user:'));
    const project = { ...store.project, userInstruments: exportDefs(userIds) };
    const data = JSON.stringify({ format: 'basement-band', version: 1, project, audio });
    if (!window.host) {
      download(new Blob([data], { type: 'application/json' }), 'My Song.bband');
      return;
    }
    const path = await window.host.saveProject(data, store.filePath, saveAs);
    if (!path) return;
    store.filePath = path;
    store.dirty = false;
    store.project.name = path.split(/[\\/]/).pop().replace(/\.bband$/, '');
    this.refresh();
    toast('Saved');
  }

  async open() {
    if (!window.host) return;
    if (!(await this.confirmDiscard())) return;
    const res = await window.host.openProject();
    if (!res) return;
    try {
      const file = JSON.parse(res.data);
      if (file.format !== 'basement-band') throw new Error('not a Basement Band song');
      this.stop();
      this.engine.audioPool.clear();
      for (const [id, b64] of Object.entries(file.audio || {})) {
        this.engine.audioPool.set(id, await Tone.getContext().rawContext.decodeAudioData(fromBase64(b64)));
      }
      registerDefs(file.project.userInstruments);
      delete file.project.userInstruments;
      store.load(file.project, res.filePath);
    } catch (err) {
      toast('Could not open song: ' + err.message, 5000);
    }
  }

  // Asks for a format and range, then renders and encodes.
  exportSong() {
    const p = store.project;
    const end = songEnd(p);
    if (!end) return toast('Nothing to export yet');
    let close;
    const format = h('select', { class: 'wide-select' },
      EXPORT_FORMATS.map(f => h('option', { value: f.id, selected: f.id === (this.settings.exportFormat || 'mp3-320') }, f.label)));
    const range = h('select', { class: 'wide-select' },
      h('option', { value: 'song' }, `Whole song (bars 1–${Math.ceil(end / barBeats(p))})`),
      h('option', { value: 'cycle', selected: p.cycle.on }, 'Cycle range only'));
    const go = () => {
      this.settings.exportFormat = format.value;
      window.host?.setSettings(this.settings);
      close();
      this.runExport(format.value, range.value === 'cycle' ? { start: p.cycle.start, end: p.cycle.end } : { start: 0, end });
    };
    close = modal([
      h('h2', {}, 'Export Song'),
      h('label', { class: 'field' }, h('span', {}, 'Format'), format),
      h('label', { class: 'field' }, h('span', {}, 'Range'), range),
      h('div', { class: 'actions' },
        h('button', { class: 'text', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'text accent', onclick: go }, 'Export…')),
    ]);
  }

  async runExport(formatId, range) {
    const p = store.project;
    const fmt = EXPORT_FORMATS.find(f => f.id === formatId);
    const bar = h('div', { style: { width: '0%', animation: 'none' } });
    const status = h('div', { style: { color: 'var(--dim)' } }, 'Mixing your song…');
    const close = modal([h('h2', {}, 'Exporting…'), status, h('div', { class: 'progress' }, bar)], { dismissable: false });
    try {
      // MP3 only supports a few sample rates; mix at 44.1 kHz if the audio device runs at something else.
      const rate = Tone.getContext().sampleRate;
      const sampleRate = fmt.ext === 'mp3' && !MP3_RATES.includes(rate) ? 44100 : rate;
      bar.style.width = '15%';
      const buffer = await renderProject(p, this.engine.audioPool, { ...range, sampleRate });
      status.textContent = `Encoding ${fmt.ext.toUpperCase()}…`;
      const bytes = await encodeAudio(buffer, formatId, f => { bar.style.width = `${15 + f * 85}%`; });
      close();
      const name = `${store.filePath?.split(/[\\/]/).pop().replace(/\.bband$/, '') || p.name || 'My Song'}.${fmt.ext}`;
      if (window.host) {
        const path = await window.host.exportAudio(bytes, name, fmt.ext);
        if (path) toast(`Exported ${path.split(/[\\/]/).pop()} (${(bytes.length / 1e6).toFixed(1)} MB)`);
      } else {
        download(new Blob([bytes], { type: fmt.ext === 'mp3' ? 'audio/mpeg' : `audio/${fmt.ext}` }), name);
      }
      return bytes;
    } catch (err) {
      close();
      console.error(err);
      toast('Export failed: ' + err.message, 5000);
    }
  }

  // ------------------------------------------------------------ toolbar & keys

  wireToolbar() {
    const keySel = $('#lcd-key');
    KEY_NAMES.forEach((k, i) => keySel.append(h('option', { value: i }, k)));
    keySel.addEventListener('change', () => this.setKey(Number(keySel.value), store.project.key.scale));
    $('#lcd-scale').addEventListener('change', e => this.setKey(store.project.key.root, e.target.value));
    const timeSel = $('#lcd-time');
    TIME_SIGNATURES.forEach(ts => timeSel.append(h('option', { value: ts }, ts)));
    timeSel.addEventListener('change', () => this.setTimeSig(timeSel.value));
    $('#lcd-bpm').addEventListener('change', e => {
      const bpm = Math.max(40, Math.min(240, Number(e.target.value) || 110));
      store.update(p => { p.bpm = bpm; });
    });
    $('#lcd-bpm').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-record').addEventListener('click', () => this.toggleRecord());
    $('#btn-rewind').addEventListener('click', () => this.rewind());
    $('#btn-cycle').addEventListener('click', () => store.update(p => { p.cycle.on = !p.cycle.on; }));
    $('#btn-metronome').addEventListener('click', () => this.toggleMetronome());
    $('#btn-countin').classList.toggle('on', this.countIn);
    $('#btn-countin').addEventListener('click', () => {
      this.countIn = !this.countIn;
      $('#btn-countin').classList.toggle('on', this.countIn);
      this.settings.countIn = this.countIn;
      window.host?.setSettings(this.settings);
    });
    $('#btn-typing').addEventListener('click', () => this.toggleTyping());
    $('#btn-library').addEventListener('click', () => this.toggleLibrary());
    $('#btn-smart').addEventListener('click', () => this.setBottom('smart'));
    $('#btn-editor').addEventListener('click', () => this.setBottom('editor'));
    $('#btn-master').addEventListener('click', () => this.setBottom('master'));
    $('#bottom-close').addEventListener('click', () => { this.bottomMode = null; this.renderBottom(); });
    $('#btn-new').addEventListener('click', () => this.newSong());
    $('#btn-open').addEventListener('click', () => this.open());
    $('#btn-save').addEventListener('click', () => this.save());
    $('#btn-export').addEventListener('click', () => this.exportSong());
    const vol = $('#master-vol');
    vol.addEventListener('mousedown', () => store.beginGesture());
    vol.addEventListener('input', () => { store.project.masterVolume = Number(vol.value); this.engine.sync(store.project); });
    vol.addEventListener('change', () => store.endGesture());

    // Drag the bottom pane's top edge to resize it.
    const handle = h('div', { id: 'bottom-resize' });
    $('#bottom').prepend(handle);
    handle.addEventListener('mousedown', e => {
      const start = $('#bottom').offsetHeight;
      const y0 = e.clientY;
      const move = ev => { $('#bottom').style.height = Math.max(160, Math.min(innerHeight - 220, start - (ev.clientY - y0))) + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); this.renderBottom(); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    window.addEventListener('resize', () => this.renderBottom());
  }

  toggleMetronome() {
    this.engine.metronome = !this.engine.metronome;
    $('#btn-metronome').classList.toggle('on', this.engine.metronome);
  }

  toggleLibrary() {
    const lib = $('#library');
    lib.classList.toggle('hidden-panel');
    $('#btn-library').classList.toggle('on', !lib.classList.contains('hidden-panel'));
  }

  toggleTyping() {
    const t = this.typing;
    t.on = !t.on;
    $('#btn-typing').classList.toggle('on', t.on);
    $('#typing').classList.toggle('hidden', !t.on);
    if (t.on) this.renderTyping();
    else { t.down.forEach(m => this.noteOff(m)); t.down.clear(); }
  }

  renderTyping() {
    const t = this.typing;
    const base = (t.octave + 1) * 12;
    const keys = h('div', { class: 'keys' });
    let white = 0;
    TYPING_KEYS.forEach((k, i) => {
      const midi = base + i;
      const black = [1, 3, 6, 8, 10].includes(i % 12);
      const label = k.toUpperCase();
      if (black) keys.append(h('div', { class: 'black' + (t.down.has(midi) ? ' down' : ''), style: { left: white * 34 - 12 + 'px' } }, label));
      else { keys.append(h('div', { class: 'white' + (t.down.has(midi) ? ' down' : '') }, label)); white++; }
    });
    $('#typing').replaceChildren(
      h('div', { class: 'title' }, h('span', {}, `Musical Typing — C${t.octave}`), h('span', {}, `Z/X octave • C/V velocity ${Math.round(t.velocity * 127)}`)),
      keys);
  }

  typingKey(e, down) {
    const t = this.typing;
    const k = e.key.toLowerCase();
    if (down && !e.repeat) {
      if (k === 'z') { t.octave = Math.max(0, t.octave - 1); this.renderTyping(); return true; }
      if (k === 'x') { t.octave = Math.min(8, t.octave + 1); this.renderTyping(); return true; }
      if (k === 'c') { t.velocity = Math.max(0.1, t.velocity - 0.1); this.renderTyping(); return true; }
      if (k === 'v') { t.velocity = Math.min(1, t.velocity + 0.1); this.renderTyping(); return true; }
    }
    const i = TYPING_KEYS.indexOf(k);
    if (i < 0) return false;
    const midi = (t.octave + 1) * 12 + i;
    if (down) {
      if (e.repeat || t.down.has(midi)) return true;
      t.down.add(midi);
      this.noteOn(midi, t.velocity);
    } else {
      t.down.delete(midi);
      this.noteOff(midi);
    }
    this.renderTyping();
    return true;
  }

  wireKeyboard() {
    window.addEventListener('keyup', e => {
      if (this.typing.on && !e.ctrlKey && !e.metaKey) this.typingKey(e, false);
    });
    window.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      if ((tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod) {
        const handled = {
          z: () => (e.shiftKey ? store.redo() : store.undo()),
          y: () => store.redo(),
          s: () => this.save(e.shiftKey),
          o: () => this.open(),
          n: () => (e.altKey ? this.newTrackDialog() : this.newSong()),
          d: () => this.duplicateRegions(),
          t: () => this.splitAtPlayhead(),
          k: () => this.toggleTyping(),
          a: () => (this.bottomMode === 'editor' ? this.editor.selectAll() : this.selectAllRegions()),
          e: () => this.exportSong(),
          backspace: () => store.selectedTrack && this.deleteTrack(store.selectedTrack),
        }[k];
        if (handled) { e.preventDefault(); handled(); }
        return;
      }
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); return; }
      if (this.typing.on && this.typingKey(e, true)) { e.preventDefault(); return; }
      const inEditor = this.bottomMode === 'editor' && this.editor.selected.size;
      switch (e.key) {
        case 'Enter': this.rewind(); break;
        case 'Delete': case 'Backspace':
          if (!(this.bottomMode === 'editor' && this.editor.deleteSelected())) this.deleteRegions();
          break;
        case 'ArrowLeft': if (inEditor) { e.preventDefault(); this.editor.nudge(-1, 0); } else { const bar = barBeats(store.project); this.seek(Math.max(0, (Math.ceil(store.ui.playhead / bar - 1e-6) - 1) * bar)); } break;
        case 'ArrowRight': if (inEditor) { e.preventDefault(); this.editor.nudge(1, 0); } else { const bar = barBeats(store.project); this.seek((Math.floor(store.ui.playhead / bar + 1e-6) + 1) * bar); } break;
        case 'ArrowUp': if (inEditor) { e.preventDefault(); this.editor.nudge(0, e.shiftKey ? 12 : 1); } else this.selectAdjacentTrack(-1); break;
        case 'ArrowDown': if (inEditor) { e.preventDefault(); this.editor.nudge(0, e.shiftKey ? -12 : -1); } else this.selectAdjacentTrack(1); break;
        default:
          switch (k) {
            case 'r': this.toggleRecord(); break;
            case 'c': store.update(p => { p.cycle.on = !p.cycle.on; }); break;
            case 'k': this.toggleMetronome(); break;
            case 'e': this.setBottom('editor'); break;
            case 'b': this.setBottom('smart'); break;
            case 'y': this.toggleLibrary(); break;
            case 'q': if (this.bottomMode === 'editor') this.editor.quantize(); break;
            case 'm': if (store.selectedTrack) store.update(() => { store.selectedTrack.mute = !store.selectedTrack.mute; }); break;
            case 's': if (store.selectedTrack) store.update(() => { store.selectedTrack.solo = !store.selectedTrack.solo; }); break;
            case 'escape': this.library.stopAllPreviews(); this.library.render(); break;
            default: return;
          }
      }
    });
  }

  selectAllRegions() {
    store.ui.selectedRegions = new Set(store.project.tracks.flatMap(t => t.regions.map(r => r.id)));
    this.refresh();
  }

  selectAdjacentTrack(dir) {
    const tracks = store.project.tracks;
    const i = tracks.findIndex(t => t.id === store.ui.selectedTrack);
    const next = tracks[Math.max(0, Math.min(tracks.length - 1, i + dir))];
    if (next) { store.ui.selectedTrack = next.id; this.refresh(); }
  }

  async wireMidi() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      const attach = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = ({ data }) => {
            const [status, note, vel] = data;
            const cmd = status & 0xf0;
            if (cmd === 0x90 && vel > 0) this.noteOn(note, vel / 127);
            else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note);
          };
        }
      };
      attach();
      access.onstatechange = e => {
        attach();
        if (e.port.type === 'input' && e.port.state === 'connected') toast(`MIDI keyboard connected: ${e.port.name}`);
      };
    } catch (err) {
      console.warn('MIDI unavailable', err);
    }
  }
}

function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const app = new App();
window.app = app;
window.store = store;
app.init().catch(err => {
  console.error(err);
  document.body.append(h('div', { style: { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#000c', color: '#fff' } }, 'Basement Band failed to start: ' + err.message));
});
