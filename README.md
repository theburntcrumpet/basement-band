# Basement Band

A simple, GarageBand-style music studio for Windows and Linux. It ships with a full band of
instruments, a drummer that writes its own parts, a loop library and a sample browser, so you can
open it and start making music.

![Basement Band](build/icon.png)

## What's inside

- **Session Band**: pick a style (Pop, Rock, Funk, Lo-Fi, Jazz Trio, House, Ballad, Reggae, Country,
  Synthwave) and a chord progression, and it writes drums, bass, keys, guitar, pads and arps. Every
  part is an ordinary track you can edit, re-voice or re-roll.
- **Plugins**: VST3 instruments on Windows and Linux (plus LV2 on Linux), with the Dexed FM
  synth included. See [Plugins](#plugins-vst3).
- **Song sections**: mark Intro/Verse/Chorus… on the Arrangement strip (＋). Right-click a section to
  duplicate it (everything later moves along), delete it (the gap closes), loop it, or select its
  regions; double-click to rename; drag its left edge to move it.
- **Tempo changes**: right-click the ruler to add one at a bar; drag the ♩ marker to move it, click
  to edit, right-click to remove. The tempo box shows (and edits) the tempo at the playhead.
- **Time signatures**: 2/4, 3/4, 4/4, 5/4, 6/8, 7/8, 9/8 and 12/8. Every band style adapts its
  grooves to the meter, and the metronome, count-in, ruler and editors follow it. Changing the
  meter keeps regions on their bars and rewrites band parts to fit.
- **Drummer**: a drum track you steer with a Simple↔Complex / Soft↔Loud pad, with automatic fills.
- **40 instruments**: a Salamander grand piano, electric and upright bass, acoustic, nylon, clean and
  crunch guitars, a string section, brass, woodwinds, harp, mallets, organs and synths.
  There are 4 drum kits: acoustic rock (5 velocity layers), lo-fi, 808 and electro.
- **My Instruments**: import SoundFonts (.sf2), SFZ instruments, or a folder of samples (named by
  note, like `C4.wav`, or drum hits like `kick.wav`). Every SoundFont preset (including GM drum kits
  in bank 128) becomes an instrument. Drag .sf2/.sfz files onto the window to add them.
- **Loops**: about 80 MIDI loops. They follow your song's key and tempo, like Apple Loops.
- **Samples**: tempo-synced generated FX (risers, downlifters, reverse cymbals, sweeps, impacts,
  sub drops), 45 CC0 recordings (waves, wind, rain and thunder, birds, streams, crowds, fire, vinyl
  crackle, city ambience, whooshes, booms, drones), drum one-shots, plus any folders of
  WAV/MP3/FLAC/OGG files you add. Drag
  them onto the timeline, or drop audio files in from your file manager.
- **Tempo-following audio**: recordings and audio clips time-stretch (keeping their pitch) when you
  change the song tempo; turn off **Follow tempo** in the audio editor for clips that shouldn't.
- **Arranging audio**: drag an audio clip's bottom-right corner to extend it with silence (e.g. to
  fill whole bars) and its top-right corner to repeat it; clips snap to the grid when moved.
- **Recording**: record your mic or audio interface onto audio tracks (pick the device and input
  1, 2 or both; latency compensation; count-in), or record MIDI keyboards and Musical Typing onto
  instrument tracks.
- **Guitar & bass**: a "Guitar / Bass" track with an amp sim (Clean, Vintage, Crunch, Lead, Metal,
  Bass: gain, tone stack, presence, noise gate) and a speaker cabinet: four built-in voicings, or
  **Load IR…** to use any cabinet impulse response WAV. Monitor through it while you play; recordings
  stay clean (DI), so you can change the amp afterwards. Monitoring latency depends on your OS audio
  (shown in the app; ~24 ms on Linux/PipeWire with Low-latency mode).
- **Editing**: piano roll and drum grid with Pointer, Pencil, Eraser and Box-select tools; copy,
  cut, paste and duplicate for notes and regions; Alt-drag to copy; the piano keys light up for
  selected notes; region loop/resize/split; undo/redo.
