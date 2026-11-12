/**
 * Textura da foto em MOLDURA (PR10) — espelha a parede do BumpTop original:
 * imagens ficam como quadros com borda branca e sombra. A moldura é composta
 * na própria textura (canvas): fundo branco, foto inset com margem e uma
 * linha cinza sutil + sombra interna — funciona no chão e pregado na parede.
 *
 * `makePhotoTexture(raw, framed)` recebe o thumbnail puro (dataURL) e devolve
 * a textura final. Com `framed=false` devolve a foto sem moldura (cobre a
 * face inteira, comportamento anterior ao PR10).
 */

const SIZE = 256; // face do card é quadrada → textura quadrada

/** Carrega um dataURL como Image (promise). */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagem inválida'));
    img.src = src;
  });
}

/**
 * Compõe a textura da foto. Retorna null fora do browser (testes em node)
 * ou se o thumbnail não puder ser decodificado.
 */
export async function makePhotoTexture(
  rawThumb: string,
  framed: boolean,
): Promise<string | null> {
  if (typeof document === 'undefined' || !rawThumb) return null;
  let img: HTMLImageElement;
  try {
    img = await loadImage(rawThumb);
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (!framed) {
    // Sem moldura: foto cobre a face inteira (comportamento antigo)
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/png');
  }

  // Moldura branca (borda ~9% da face) + sombra sutil da foto
  const BORDER = Math.round(SIZE * 0.09);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  // vinco da moldura (linha fina ao redor da foto)
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(BORDER - 1, BORDER - 1, SIZE - BORDER * 2 + 2, SIZE - BORDER * 2 + 2);
  // sombra projetada da foto sobre a moldura
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.drawImage(img, BORDER, BORDER, SIZE - BORDER * 2, SIZE - BORDER * 2);
  ctx.restore();
  return canvas.toDataURL('image/png');
}
