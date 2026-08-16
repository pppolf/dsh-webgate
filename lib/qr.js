// dsh-webgate — compact QR encoder (byte mode, EC level L, versions 1..40).
// Pure JS, zero dependencies. Renders SVG (data URL) and terminal blocks.

// ---- GF(256) arithmetic (primitive polynomial 0x11D) ----
const EXP = new Array(256).fill(0);
const LOG = new Array(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);
const gfPolyMul = (a, b) => {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  return out;
};
const rsGenerator = (ecCount) => {
  let g = [1];
  for (let i = 0; i < ecCount; i++) g = gfPolyMul(g, [1, EXP[i]]);
  return g;
};

// ---- Capacity / block tables (EC level L) ----
// Total data codewords per version (level L).
const DATA_CODEWORDS_L = [0,
  19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 589,
  647, 721, 795, 861, 932, 1006, 1094, 1174, 1276, 1370, 1468, 1531, 1631, 1735,
  1843, 1955, 2071, 2191, 2306, 2434, 2566, 2702, 2812, 2956
];
// (blocks, ec codewords per block) per version, level L.
const BLOCKS_L = [
  null,
  [1, 7], [1, 10], [1, 15], [1, 20], [1, 26], [2, 18], [2, 20], [2, 24], [2, 30], [2, 18],
  [4, 20], [4, 24], [4, 26], [4, 30], [6, 22], [6, 24], [6, 28], [6, 30], [7, 28], [8, 28],
  [8, 28], [9, 28], [9, 30], [10, 30], [12, 26], [12, 28], [12, 30], [13, 30], [14, 30], [15, 30],
  [16, 30], [17, 30], [18, 30], [19, 30], [19, 30], [20, 30], [21, 30], [22, 30], [24, 30], [25, 30]
];
// Alignment pattern center positions per version.
const ALIGNMENT = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
];

const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // 2-bit indicators per spec

const byteCapacity = (version) => {
  const bits = DATA_CODEWORDS_L[version] * 8;
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((bits - 4 - countBits) / 8);
};

const pickVersion = (byteLen) => {
  for (let v = 1; v <= 40; v++) if (byteCapacity(v) >= byteLen) return v;
  throw new Error(`dsh-webgate/qr: data too long for a QR code (${byteLen} bytes > 2953)`);
};

// ---- data codewords ----
const encodeData = (bytes, version) => {
  const capacity = DATA_CODEWORDS_L[version];
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4);                       // byte mode indicator
  push(bytes.length, countBits);    // character count
  for (const b of bytes) push(b, 8);
  const total = capacity * 8;
  push(0, Math.min(4, total - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  let pad = 0xec;
  while (out.length < capacity) { out.push(pad); pad = pad === 0xec ? 0x11 : 0xec; }
  return out;
};

// ---- RS: split into blocks, compute EC, interleave ----
const rsEncode = (data, version) => {
  const [blockCount, ecCount] = BLOCKS_L[version];
  const short = Math.floor(data.length / blockCount);
  const long = short + 1;
  const numLong = data.length % blockCount;
  const generator = rsGenerator(ecCount);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = i < numLong ? long : short;
    blocks.push({ data: data.slice(offset, offset + len), ec: [] });
    offset += len;
  }
  // remainder of message * x^ecCount mod generator
  for (const block of blocks) {
    const msg = [...block.data, ...new Array(ecCount).fill(0)];
    for (let i = 0; i < block.data.length; i++) {
      const factor = msg[i];
      if (factor === 0) continue;
      for (let j = 0; j < generator.length; j++) msg[i + j] ^= gfMul(generator[j], factor);
    }
    block.ec = msg.slice(block.data.length);
  }
  const interleaved = [];
  for (let i = 0; i < long; i++) for (const b of blocks) if (i < b.data.length) interleaved.push(b.data[i]);
  for (let i = 0; i < ecCount; i++) for (const b of blocks) interleaved.push(b.ec[i]);
  return { codewords: interleaved, blocks };
};

// ---- format / version info ----
const bchFormat = (data, gen, total) => {
  const dataBits = total === 15 ? 5 : 6;
  const genDeg = total - dataBits;
  let d = data << genDeg;
  for (let i = total - 1; i >= genDeg; i--) if ((d >> i) & 1) d ^= gen << (i - genDeg);
  return ((data << genDeg) | d) & ((1 << total) - 1);
};
const formatBits = (ecl, mask) => bchFormat((ECL_BITS[ecl] << 3) | mask, 0x537, 15) ^ 0x5412;
const versionBits = (version) => bchFormat(version, 0x1f25, 18);

