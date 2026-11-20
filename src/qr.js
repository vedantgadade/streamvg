// Small QR Code encoder (byte mode, error correction level L, versions 1-6 = up to 134 bytes).
// It exists so the phone-remote pairing code is drawn locally instead of being sent to a third-party
// image service (api.qrserver.com) inside the image URL.

// Per version: total data codewords, EC codewords per block, number of blocks.
const SPEC = [null,
  { data: 19, ecc: 7, blocks: 1 }, { data: 34, ecc: 10, blocks: 1 }, { data: 55, ecc: 15, blocks: 1 },
  { data: 80, ecc: 20, blocks: 1 }, { data: 108, ecc: 26, blocks: 1 }, { data: 136, ecc: 18, blocks: 2 },
];
export const QR_MAX_BYTES = SPEC[6].data - 2;

const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function reedSolomon(data, degree) {
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= gmul(c, EXP[i]); });
    gen = next;
  }
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

function codewordsFor(bytes, version) {
  const { data, ecc, blocks } = SPEC[version];
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4); put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, data * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < data; pad ^= 0xec ^ 0x11) words.push(pad);
  const size = data / blocks, dataBlocks = [], eccBlocks = [];
  for (let b = 0; b < blocks; b++) { const block = words.slice(b * size, (b + 1) * size); dataBlocks.push(block); eccBlocks.push(reedSolomon(block, ecc)); }
  const out = [];
  for (let i = 0; i < size; i++) dataBlocks.forEach(b => out.push(b[i]));
  for (let i = 0; i < ecc; i++) eccBlocks.forEach(b => out.push(b[i]));
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let score = 0, dark = 0;
  const runs = line => { let s = 0, run = 1; for (let i = 1; i <= line.length; i++) { if (i < line.length && line[i] === line[i - 1]) run++; else { if (run >= 5) s += 3 + run - 5; run = 1; } } return s; };
  const pattern = line => { let s = 0; const str = line.map(v => (v ? 1 : 0)).join(''); for (const re of [/10111010000/g, /00001011101/g]) s += 40 * (str.match(re) || []).length; return s; };
  for (let y = 0; y < n; y++) { score += runs(m[y]) + pattern(m[y]); const col = m.map(r => r[y]); score += runs(col) + pattern(col); }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  for (const row of m) for (const v of row) if (v) dark++;
  return score + 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
}

/** Returns the QR modules as an array of rows of booleans (true = dark), without a quiet zone. */
export function qrModules(text) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 1;
  while (version <= 6 && bytes.length > SPEC[version].data - 2) version++;
  if (version > 6) throw new RangeError('Text is too long for the built-in QR encoder');
  const size = 17 + 4 * version;
  const mods = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mods[y][x] = dark; fn[y][x] = true; };

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
  for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = mask => {
    const data = (1 << 3) | mask; // error correction level L = 01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserve the format areas

  const words = codewordsFor(bytes, version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fn[y][x] && bitIndex < words.length * 8) { mods[y][x] = ((words[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1; bitIndex++; }
    }
  }

  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = mods.map(r => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) trial[y][x] = !trial[y][x];
    const saved = mods.map(r => r.slice());
    for (let y = 0; y < size; y++) mods[y] = trial[y];
    drawFormat(mask);
    const result = mods.map(r => r.slice());
    for (let y = 0; y < size; y++) mods[y] = saved[y];
    const score = penalty(result);
    if (score < bestScore) { bestScore = score; best = result; }
  }
  return best;
}

/** SVG path data + total size (including the 4-module quiet zone) for drawing the code. */
export function qrPath(text, quiet = 4) {
  const m = qrModules(text);
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z'; }));
  return { size: m.length + quiet * 2, d };
}
