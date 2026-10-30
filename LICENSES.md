# Licenses

Basement Band is free software, and everything it ships can be freely shared. This file lists each
part and its license; the full texts are in [`licenses/`](licenses/). It's a summary to help you
comply, not legal advice.

## Basement Band

| Part | License | Text |
|---|---|---|
| The app (`main.js`, `preload.js`, `plugin-host.js`, `src/`, `scripts/`, `test/`) | MIT | [`LICENSE`](LICENSE) |
| The native helper (`native/plugin-host`), a separate program the app talks to over pipes | AGPL-3.0-or-later (because it's built with JUCE) | [`native/plugin-host/LICENSE`](native/plugin-host/LICENSE), [`licenses/AGPL-3.0.txt`](licenses/AGPL-3.0.txt) |

Source code: https://github.com/theburntcrumpet/basement-band

## Bundled software

| Component | Used for | License | Source |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) (with Chromium) | The app shell | MIT; Chromium's many notices ship beside the app as `LICENSES.chromium.html` | https://github.com/electron/electron |
| [Tone.js](https://tonejs.github.io/) (bundled with standardized-audio-context, automation-events and tslib) | Audio scheduling and the original engine | MIT (tslib: 0BSD) | https://github.com/Tonejs/Tone.js |
| [LAME](https://lame.sourceforge.io/) via [@breezystack/lamejs](https://github.com/breezystack/lamejs) | MP3 export; shipped as a separate, replaceable file | LGPL-3.0 ([`licenses/LGPL-3.0.txt`](licenses/LGPL-3.0.txt), [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt)) | https://github.com/breezystack/lamejs |
| [JUCE](https://juce.com/) 9 | The native helper | AGPL-3.0 ([`licenses/AGPL-3.0.txt`](licenses/AGPL-3.0.txt)); its own third-party notices are in JUCE's `LICENSE.md` | https://github.com/juce-framework/JUCE |
| Steinberg ASIO SDK headers (bundled with JUCE, Windows only) | ASIO audio devices | GPL-3.0 option ([`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt)) | Included in JUCE |
| [Dexed](https://github.com/asb2m10/dexed) 1.0.1 | A bundled FM synth plugin, run as a separate plugin | GPL-3.0 ([`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt), also `plugins/Dexed-LICENSE.txt`) | https://github.com/asb2m10/dexed/releases/download/v1.0.1/dexed-source-bce5dee.tar.gz |

The app's built-in synth presets, generated effects, loops and icons are part of the app (MIT).

## Bundled sounds

The sample library is downloaded by `scripts/fetch-samples.mjs` and isn't part of this repository.
Every file is credited in `assets/samples/CREDITS.md` (Library → Sounds → Credits in the app).

| Sounds | Source | License | Text |
|---|---|---|---|
| Harpsichords, upright and FM pianos, clavisynth, marimba, vibraphone, glockenspiel, chimes, kalimba, folk harp, dan tranh, psaltery, recorder, ocarina, soprano sax, harmonica, percussion samples | [Versilian Community Sample Library](https://github.com/sgossner/VCSL) | CC0 1.0 | [`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt) |
| String sections, pizzicato, staccato and tremolo strings, bowed and pizzicato double bass, vibrato and muted brass, brass and horn stabs, oboe, piccolo | [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE) | CC0 1.0 | [`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt) |
| Field recordings and effects | Freesound and Sonic Pi; each is listed in the credits | CC0 1.0 | [`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt) |
| Harmonium | Freesound, donyaquick | CC0 1.0 | [`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt) |
| Grand piano | Salamander Grand Piano V2, Alexander Holm (via Tonejs/audio) | CC-BY 3.0 | [`licenses/CC-BY-3.0.txt`](licenses/CC-BY-3.0.txt) |
| Electric bass, electric guitars, tenor sax | Karoryfer Samples (via tonejs-instruments) | CC-BY 3.0 | [`licenses/CC-BY-3.0.txt`](licenses/CC-BY-3.0.txt) |
| Original orchestral set: bassoon, contrabass, flute, French horn, harp, pipe organ, trombone, trumpet, tuba, violin, xylophone | VSCO 2 Community Edition (via tonejs-instruments) | CC-BY 3.0 as distributed there | [`licenses/CC-BY-3.0.txt`](licenses/CC-BY-3.0.txt) |
| Acoustic guitar | University of Iowa Electronic Music Studios (via tonejs-instruments) | CC-BY 3.0 as distributed there | [`licenses/CC-BY-3.0.txt`](licenses/CC-BY-3.0.txt) |
| Clarinet | tonejs-instruments, which doesn't name this recording's origin | CC-BY 3.0 as distributed there | [`licenses/CC-BY-3.0.txt`](licenses/CC-BY-3.0.txt) |
| Cello | Freesound, flcellogrl (via tonejs-instruments) | CC-BY 4.0 on Freesound | [`licenses/CC-BY-4.0.txt`](licenses/CC-BY-4.0.txt) |
| Nylon guitar | Freesound, quartertone (via tonejs-instruments) | CC-BY 4.0 on Freesound | [`licenses/CC-BY-4.0.txt`](licenses/CC-BY-4.0.txt) |
| Rock and Lo-Fi drum kits | Hydrogen GMRockKit, Glen MacArthur / Sebastian Moors | GPL-3.0-or-later | [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) |
| 808 drum kit | Hydrogen TR808EmulationKit, ArtemioLabs | GPL-3.0-or-later | [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) |

## If you redistribute Basement Band

- Keep this file, `LICENSE`, `licenses/` and `assets/samples/CREDITS.md` with it. Installers already do.
- CC-BY sounds need their authors credited, and the GPL and AGPL parts need their source code to stay
  available. The links above cover that for unmodified copies; publish your changes if you make any.
- Sounds you import yourself (SoundFonts, SFZ, folders, plugins) keep their own licenses, and aren't
  bundled.
