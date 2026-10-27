// The normalized sample region shared by the SF2 and SFZ parsers and the MultiSampler player.
// Times are seconds, pitches are midi notes/cents, gains are dB unless noted.

export function defaultRegion() {
  return {
    sample: null,            // SFZ: sample file path; SF2: sample header index
    lokey: 0, hikey: 127, lovel: 1, hivel: 127,
    root: 60,
    keytrack: 1,             // 1 = 100 cents per key
    tune: 0,                 // cents
    gainDb: 0,
    pan: 0,                  // -1..1
    veltrack: 1,             // 0..1, how much velocity affects level
    velcurve: null,          // [[velocity, gain 0..1], ...]
    env: { delay: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.001 },
    loop: { mode: 'auto', frames: null }, // 'auto' | 'none' | 'continuous' | 'sustain' | 'one_shot'
    offsetFrames: 0,
    offsetRandomFrames: 0,
    endFrames: null,
    trigger: 'attack',       // 'attack' | 'release' | 'first' | 'legato'
    seqLength: 1, seqPosition: 1,
    lorand: 0, hirand: 1,
    group: 0, offBy: null,   // choke: a new note in group G silences voices whose offBy is G
    conds: [],               // [{cc, lo, hi}] evaluated at CC defaults
    swRange: null, swLast: null, swDown: null,
    filter: null,            // {type, cutoff Hz, resonance dB, keytrack, keycenter, veltrack, egDepth cents, eg}
  };
}

// MIDI controller values before any are moved: volume 100, pan centre, expression full.
export function ccDefaults() {
  const cc = new Array(128).fill(0);
  cc[7] = 100;
  cc[10] = 64;
  cc[11] = 127;
  return cc;
}
