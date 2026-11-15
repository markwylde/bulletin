import { zlibSync } from "fflate";

/**
 * A small deterministic identicon PNG for seeded avatars: a 5 × 5 mirrored grid in a hue taken
 * from the seed, on a pale tint of the same hue. It lets every seeded member look distinct
 * without shipping image files, and it goes through the normal avatar pipeline (ADR 0019).
 */
export function identiconPng(seed: string, size = 160): Uint8Array {
  const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
  // A fixed spread of hues keeps neighbouring seeded members visibly different.
  const hue = HUES[(digest[20] ?? 0) % HUES.length] ?? 210;
  const foreground = hslToRgb(hue, 0.55, 0.5);
  const background = hslToRgb(hue, 0.45, 0.93);
  const cells = 5;
  // Generous margin: avatars render as circles, so the pattern stays clear of the crop.
  const margin = Math.round(size * 0.22);
  const cell = Math.floor((size - margin * 2) / cells);
  const offset = Math.floor((size - cell * cells) / 2);
  const filled = (column: number, row: number): boolean => {
    const mirrored = column < 3 ? column : cells - 1 - column;
    return ((digest[1 + row * 3 + mirrored] ?? 0) & 1) === 1;
  };

  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;

    for (let x = 0; x < size; x += 1) {
      const column = Math.floor((x - offset) / cell);
      const row = Math.floor((y - offset) / cell);
      const inside = column >= 0 && column < cells && row >= 0 && row < cells;
      const colour = inside && filled(column, row) ? foreground : background;
      const at = y * stride + 1 + x * 3;
      raw[at] = colour[0];
      raw[at + 1] = colour[1];
      raw[at + 2] = colour[2];
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8);

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const HUES = [12, 32, 145, 172, 200, 255, 285, 330] as const;

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
