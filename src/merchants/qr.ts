// A small QR code encoder for the return label: byte mode, error correction L, versions 1 to 4 (up to 78 bytes).
// Pure and dependency-free. qrMatrix() gives the modules; qrSvgPath() gives them as one SVG path for the page.

const VERSIONS = [
  { version: 1, data: 19, ec: 7 },
  { version: 2, data: 34, ec: 10 },
  { version: 3, data: 55, ec: 15 },
  { version: 4, data: 80, ec: 20 },
] as const;

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function reedSolomon(data: number[], ecLength: number): number[] {
  let generator = [1];
  for (let i = 0; i < ecLength; i += 1) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((coef, j) => {
      next[j] = (next[j] ?? 0) ^ coef;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(coef, EXP[i]!);
    });
    generator = next;
  }
  const remainder = new Array<number>(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    generator.slice(1).forEach((coef, i) => {
      remainder[i] = remainder[i]! ^ gfMul(coef, factor);
    });
  }
  return remainder;
}

function codewords(text: string): { words: number[]; version: number } {
  const bytes = [...new TextEncoder().encode(text)];
  const size = VERSIONS.find((v) => v.data >= bytes.length + 2);
  if (!size) throw new Error("QR payload too long");
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, size.data * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; words.length < size.data; pad = pad === 0xec ? 0x11 : 0xec) words.push(pad);
  return { words: [...words, ...reedSolomon(words, size.ec)], version: size.version };
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask; // error correction L
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        const same = pass === 0 ? m[a]![b] === m[a]![b - 1] : m[b]![a] === m[b - 1]![a];
        run = same ? run + 1 : 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      }
    }
  }
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }
  return score;
}

/** The QR code for `text` as rows of dark (true) and light (false) modules, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const { words, version } = codewords(text);
  const n = 17 + 4 * version;
  const dark = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, value: boolean) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    dark[r]![c] = value;
    fixed[r]![c] = true;
  };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(r0 + r, c0 + c, ring !== 4 && ring !== 2);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 8 + 1);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  if (version >= 2) {
    const centre = n - 7;
    for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) set(centre + r, centre + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  set(n - 8, 8, true); // the always-dark module
  // Reserve the format areas (written per mask below).
  for (let i = 0; i < 9; i += 1) {
    if (!fixed[8]![i]) set(8, i, false);
    if (!fixed[i]![8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!fixed[8]![n - 1 - i]) set(8, n - 1 - i, false);
    if (!fixed[n - 1 - i]![8]) set(n - 1 - i, 8, false);
  }

  const bits: boolean[] = words.flatMap((w) => Array.from({ length: 8 }, (_, i) => ((w >> (7 - i)) & 1) === 1));
  const place = (maskIndex: number): boolean[][] => {
    const mask = MASKS[maskIndex]!;
    const out = dark.map((row) => row.slice());
    let index = 0;
    let upward = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let step = 0; step < n; step += 1) {
        const r = upward ? n - 1 - step : step;
        for (const c of [col, col - 1]) {
          if (fixed[r]![c]) continue;
          const bit = bits[index] ?? false;
          index += 1;
          out[r]![c] = mask(r, c) ? !bit : bit;
        }
      }
      upward = !upward;
    }
    const format = formatBits(maskIndex);
    const f = (i: number) => ((format >> i) & 1) === 1;
    // First copy: around the top-left finder.
    for (let i = 0; i <= 5; i += 1) out[i]![8] = f(i);
    out[7]![8] = f(6);
    out[8]![8] = f(7);
    out[8]![7] = f(8);
    for (let i = 9; i < 15; i += 1) out[8]![14 - i] = f(i);
    // Second copy: under the top-right finder and beside the bottom-left one.
    for (let i = 0; i < 8; i += 1) out[8]![n - 1 - i] = f(i);
    for (let i = 8; i < 15; i += 1) out[n - 15 + i]![8] = f(i);
    return out;
  };

  let best = place(0);
  let bestScore = penalty(best);
  for (let mask = 1; mask < MASKS.length; mask += 1) {
    const candidate = place(mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** One SVG path (unit squares) for the code plus a 2-module quiet zone, and the side length of its viewBox. */
export function qrSvgPath(text: string): { path: string; size: number } {
  const m = qrMatrix(text);
  const quiet = 2;
  let path = "";
  m.forEach((row, r) =>
    row.forEach((on, c) => {
      if (on) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }),
  );
  return { path, size: m.length + quiet * 2 };
}
