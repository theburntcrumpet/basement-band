// Time signatures. Positions everywhere are in quarter-note beats; a bar is num * 4/den of them.

export const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'];

export const DEFAULT_TIME_SIG = { num: 4, den: 4 };

export function meter(ts = DEFAULT_TIME_SIG) {
  const { num, den } = ts;
  const pulse = 4 / den;                         // one counted beat, in quarters
  return {
    num,
    den,
    label: `${num}/${den}`,
    pulse,
    barBeats: num * pulse,                       // bar length in quarters
    steps: (num * 16) / den,                     // sixteenth-note steps per bar
    compound: den === 8 && num % 3 === 0,        // 6/8, 9/8, 12/8: felt in dotted quarters
  };
}

export function parseTimeSig(label) {
  const [num, den] = label.split('/').map(Number);
  return { num, den };
}

// 1-based bar and beat (counted in the signature's own beat unit) for a position.
export function barBeat(pos, ts) {
  const m = meter(ts);
  const bar = Math.floor(pos / m.barBeats + 1e-9);
  const beat = Math.floor((pos - bar * m.barBeats) / m.pulse + 1e-9);
  return { bar: bar + 1, beat: beat + 1 };
}
