/**
 * Thumbnails de arquivo (M2) + ícones vetoriais por tipo (M6).
 *
 * Para imagens: gera bitmap reduzido (dataURL) p/ textura do ícone.
 * Para não-imagens: usa ícone SVG inline por extensão (Word, Excel, PDF, etc.).
 * PDFs entram no M6 via PDF.js; vídeos podem usar <video> seek (futuro).
 */

import { iconForExt } from './fileIcons';

const MAX_THUMB = 128;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

export function isImagePath(name: string): boolean {
  return IMAGE_EXT.test(name);
}

/** Gera dataURL de thumbnail; para imagens usa bitmap, para o resto ícone SVG. */
export async function makeThumbnail(file: File): Promise<string> {
  if (isImagePath(file.name)) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_THUMB / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return iconForExt(file.name.split('.').pop() ?? '', file.name);
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return await blobToDataUrl(blob);
    } catch {
      return iconForExt(file.name.split('.').pop() ?? '', file.name);
    }
  }
  // Não-imagem: ícone vetorial por extensão
  return iconForExt(file.name.split('.').pop() ?? '', file.name);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Cor sólida determinística por extensão (fallback legado / M2).
 * Mantido p/ compatibilidade com código que espera cor.
 */
export function colorForFile(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'file';
  const palette: Record<string, string> = {
    pdf: '#e05252',
    png: '#4f9cff',
    jpg: '#4f9cff',
    jpeg: '#4f9cff',
    gif: '#51cf66',
    webp: '#51cf66',
    txt: '#ffd43b',
    md: '#ffd43b',
    csv: '#20c997',
    xlsx: '#20c997',
    xls: '#20c997',
    pptx: '#ff922b',
    ppt: '#ff922b',
    docx: '#5e8cff',
    doc: '#5e8cff',
    zip: '#868e96',
    rar: '#868e96',
    '7z': '#868e96',
    mp3: '#cc5de8',
    wav: '#cc5de8',
    mp4: '#f06595',
    mkv: '#f06595',
    js: '#ffd43b',
    ts: '#5e8cff',
    json: '#868e96',
    exe: '#495057',
  };
  return palette[ext] ?? '#748ffc';
}
