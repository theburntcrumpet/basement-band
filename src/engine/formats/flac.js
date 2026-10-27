// A compact FLAC encoder (16-bit, fixed predictors, Rice-coded residuals). Lossless, typically
// around half the size of a WAV. Pure JS so it runs in the app and in Node tests.

const BLOCK = 4096;

class BitWriter {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.pos = 0;   // bytes
    this.acc = 0;   // pending bits (MSB first)
    this.n = 0;     // number of pending bits
  }
  ensure(extra) {
    if (this.pos + extra < this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 1024));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  write(value, bits) {
    // Values up to 32 bits, written in chunks so the accumulator never overflows.
    while (bits > 24) {
      bits -= 16;
      this.write((value / 2 ** bits) & 0xffff, 16);
      value = value % 2 ** bits;
    }
    this.ensure(8);
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }
  unary(q) {
    // q zeros then a one.
    while (q >= 24) { this.write(0, 24); q -= 24; }
    this.write(1, q + 1);
  }
  align() {
    if (this.n) this.write(0, 8 - this.n);
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b, from, to) => { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, from, to) => { let c = 0; for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

// FLAC's "UTF-8" coding of the frame number.
function utf8Number(w, n) {
  if (n < 0x80) return w.write(n, 8);
  const bytes = [];
  let lead = 0x80, max = 0x3f;
  while (n > max) {
    bytes.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
    lead = (lead >> 1) | 0x80;
    max >>= 1;
  }
  w.write(lead | n, 8);
  for (const b of bytes) w.write(b, 8);
}

function residuals(x, order) {
  const n = x.length, r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: r[i] = x[i]; break;
      case 1: r[i - 1] = x[i] - x[i - 1]; break;
      case 2: r[i - 2] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r[i - 3] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r[i - 4] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
  return r;
}

const zigzag = v => (v >= 0 ? v * 2 : -v * 2 - 1);

function riceBits(u, from, to, k) {
  let bits = 0;
  for (let i = from; i < to; i++) bits += Math.floor(u[i] / 2 ** k) + 1 + k;
  return bits;
}

function bestRice(u, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += u[i];
  const mean = sum / Math.max(1, to - from);
  let guess = Math.max(0, Math.min(14, Math.floor(Math.log2(mean + 1))));
  let best = guess, bestBits = riceBits(u, from, to, guess);
  for (const k of [guess - 1, guess + 1]) {
    if (k < 0 || k > 14) continue;
    const b = riceBits(u, from, to, k);
    if (b < bestBits) { best = k; bestBits = b; }
  }
  return { k: best, bits: bestBits };
}

// Picks the partition order (0..6) with the fewest bits for this residual.
function planPartitions(u, blockSize, order) {
  let best = null;
  for (let p = 0; p <= 6; p++) {
    const parts = 1 << p;
    if (blockSize % parts || (blockSize >> p) <= order) break;
    const size = blockSize >> p;
    const ks = [];
    let bits = 0, from = 0;
    for (let i = 0; i < parts; i++) {
      const to = (i + 1) * size - order;
      const { k, bits: b } = bestRice(u, from, to);
      ks.push(k);
      bits += b + 4;
      from = to;
    }
    if (!best || bits < best.bits) best = { p, ks, bits, size };
  }
  return best;
}

function writeSubframe(w, x, bps) {
  if (x.every(v => v === x[0])) {
    w.write(0, 1); w.write(0, 6); w.write(0, 1);
    w.write(x[0] & ((1 << bps) - 1), bps);
    return;
  }
  // Choose the fixed predictor order with the smallest residual.
  let order = 0, bestSum = Infinity, bestR = null;
  for (let o = 0; o <= Math.min(4, x.length - 1); o++) {
    const r = residuals(x, o);
    let s = 0;
    for (let i = 0; i < r.length; i++) s += Math.abs(r[i]);
    if (s < bestSum) { bestSum = s; order = o; bestR = r; }
  }
  const u = new Float64Array(bestR.length);
  for (let i = 0; i < u.length; i++) u[i] = zigzag(bestR[i]);
  const plan = planPartitions(u, x.length, order);
  w.write(0, 1); w.write(0b001000 | order, 6); w.write(0, 1);
  for (let i = 0; i < order; i++) w.write(x[i] & ((1 << bps) - 1), bps);
  w.write(0, 2);         // Rice coding with 4-bit parameters
  w.write(plan.p, 4);
  let idx = 0;
  for (let part = 0; part < plan.ks.length; part++) {
    const k = plan.ks[part];
    w.write(k, 4);
    const count = plan.size - (part === 0 ? order : 0);
    for (let i = 0; i < count; i++, idx++) {
      const v = u[idx];
      w.unary(Math.floor(v / 2 ** k));
      if (k) w.write(v % 2 ** k, k);
    }
  }
}

// channels: array of Float32Array (-1..1). Returns a Uint8Array .flac file.
export function encodeFlac(channels, sampleRate) {
  const nch = channels.length, total = channels[0].length;
  const ints = channels.map(c => {
    const out = new Int32Array(total);
    for (let i = 0; i < total; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
    return out;
  });
  const w = new BitWriter(Math.max(1 << 16, total * nch));
  w.write(0x664c6143, 32);  // "fLaC"
  // STREAMINFO (last metadata block).
  w.write(1, 1); w.write(0, 7); w.write(34, 24);
  w.write(BLOCK, 16); w.write(BLOCK, 16);
  w.write(0, 24); w.write(0, 24);
  w.write(sampleRate, 20); w.write(nch - 1, 3); w.write(15, 5);
  w.write(Math.floor(total / 2 ** 32), 4); w.write(total >>> 0, 32);
  for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 unknown

  for (let start = 0, frame = 0; start < total; start += BLOCK, frame++) {
    const size = Math.min(BLOCK, total - start);
    const headerStart = w.pos;
    w.write(0b11111111111110, 14); w.write(0, 1); w.write(0, 1);
    w.write(size === BLOCK ? 0b1100 : 0b0111, 4);
    w.write(0, 4);                            // sample rate from STREAMINFO
    w.write(nch === 2 ? 0b0001 : 0b0000, 4);  // independent channels
    w.write(0b100, 3); w.write(0, 1);         // 16-bit
    utf8Number(w, frame);
    if (size !== BLOCK) w.write(size - 1, 16);
    w.write(crc8(w.buf, headerStart, w.pos), 8);
    for (const c of ints) writeSubframe(w, c.subarray(start, start + size), 16);
    w.align();
    w.write(crc16(w.buf, headerStart, w.pos), 16);
  }
  return w.bytes().slice();
}