- **Settings** (⚙ or Ctrl+,): audio performance mode (Stable for slower computers, Balanced, Low
  latency), input device, recording offset, count-in, metronome level, and light/dark/system theme.
- **Mixing**: per-track volume, pan, tone, drive, reverb, echo and a Bass/Mid/Treble EQ; master
  bus compressor/limiter.
- **Automation**: press a track's **A** button for a lane under it; click to add points for volume,
  pan, reverb, echo, tone or EQ, drag them, right-click to remove. Plays back (and exports) exactly.
- **Effects**: Vinyl (crackle, pops, age, wow), Tape, Radio and Lo-Fi, on any track or on the whole
  mix (Master FX). Crackle and hiss only play while the song does.
- **Export**: the whole song or the cycle range as MP3 (128/192/320 kbps), FLAC, or 16/24-bit WAV,
  or the notes as a MIDI file for other music apps.
- **MIDI files**: Open (or drop) a `.mid` to add its parts as tracks; General MIDI instruments map
  to built-in sounds, channel 10 becomes a drum track, and sustain-pedal data is kept.

## Run it

```sh
npm install        # also downloads the ~78 MB sample library into assets/samples/
npm start
```

If the samples didn't download (offline install), run `npm run fetch-samples` later. Until then,
sampled instruments fall back to built-in synths.

## Your own instruments

Sounds → **My Instruments** → **＋ SF2 / SFZ…** or **＋ Folder…** (or drop files on the window).

- **SoundFont 2**: all presets, key/velocity zones, loops, volume and filter envelopes, tuning,
  exclusive classes (hi-hat choke). Compressed .sf3 files are not supported yet.
- **SFZ**: `#define`/`#include`, `<global>/<master>/<group>/<region>`, velocity layers and curves,
  loops (including loop points embedded in WAV/FLAC), round-robin and random layers, release
  triggers, choke groups, filters with envelopes, keyswitches, and CC-driven opcodes evaluated at
  their `set_ccN` defaults. Samples load fully into memory, so multi-gigabyte libraries need
  plenty of RAM.
- Songs store references to the files, not the samples. On another machine, re-import the same
  files; until then the tracks play a stand-in synth.

## Plugins (VST3)

Sounds → **Plugins** lists the instrument plugins installed on your computer: VST3 on Windows and
Linux, plus LV2 on Linux. Click one to use it on a track, and
**Open Plugin Window** (in Smart Controls) shows the plugin's own interface. Plugin settings are
saved in the song. **⟳ Rescan** finds newly installed plugins; **＋ Folder…** adds a folder outside
the usual locations.

