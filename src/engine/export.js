// Export formats: rendered AudioBuffer -> file bytes.

import { encodeWav } from './wav.js';
import { encodeFlac } from './formats/flac.js';

export const EXPORT_FORMATS = [
  { id: 'mp3-320', label: 'MP3 · 320 kbps (best)', ext: 'mp3', kbps: 320 },
  { id: 'mp3-192', label: 'MP3 · 192 kbps', ext: 'mp3', kbps: 192 },
  { id: 'mp3-128', label: 'MP3 · 128 kbps (smallest)', ext: 'mp3', kbps: 128 },
  { id: 'flac', label: 'FLAC · lossless, about half the size of WAV', ext: 'flac' },
  { id: 'wav16', label: 'WAV · 16-bit (CD quality)', ext: 'wav', bits: 16 },
  { id: 'wav24', label: 'WAV · 24-bit (for mastering)', ext: 'wav', bits: 24 },
  { id: 'midi', label: 'MIDI · notes only, for other music apps (.mid)', ext: 'mid' },
];

// MP3 frames are 1152 samples; LAME supports these MPEG-1 rates.
export const MP3_RATES = [32000, 44100, 48000];

const yieldToUi = () => new Promise(r => setTimeout(r, 0));

function toInt16(data) {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
  return out;
}

// Mp3Encoder is passed in so Node tests can supply the same LAME build the app loads.
export async function encodeMp3(channels, sampleRate, kbps, Mp3Encoder, onProgress) {
  if (!MP3_RATES.includes(sampleRate)) throw new Error(`MP3 needs 32, 44.1 or 48 kHz audio (got ${sampleRate} Hz)`);
  const stereo = channels.length > 1;
  const left = toInt16(channels[0]);
  const right = stereo ? toInt16(channels[1]) : null;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const parts = [];
  const step = 1152 * 32;
  for (let i = 0; i < left.length; i += step) {
    const l = left.subarray(i, i + step);
    const chunk = stereo ? enc.encodeBuffer(l, right.subarray(i, i + step)) : enc.encodeBuffer(l);
    if (chunk.length) parts.push(new Uint8Array(chunk));
    if ((i / step) % 16 === 0) { onProgress?.(i / left.length); await yieldToUi(); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  onProgress?.(1);
  return out;
}

export async function encodeAudio(buffer, formatId, onProgress) {
  const fmt = EXPORT_FORMATS.find(f => f.id === formatId) || EXPORT_FORMATS[0];
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  if (fmt.ext === 'wav') return new Uint8Array(encodeWav(buffer, fmt.bits));
  if (fmt.ext === 'flac') {
    await yieldToUi();
    return encodeFlac(channels, buffer.sampleRate);
  }
  const { Mp3Encoder } = await import('../vendor/lamejs.js');
  return encodeMp3(channels, buffer.sampleRate, fmt.kbps, Mp3Encoder, onProgress);
}
