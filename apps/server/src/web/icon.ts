import { deflateSync } from 'node:zlib';

// The app icon: a hub, one centre node joined to four others. Drawn on a 32-unit grid.
// Ink on light everywhere; the SVG inverts itself when the system is in dark mode.

const INK = '#18181B';
const PAPER = '#FAFAF9';
const PAPER_DARK = '#F5F5F3';

const CENTRE = { x: 16, y: 16, r: 4 };
const NODES = [
  { x: 8, y: 9 },
  { x: 24, y: 9 },
  { x: 8, y: 23 },
  { x: 24, y: 23 },
];
const NODE_R = 2.3;
const LINE_W = 1.8;
const CORNER = 7;

const lines = NODES.map((n) => `<line x1="16" y1="16" x2="${n.x}" y2="${n.y}"/>`).join('');
const dots = NODES.map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${NODE_R}"/>`).join('');

/** The favicon. Its own media query flips it to light-on-dark when the browser is dark. */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<style>.bg{fill:${INK}}.fg{fill:${PAPER};stroke:${PAPER}}` +
  `@media (prefers-color-scheme: dark){.bg{fill:${PAPER_DARK}}.fg{fill:${INK};stroke:${INK}}}</style>` +
  `<rect class="bg" width="32" height="32" rx="${CORNER}"/>` +
  `<g class="fg" stroke-width="${LINE_W}" stroke-linecap="round">${lines}</g>` +
  `<g class="fg" stroke="none"><circle cx="16" cy="16" r="${CENTRE.r}"/>${dots}</g></svg>`;

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

/** Distance from a point to the segment a-b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedSquare(x: number, y: number, r: number): boolean {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function onMark(x: number, y: number): boolean {
  if (Math.hypot(x - CENTRE.x, y - CENTRE.y) <= CENTRE.r) return true;
  for (const n of NODES) {
    if (Math.hypot(x - n.x, y - n.y) <= NODE_R) return true;
    if (segmentDistance(x, y, CENTRE.x, CENTRE.y, n.x, n.y) <= LINE_W / 2) return true;
  }
  return false;
}

/**
 * Draws the icon as RGBA pixels, 4x4 samples per pixel for smooth edges. `corner` 0 gives a full
 * square, for the home-screen icon that the phone rounds itself.
 */
function rasterise(size: number, corner: number): Buffer {
  const bg = hex(INK);
  const fg = hex(PAPER);
  const S = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inBg = 0;
      let inFg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((px + (sx + 0.5) / S) / size) * 32;
          const y = ((py + (sy + 0.5) / S) / size) * 32;
          if (!insideRoundedSquare(x, y, corner)) continue;
          inBg++;
          if (onMark(x, y)) inFg++;
        }
      }
      const i = (py * size + px) * 4;
      const covered = inBg / (S * S);
      if (covered === 0) continue;
      const f = inFg / inBg;
      out[i] = Math.round(bg[0] + (fg[0] - bg[0]) * f);
      out[i + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * f);
      out[i + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * f);
      out[i + 3] = Math.round(255 * covered);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A minimal PNG encoder: 8-bit RGBA, no filtering. Enough for an icon, and no dependency. */
export function iconPng(size: number, corner = CORNER): Buffer {
  const pixels = rasterise(size, corner);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