Basement Band ships with **[Dexed](https://github.com/asb2m10/dexed)**, a free FM synth modelled on
the Yamaha DX7 (GPL-3.0), so there is always a plugin to play.

How it works: plugins run in a separate helper program (`native/plugin-host`, C++/JUCE), so a
crashing plugin can't take the app down; it is restarted and the plugins are reloaded. The helper
renders each plugin slightly ahead of the audio clock and streams the audio into the track, so
plugin tracks play sample-accurately in time with everything else and go through the same mixer,
effects and automation. Playing a plugin live from a keyboard adds ~30–50 ms (the render-ahead,
depending on Settings → Audio performance). Exports render plugins faster than real time.

Building the helper locally needs CMake and a C++17 compiler (on Linux also the ALSA, FreeType and
X11 development packages):

```sh
npm run build:plugin-host    # downloads JUCE 9 and builds native/plugin-host/build/...
npm run fetch-plugins        # downloads Dexed into plugins/
npm run check:plugin-host    # loads Dexed in the helper and plays a note
```

Without the helper the app still runs; the Plugins section just says plugin support isn't included.

## Build installers

```sh
npm run dist:linux   # dist/Basement Band-<version>-linux-x86_64.AppImage and .deb
npm run dist:win     # dist/Basement Band-Setup-<version>.exe and -Portable-<version>.exe
```

Windows builds can be made on Linux if `wine` is installed. Installers bundle the sample library,
so the app works offline. To include plugin support, build the helper and fetch Dexed first (see
Plugins); the release workflow does this on each platform.

## Releases

Publishing a GitHub release builds the app and attaches the installers to it
(`.github/workflows/release.yml`):

1. Create a release with a version tag such as `v0.2.0` (the app version is taken from the tag).
2. Publish it. The **Release** workflow builds the Linux AppImage and `.deb` and the Windows installer
   and portable `.exe` (each with plugin support and Dexed), and uploads them to that release (about
   15–20 minutes).

To rebuild artifacts for an existing release, run the workflow manually from the Actions tab and
enter its tag. Every push and pull request also runs the unit tests (`.github/workflows/ci.yml`).
Builds aren't signed with a paid certificate, so Windows SmartScreen warns on first launch.

**Test build:** to try the installers before releasing, run the **Release** workflow from the Actions
tab and leave the tag empty. It builds everything from the chosen branch and attaches the installers
to that workflow run (under Artifacts) instead of a release.

## Current limitations

- **Audio performance:** if playback crackles or stutters on a slower computer, choose **Stable** in
  Settings (bigger buffers). **Low latency** trades smoothness for responsiveness.
- **Latency:** audio runs through Chromium's Web Audio, so there's no ASIO/JACK-level low latency.
  Measured guitar monitoring on Linux/PipeWire: ~60 ms by default, ~24 ms with **Low-latency mode**
  (Settings → Audio performance; smallest Chromium buffers, and PipeWire's quantum lowered to 128 frames while
  monitoring). Getting below ~10 ms needs a native audio path (see the roadmap). Until then, your
  interface's hardware direct monitoring gives zero-latency (dry) monitoring while recording.
- **One time signature per song.** Tempo can change partway through (right-click the ruler), but
  the meter can't yet. An audio clip spanning a tempo change follows the tempo where it starts.
- **Time-stretching** (WSOLA) keeps pitch and timing but can smear very dense or percussive audio at
  big tempo changes (more than about ±30%).
- **Plugins:** instrument plugins only for now. Effect plugins (on a track's insert) aren't
  supported yet. Plugin windows open as separate windows, not inside the app. Playing a plugin live
  has a little more latency than built-in sounds. VST2 isn't supported (its SDK is no longer
  available), and neither is CLAP yet.
- **Automation covers the mixer settings** (volume, pan, reverb, echo, tone, EQ), not effect or amp
  knobs yet, and lanes don't move with regions.
- **Songs embed their recordings** (as lossless FLAC, about half the size of WAV) inside the `.bband`
  file, so songs with many long takes still get large.
- **User instruments are referenced, not copied:** move a SoundFont/SFZ and songs using it fall back
  to a stand-in synth until it is re-imported.
- **SoundFont/SFZ:** no `.sf3` (compressed) files; the sustain pedal works, but other MIDI controllers (mod
  wheel, pitch bend) don't change sounds yet; large libraries load fully into memory.
- **MIDI files** use one tempo (the file's first) and don't carry controller data beyond sustain.
- **The Freesound recordings are high-quality previews** (128 kbps MP3), not the original WAVs.
- **Windows builds are tested only under Wine** in development, not on real Windows hardware.

## Roadmap

Roughly in priority order:

1. ~~Automation lanes~~ (done for mixer settings; effect and amp knobs next).
2. ~~Sustain pedal~~ (done: MIDI CC64 and Tab in Musical Typing). Still to do: mod wheel, pitch
   bend and other MIDI CCs driving SoundFont/SFZ and synth sounds.
3. ~~MIDI file import/export~~ (done).
4. ~~Tempo-following audio~~ (done: clips time-stretch to the song tempo; Follow tempo can be turned
   off per clip).
5. ~~Tempo changes~~ within a song (done); time-signature changes still to do.
6. ~~Smaller song files~~ (recordings now stored as FLAC); optionally keep audio in a folder beside
   the song.
7. ~~VST3 instrument plugins~~ (done, with Dexed bundled). Next: **effect plugins** on track
   inserts, CLAP, and moving live audio (input monitoring, the amp sim) into the native helper
   with JACK/PipeWire/ASIO/WASAPI for sub-10 ms guitar monitoring.
8. ~~More amp models and cabinet IR loading~~ (done: Vintage and Metal, four cabinets, custom IRs).
9. ~~Arrangement markers~~ (done: song sections with duplicate/delete/loop). Next: let the Session
   Band build a whole song structure (intro, verses, choruses) in one go.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / stop |
| R | Record |
| Enter | Go to start (or cycle start) |
| C | Cycle on/off |
| K | Metronome |
| Ctrl+K | Musical Typing (A–' play notes, Z/X octave, C/V velocity, Tab sustain) |
| Y / B / E | Library / Smart Controls / Editor |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste notes (in the editor) or regions |
| Ctrl+D | Duplicate selected notes or regions |
| 1 / 2 / 3 / 4 | Editor tools: Pointer, Pencil, Eraser, Box select |
| Ctrl+, | Settings |
| Ctrl+T | Split region at playhead |
| Delete | Delete regions or selected notes |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S / Ctrl+O / Ctrl+N | Save / open / new |
| Ctrl+E | Export (MP3, FLAC or WAV) |
| Ctrl+scroll | Zoom timeline or editor |
| Alt-drag region | Copy region |
| Region top-right corner | Drag to loop; bottom-right corner resizes |

## Project layout

```
main.js, preload.js         Electron shell (app:// protocol, file dialogs, settings)
src/app.js                  controller: transport, recording, files, shortcuts
src/state.js                song model and undo store
src/music/theory.js         notes, chords, roman numerals, voicings
src/music/band.js           styles + drum/bass/comping generators
src/engine/instruments.js   instrument library (samplers, synth presets, drum kits)
src/engine/engine.js        mixer graph, scheduling, recording, offline export
src/engine/plugins.js       plugin instruments: scanning, streaming from the helper, export
plugin-host.js              main-process side of plugin hosting (scan, helper process)
native/plugin-host/         the native plugin helper (C++/JUCE, AGPL-3.0)
src/ui/*                    arrange view, editors, smart controls, library
scripts/fetch-samples.mjs   downloads the sample library
scripts/fetch-plugins.mjs   downloads the bundled plugins (Dexed)
test/                       unit tests and headless end-to-end checks
```

## Tests

```sh
npm test         # music theory and generator unit tests
npm run smoke    # end-to-end flows in a hidden app window (Linux, needs xvfb-run; forces X11 so
                 # nothing opens on a Wayland desktop). Plugins are exercised with a stand-in
                 # helper (test/fake-plugin-host.cjs), so no native build is needed
npm run check:plugin-host  # the real helper with Dexed (CI runs this on Linux and Windows)
npm run levels   # renders every instrument and prints its loudness
npm run test:instruments   # SoundFont/SFZ/folder import + playback checks (uses FluidR3_GM.sf2
                           # if installed; set BB_SFZ_TEST_DIR to a folder of SFZ libraries)
```

## Licenses

The code is MIT licensed, except the plugin helper in `native/plugin-host`, which is built with
JUCE and is therefore AGPL-3.0; it is a separate program the app talks to over pipes. The bundled
Dexed plugin is GPL-3.0 (source: https://github.com/asb2m10/dexed). MP3 export uses LAME via `@breezystack/lamejs` (LGPL-3.0), shipped as a
separate, replaceable file. The sample library is not covered by MIT. It comes from the Salamander
Grand Piano, VSCO 2 Community Edition, Karoryfer, University of Iowa MIS and Freesound (CC-BY 3.0),
plus the Hydrogen drum kits (GPL). See `assets/samples/CREDITS.md`, which the app also opens from
Library → Sounds → Credits.
