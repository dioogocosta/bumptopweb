/**
 * Textura da pasta (PR10 → PR20) — a pasta tinha cara de "quadrado azul"
 * liso (degradê macOS). Agora é desenhada em ESTILO PIXEL VOXEL: grade de
 * 32×32 "voxels" (células de 8px), contorno escuro, sombreamento por faixas
 * e o CONTADOR de itens com dígitos pixelados (fonte 3×5) no centro da frente.
 * A contagem vem do FileService (fs.list) e é repintada quando muda.
 */

const SIZE = 256; // face do card é quadrada → textura quadrada
const CELLS = 32; // grade de voxels (32×32)
const CELL = SIZE / CELLS; // 8px por voxel

/** Paleta pixel (tons de azul da pasta + contorno escuro). */
const C = {
  bg: '#1e4d82', // "dentro/sombra" atrás da pasta (contraste com a frente)
  outline: '#123657', // contorno escuro (1 voxel)
  tab: '#8ecbf4', // aba (parte de trás)
  front: '#5aa7e8', // frente
  hi: '#a8d8f8', // brilho superior da frente
  shade: '#3f87c8', // sombra inferior da frente
  num: '#ffffff', // dígito
  numShadow: '#123657', // sombra do dígito
} as const;

/** Fonte de dígitos 3×5 (linhas de 0/1) p/ o contador pixelado. */
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

/**
 * Desenha a pasta com `count` itens (0 = sem número). Retorna dataURL, ou
 * null fora do browser (testes em node).
 */
export function makeFolderTexture(count: number): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  /** Pinta `w`×`h` voxels a partir do voxel (gx, gy). */
  const px = (gx: number, gy: number, w: number, h: number, cor: string) => {
    ctx.fillStyle = cor;
    ctx.fillRect(Math.round(gx * CELL), Math.round(gy * CELL), Math.round(w * CELL), Math.round(h * CELL));
  };

  // Fundo = "dentro/atrás" da pasta (a face é toda coberta — o material do
  // renderer não é transparente, PNG com alfa viraria preto)
  px(0, 0, CELLS, CELLS, C.bg);

  // ----- aba (parte de trás da pasta) — com contorno -----
  // Contorno: expande 1 voxel além da área clara
  px(2, 2, 14, 6, C.outline); // contorno da aba
  px(3, 3, 12, 4, C.tab); // aba clara

  // ----- frente da pasta — faixas de sombreamento pixelado -----
  px(0, 6, CELLS, 22, C.outline); // contorno da frente
  px(1, 7, CELLS - 2, 20, C.front); // corpo
  px(1, 7, CELLS - 2, 4, C.hi); // faixa de brilho no topo
  px(1, 23, CELLS - 2, 4, C.shade); // faixa de sombra embaixo

  // ----- contador de itens — dígitos pixelados no centro da frente -----
  if (count > 0) {
    const txt = String(count);
    const escala = txt.length <= 2 ? 2 : 1; // 2 voxels por pixel do dígito
    const largura = txt.length * 3 * escala + (txt.length - 1) * escala; // dígitos + 1 voxel de espaço
    const dh = 5 * escala;
    const x0 = CELLS / 2 - largura / 2;
    const y0 = 17 - dh / 2; // centro vertical da frente (corpo 7..27)
    let dx = x0;
    for (const ch of txt) {
      const map = DIGITS[ch] ?? DIGITS['0'];
      for (let r = 0; r < 5; r++) {
        for (let col = 0; col < 3; col++) {
          if (map[r][col] !== '1') continue;
          // sombra deslocada 1 voxel p/ baixo-direita (contraste)
          px(dx + col * escala + 1, y0 + r * escala + 1, escala, escala, C.numShadow);
          px(dx + col * escala, y0 + r * escala, escala, escala, C.num);
        }
      }
      dx += 3 * escala + escala;
    }
  }

  return canvas.toDataURL('image/png');
}
