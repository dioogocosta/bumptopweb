/**
 * Gera ícones PNG do app (192, 512, maskable 512) sem dependências externas.
 * Encoder PNG mínimo: IHDR + IDAT (zlib) + IEND, CRC32 por chunk.
 * Uso: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// CRC32
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Renderiza um ícone: fundo escuro + "sala" com caixas (leitura da marca). */
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const bg = [26, 26, 32];
  const accent = [79, 156, 255];
  const accent2 = [255, 107, 107];
  const floor = [42, 42, 51];

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, ...bg);

  const cx = size / 2;
  const cy = size * 0.6;
  const s = size / 512;

  // piso (losango)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / (150 * s);
      const dy = (y - cy) / (80 * s);
      if (Math.abs(dx) + Math.abs(dy * 1.0) <= 1) set(x, y, ...floor);
    }
  }

  // caixa azul (empilhada)
  const box = (ox, oy, w, h, c) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(ox + x, oy + y, ...c);
  };
  const b = Math.round(70 * s);
  box(Math.round(cx - 90 * s), Math.round(cy - 30 * s), b, b, accent);
  // caixa vermelha (topo)
  box(Math.round(cx + 10 * s), Math.round(cy - 110 * s), b, b, accent2);

  // cantos arredondados → transparência
  const radius = Math.round(size * 0.18);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCorner =
        (x < radius && y < radius && (radius - x) ** 2 + (radius - y) ** 2 > radius * radius) ||
        (x >= size - radius && y < radius && (x - (size - radius - 1)) ** 2 + (radius - y) ** 2 > radius * radius) ||
        (x < radius && y >= size - radius && (radius - x) ** 2 + (y - (size - radius - 1)) ** 2 > radius * radius) ||
        (x >= size - radius && y >= size - radius && (x - (size - radius - 1)) ** 2 + (y - (size - radius - 1)) ** 2 > radius * radius);
      if (inCorner) px[(y * size + x) * 4 + 3] = 0;
    }
  }
  return px;
}

function encodePng(size) {
  const raw = drawIcon(size);
  const stride = size * 4;
  const scan = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    scan[y * (stride + 1)] = 0; // filter none
    Buffer.from(raw.buffer, y * stride, stride).copy(scan, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scan, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(join(outDir, 'icon-192.png'), encodePng(192));
writeFileSync(join(outDir, 'icon-512.png'), encodePng(512));
writeFileSync(join(outDir, 'icon-maskable-512.png'), encodePng(512));
console.log('Ícones gerados em', outDir);
