// The tuner: a small panel showing the note you're playing and how far off it is.

import { h, toast } from './dom.js';
import { icon } from './icons.js';
import { store } from '../state.js';
import { detectPitch, nearestNote } from '../music/pitch.js';

const IN_TUNE_CENTS = 3;
const EVERY_MS = 80;
const HOLD_MS = 1500;   // keep showing a note this long after it fades
const SMOOTHING = 5;    // readings the display takes the median of

export class Tuner {
  constructor(app, root, button) {
    this.app = app;
    this.root = root;
    this.button = button;
    this.on = false;
    this.readings = [];
    this.lastRead = 0;
    this.lastHeard = 0;
    this.build();
  }

  get a4() { return this.app.settings.tunerA4 || 440; }
  get channel() { return this.app.settings.tunerChannel || store.selectedTrack?.input?.channel || 'left'; }

  build() {
    const keep = e => e.stopPropagation();
    this.noteEl = h('div', { class: 'tuner-note' }, '–');
    this.needleEl = h('div', { class: 'tuner-needle' });
    this.centsEl = h('span');
    this.hzEl = h('span');
    this.channelEl = h('select', { title: 'The input your instrument is plugged into', onkeydown: keep, onchange: e => this.setChannel(e.target.value) },
      [['left', 'Input 1'], ['right', 'Input 2'], ['stereo', 'Inputs 1+2']].map(([v, l]) => h('option', { value: v }, l)));
    this.a4El = h('input', { type: 'number', min: 415, max: 466, step: 1, title: 'Reference pitch: the frequency of A above middle C', onkeydown: keep, onchange: e => this.setA4(Number(e.target.value)) });
    this.root.replaceChildren(
      h('div', { class: 'tuner-title' }, h('span', {}, 'Tuner'), h('button', { class: 'tuner-close', title: 'Close', onclick: () => this.toggle() }, icon('close'))),
      this.noteEl,
      h('div', { class: 'tuner-scale' }, this.needleEl),
      h('div', { class: 'tuner-read' }, this.centsEl, this.hzEl),
      h('div', { class: 'tuner-options' }, this.channelEl, h('label', {}, 'A =', this.a4El, 'Hz')));
  }

  async toggle() {
    return this.on ? this.stop() : this.start();
  }

  async start() {
    if (this.app.recording) return toast('The tuner can\'t listen while recording');
    this.on = true;
    this.channelEl.value = this.channel;
    this.a4El.value = this.a4;
    this.reset();
    this.root.classList.remove('hidden');
    this.button.classList.add('on');
    try {
      await this.app.engine.startTuner(this.app.settings.inputDevice, this.channel);
      // Closed while the audio device was still opening.
      if (!this.on) await this.app.engine.stopTuner();
    } catch (err) {
      toast('Could not open the audio input: ' + err.message, 6000);
      await this.stop();
    }
  }

  async stop() {
    this.on = false;
    this.root.classList.add('hidden');
    this.button.classList.remove('on');
    await this.app.engine.stopTuner();
  }

  // Listens again after the input went away (the helper crashed, or the input changed).
  async restart() {
    await this.app.engine.stopTuner();
    this.reset();
    if (this.on) await this.app.engine.startTuner(this.app.settings.inputDevice, this.channel);
  }

  async setChannel(channel) {
    this.app.settings.tunerChannel = channel;
    window.host?.setSettings(this.app.settings);
    if (this.app.monitorTrack && this.app.engine.nativeActive) toast('While monitoring, the tuner hears the monitored input');
    await this.restart();
  }

  setA4(hz) {
    this.app.settings.tunerA4 = Math.max(415, Math.min(466, Math.round(hz) || 440));
    this.a4El.value = this.a4;
    window.host?.setSettings(this.app.settings);
    this.readings = [];
  }

  reset() {
    this.readings = [];
    this.lastHeard = 0;
    this.show(null);
  }

  // Called every frame while the app runs.
  update(now) {
    if (!this.on || now - this.lastRead < EVERY_MS) return;
    this.lastRead = now;
    const input = this.app.engine.tunerInput();
    if (!input) return;
    const found = detectPitch(input.data, input.rate);
    if (found) {
      // A new note starts a new reading rather than being averaged with the last.
      if (this.readings.length && Math.abs(1200 * Math.log2(found.hz / this.readings.at(-1))) > 50) this.readings = [];
      this.readings.push(found.hz);
      if (this.readings.length > SMOOTHING) this.readings.shift();
      this.lastHeard = now;
      this.show([...this.readings].sort((a, b) => a - b)[this.readings.length >> 1]);
    } else if (now - this.lastHeard > HOLD_MS) {
      this.readings = [];
      this.show(null);
    }
  }

  show(hz) {
    this.root.classList.toggle('idle', !hz);
    if (!hz) {
      this.root.classList.remove('in-tune');
      this.noteEl.replaceChildren('–');
      this.centsEl.textContent = 'Play a note';
      this.hzEl.textContent = '';
      return;
    }
    const n = nearestNote(hz, this.a4);
    const cents = Math.round(n.cents);
    this.root.classList.toggle('in-tune', Math.abs(n.cents) <= IN_TUNE_CENTS);
    this.noteEl.replaceChildren(n.name, h('small', {}, String(n.octave)));
    this.needleEl.style.left = 50 + n.cents + '%';
    this.centsEl.textContent = Math.abs(n.cents) <= IN_TUNE_CENTS ? 'In tune' : `${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'}`;
    this.hzEl.textContent = hz.toFixed(1) + ' Hz';
  }
}
