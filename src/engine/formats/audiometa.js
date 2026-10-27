// Reads what decodeAudioData throws away: the file's own sample rate and embedded loop points.
// WAV keeps loops in a 'smpl' chunk; FLAC files converted with --keep-foreign-metadata carry the
// same chunk inside APPLICATION 'riff' blocks.

const ascii = (v, o, n) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + o, n));

function parseSmpl(v, o) {
  const loops = v.getUint32(o + 28, true);
  if (!loops) return null;
  const start = v.getUint32(o + 36 + 8, true);
  const end = v.getUint32(o + 36 + 12, true);
  return end > start ? { start, end: end + 1 } : null;
}

function wavMeta(v) {
  const out = { rate: null, loop: null };
  let o = 12;
  while (o + 8 <= v.byteLength) {
    const id = ascii(v, o, 4);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') out.rate = v.getUint32(o + 12, true);
    if (id === 'smpl' && size >= 36) out.loop = parseSmpl(v, o + 8);
    o += 8 + size + (size & 1);
  }
  return out;
}

function flacMeta(v) {
  const out = { rate: null, loop: null };
  let o = 4;
  for (let guard = 0; guard < 256 && o + 4 <= v.byteLength; guard++) {
    const header = v.getUint8(o);
    const type = header & 0x7f;
    const len = (v.getUint8(o + 1) << 16) | (v.getUint8(o + 2) << 8) | v.getUint8(o + 3);
    const body = o + 4;
    if (type === 0) out.rate = (v.getUint8(body + 10) << 12) | (v.getUint8(body + 11) << 4) | (v.getUint8(body + 12) >> 4);
    if (type === 2 && len >= 12 && ascii(v, body, 4) === 'riff' && ascii(v, body + 4, 4) === 'smpl') {
      out.loop = parseSmpl(v, body + 12);
    }
    o = body + len;
    if (header & 0x80) break;
  }
  return out;
}

function oggMeta(v) {
  // Vorbis identification header: "\x01vorbis" then version(4), channels(1), rate(4).
  for (let o = 0; o < Math.min(v.byteLength - 16, 512); o++) {
    if (v.getUint8(o) === 1 && ascii(v, o + 1, 6) === 'vorbis') return { rate: v.getUint32(o + 12, true), loop: null };
  }
  return { rate: null, loop: null };
}

// -> {rate: Hz | null, loop: {start, end} in source frames | null}
export function audioMeta(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 16) return { rate: null, loop: null };
  const magic = ascii(v, 0, 4);
  try {
    if (magic === 'RIFF' && ascii(v, 8, 4) === 'WAVE') return wavMeta(v);
    if (magic === 'fLaC') return flacMeta(v);
    if (magic === 'OggS') return oggMeta(v);
  } catch {
    // Truncated or odd metadata: loops are optional, so carry on without them.
  }
  return { rate: null, loop: null };
}
