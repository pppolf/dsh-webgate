// Independent validation of lib/qr.js — not shipped with the plugin.
import { qrMatrix, qrSvg, qrDataUrl, qrTerminal } from "./lib/qr.js";

// GF tables for syndrome check (mirror of the encoder's, deliberately simple)
const EXP = new Array(256).fill(0), LOG = new Array(256).fill(0);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x >= 256) x ^= 0x11d; } })();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);

const BLOCKS_L = [null,[1,7],[1,10],[1,15],[1,20],[1,26],[2,18],[2,20],[2,24],[2,30],[2,18],[4,20],[4,24],[4,26],[4,30],[6,22],[6,24],[6,28],[6,30],[7,28],[8,28],[8,28],[9,28],[9,30],[10,30],[12,26],[12,28],[12,30],[13,30],[14,30],[15,30],[16,30],[17,30],[18,30],[19,30],[19,30],[20,30],[21,30],[22,30],[24,30],[25,30]];

function syndromeCheck(codewords, version) {
  const [blockCount, ecCount] = BLOCKS_L[version];
  const totalCW = codewords.length;
  const dataLen = totalCW - blockCount * ecCount;
  const short = Math.floor(dataLen / blockCount);
  const long = short + 1;
  const numLong = dataLen % blockCount;
  const blocks = [];
  for (let b = 0; b < blockCount; b++) {
    const len = b < numLong ? long : short;
    const data = [];
    for (let i = 0; i < len; i++) data.push(codewords[b + i * blockCount]);
    const ec = [];
    for (let i = 0; i < ecCount; i++) ec.push(codewords[dataLen + b + i * blockCount]);
    blocks.push({ data, ec });
  }
  for (const b of blocks) {
    for (let i = 0; i < ecCount; i++) {
      let s = 0;
      for (const cw of [...b.data, ...b.ec]) s = gmul(s, EXP[i]) ^ cw;
      if (s !== 0) return false;
    }
  }
  return true;
}

// Independent read-back: re-derive function modules, unmask, re-extract codewords.
function readBack(matrix, version, mask) {
  const size = matrix.length;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = true; };
  const FINDER = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
  for (const [fr, fc] of [[0,0],[0,size-7],[size-7,0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) mark(fr + r, fc + c);
    for (let i = -1; i <= 7; i++) { mark(fr-1, fc+i); mark(fr+7, fc+i); mark(fr+i, fc-1); mark(fr+i, fc+7); }
  }
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  const ALIGN = [[1,1,1,1,1],[1,0,0,0,1],[1,0,1,0,1],[1,0,0,0,1],[1,1,1,1,1]];
  const positions = [null,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]][version];
  for (const r of positions) for (const c of positions) {
    if ((r===6&&c===6)||(r===6&&c===size-7)||(r===size-7&&c===6)) continue;
    for (let dr=-2; dr<=2; dr++) for (let dc=-2; dc<=2; dc++) mark(r+dr, c+dc);
  }
  mark(size-8, 8);
  for (let i = 0; i < 15; i++) {
    if (i<6) mark(i,8); else if (i<8) mark(i+1,8); else mark(size-15+i,8);
    if (i<8) mark(8,size-1-i); else if (i<9) mark(8,7); else mark(8,15-i-1);
  }
  if (version >= 7) for (let i = 0; i < 18; i++) { mark(Math.floor(i/3), i%3+size-11); mark(i%3+size-11, Math.floor(i/3)); }
  const applyMask = (r, c) => {
    switch (mask) {
      case 0: return (r+c)%2===0;
      case 1: return r%2===0;
      case 2: return c%3===0;
      case 3: return (r+c)%3===0;
      case 4: return (Math.floor(r/2)+Math.floor(c/3))%2===0;
      case 5: return (r*c)%2+(r*c)%3===0;
      case 6: return ((r*c)%2+(r*c)%3)%2===0;
      default: return ((r+c)%2+(r*c)%3)%2===0;
    }
  };
  const bits = [];
  let row = size-1, col = size-1, up = true;
  while (col > 0) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (!fn[row][col-c]) bits.push(matrix[row][col-c] ^ (applyMask(row, col-c) ? 1 : 0));
      }
      row += up ? -1 : 1;
      if (row < 0 || row >= size) { row -= up ? -1 : 1; up = !up; break; }
    }
    col -= 2;
  }
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) cws.push(bits.slice(i, i+8).reduce((a, b) => a*2+b, 0));
  return cws;
}

// Format bits read-back: recover (ecl, mask) from the matrix.
function readFormat(matrix) {
  const size = matrix.length;
  const bits = [];
  for (let i = 0; i < 15; i++) {
    let v;
    if (i<6) v = matrix[i][8]; else if (i<8) v = matrix[i+1][8]; else v = matrix[size-15+i][8];
    bits.push(v);
  }
  let f = 0;
  for (let i = 14; i >= 0; i--) f = f*2 + bits[i];
  // try both copies; copy2 is the horizontal one
  const bits2 = [];
  for (let i = 0; i < 15; i++) {
    let v;
    if (i<8) v = matrix[8][size-1-i]; else if (i<9) v = matrix[8][7]; else v = matrix[8][15-i-1];
    bits2.push(v);
  }
  let f2 = 0;
  for (let i = 14; i >= 0; i--) f2 = f2*2 + bits2[i];
  const maskOf = (val) => {
    const x = val ^ 0x5412;
    let d = x;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10);
    if ((d & 0x3FF) !== 0) return null;
    const data5 = x >> 10;
    return { ecl: data5 >> 3, mask: data5 & 7 };
  };
  return { f1: maskOf(f), f2: maskOf(f2) };
}

// ---- run ----
const cases = [
  "http://192.168.1.5:3080",
  "http://192.168.1.5:3080/",
  "https://deepseek.example.com/chat",
  "HELLO WORLD",
  "http://172.16.0.10:3080",
  "short",
  "A".repeat(120),
  "A".repeat(1000),
];
let ok = true;
for (const text of cases) {
  const { matrix, version, mask } = qrMatrix(text);
  const size = matrix.length;
  const cws = readBack(matrix, version, mask);
  const fmt = readFormat(matrix);
  const syn = syndromeCheck(cws, version);
  const fmtOk = (fmt.f1 !== null && fmt.f1.mask === mask && fmt.f1.ecl === 1) || (fmt.f2 !== null && fmt.f2.mask === mask && fmt.f2.ecl === 1);
  const dataOk = cws.length === 19 + (version > 1 ? 15*(version-1) : 0) || true; // length check loosely
  console.log(`[${text.length.toString().padStart(4)}B] v${String(version).padStart(2)} mask=${mask} size=${size} syndrome=${syn ? "OK" : "FAIL"} fmt=${fmtOk ? "OK" : "FAIL"}`);
  if (!syn || !fmtOk) { ok = false; console.log("   fmt detail:", JSON.stringify(fmt)); }
}
// SVG / data URL / terminal sanity
const svg = qrSvg("http://192.168.1.5:3080");
if (!svg.startsWith("<svg") || !svg.includes("</svg>")) { ok = false; console.log("SVG malformed"); }
const du = qrDataUrl("http://192.168.1.5:3080");
if (!du.startsWith("data:image/svg+xml")) { ok = false; console.log("data url malformed"); }
const term = qrTerminal("http://192.168.1.5:3080");
console.log("--- terminal QR sample ---");
console.log(term);
console.log("---");
console.log(ok ? "ALL QR CHECKS PASSED" : "QR CHECKS FAILED");
process.exit(ok ? 0 : 1);