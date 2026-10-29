// Runs time-stretching off the main thread (a few minutes of stereo takes a second or two).
import { timeStretch } from './stretch.js';

self.onmessage = e => {
  const { id, channels, factor, rate } = e.data;
  const out = timeStretch(channels, factor, rate);
  self.postMessage({ id, channels: out }, out.map(c => c.buffer));
};
