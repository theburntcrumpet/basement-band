// WAV encoding plus base64 helpers for storing audio inside song files.

export function encodeWav(audioBuffer, bitDepth = 16) {
  const channels = audioBuffer.numberOfChannels;
  const rate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const bytes = bitDepth / 8;
  const dataSize = frames * channels * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));
  let o = 44;
  const max = Math.pow(2, bitDepth - 1) - 1;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      const n = Math.round(s * max);
      if (bitDepth === 16) v.setInt16(o, n, true);
      else { v.setUint8(o, n & 0xff); v.setUint8(o + 1, (n >> 8) & 0xff); v.setInt8(o + 2, n >> 16); }
      o += bytes;
    }
  }
  return buf;
}

export function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

// Peak envelope for waveform drawing: `buckets` max-abs values in [0, 1].
export function peaks(audioBuffer, buckets) {
  const data = audioBuffer.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / buckets));
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const end = Math.min(data.length, (b + 1) * size);
    for (let i = b * size; i < end; i += 4) m = Math.max(m, Math.abs(data[i]));
    out[b] = m;
  }
  return out;
}