// ---- matrix construction ----
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1]
];
const ALIGN = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1]
];

const buildMatrix = (codewords, version, mask) => {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

  // finders + separators
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) set(fr + r, fc + c, FINDER[r][c]);
    for (let i = -1; i <= 7; i++) {
      set(fr - 1, fc + i, 0); set(fr + 7, fc + i, 0);
      set(fr + i, fc - 1, 0); set(fr + i, fc + 7, 0);
    }
  }
  // timing
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  // alignment
  const positions = ALIGNMENT[version];
  for (const r of positions) for (const c of positions) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, ALIGN[dr + 2][dc + 2]);
  }
  // dark module
  set(size - 8, 8, 1);
  // format info
  const fbits = formatBits("L", mask);
  for (let i = 0; i < 15; i++) {
    const bit = (fbits >> i) & 1;
    if (i < 6) set(i, 8, bit);
    else if (i < 8) set(i + 1, 8, bit);
    else set(size - 15 + i, 8, bit);
    if (i < 8) set(8, size - 1 - i, bit);
    else if (i < 9) set(8, 7, bit);
    else set(8, 15 - i - 1, bit);
  }
  // version info
  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      set(Math.floor(i / 3), i % 3 + size - 11, bit);
      set(i % 3 + size - 11, Math.floor(i / 3), bit);
    }
  }
  // data placement (zigzag) + mask
  const applyMask = (r, c) => {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  };
  let row = size - 1;
  let col = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] === null) {
          const bit = byteIndex < codewords.length ? (codewords[byteIndex] >> bitIndex) & 1 : 0;
          const masked = applyMask(row, col - c) ? 1 : 0;
          m[row][col - c] = bit ^ masked;
          bitIndex--;
          if (bitIndex < 0) { bitIndex = 7; byteIndex++; }
        }
      }
      row += upward ? -1 : 1;
      if (row < 0 || row >= size) { row -= upward ? -1 : 1; upward = !upward; break; }
    }
    col -= 2;
  }
  return m;
};

// ---- mask penalty (ISO/IEC 18004 rules 1-4) ----
const maskPenalty = (m) => {
  const size = m.length;
  let score = 0;
  // rule 1: runs
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c <= size; c++) {
      if (c < size && m[r][c] === m[r][c - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r <= size; r++) {
      if (r < size && m[r][c] === m[r - 1][c]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
  }
  // rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // rule 3: finder-like patterns (1011101 with 0000 on either side)
  const checkLine = (line) => {
    const s = line.join("");
    const re = /(00001011101|10111010000)/g;
    let m;
    while ((m = re.exec(s)) !== null) { score += 40; re.lastIndex = m.index + 1; }
  };
  for (let r = 0; r < size; r++) checkLine(m[r]);
  for (let c = 0; c < size; c++) checkLine(m.map((row) => row[c]));
  // rule 4: dark proportion
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
};

const chooseMask = (codewords, version) => {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(codewords, version, mask);
    const s = maskPenalty(m);
    if (s < bestScore) { bestScore = s; best = mask; }
  }
  return best;
};

// ---- public API ----
const qrMatrix = (text, opts = {}) => {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const data = encodeData(bytes, version);
  const { codewords } = rsEncode(data, version);
  const mask = chooseMask(codewords, version);
  return { matrix: buildMatrix(codewords, version, mask), version, mask };
};

const qrSvg = (text, opts = {}) => {
  const { matrix, version } = qrMatrix(text, opts);
  const size = matrix.length;
  const margin = opts.margin ?? 4;
  const total = size + margin * 2;
  const cell = opts.cell ?? 4;
  const dark = opts.dark ?? "#000000";
  let path = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (matrix[r][c] === 1) path += `M${c + margin},${r + margin}h1v1h-1z`;
  }
  const width = total * cell;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${width}" height="${width}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="${dark}"/></svg>`;
};

const qrDataUrl = (text, opts = {}) => `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(text, opts))}`;

const qrTerminal = (text, opts = {}) => {
  const { matrix } = qrMatrix(text, opts);
  const size = matrix.length;
  const margin = opts.margin ?? 2;
  const get = (r, c) => (r >= 0 && r < size && c >= 0 && c < size && matrix[r][c] === 1) ? 1 : 0;
  const lines = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < size + margin; c++) {
      const top = get(r, c);
      const bottom = get(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
};

export { qrDataUrl, qrMatrix, qrSvg, qrTerminal };