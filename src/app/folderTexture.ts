/**
 * Textura da pasta (PR10) — as pastas tinham cara de "quadrado azul".
 * Agora a face superior mostra uma PASTA de verdade (aba atrás + frente
 * em degradê, estilo macOS) com o CONTADOR de itens no centro da frente.
 * A contagem vem do FileService (fs.list) e é repintada quando muda.
 */

const SIZE = 256; // face do card é quadrada → textura quadrada

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

  // Fundo = "dentro/atrás" da pasta (a face é toda coberta — o material do
  // renderer não é transparente, PNG com alfa viraria preto)
  ctx.fillStyle = '#4f9be0';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ----- aba (parte de trás da pasta) -----
  const backTop = Math.round(SIZE * 0.1);
  const backH = Math.round(SIZE * 0.26);
  const tabW = Math.round(SIZE * 0.4);
  ctx.fillStyle = '#5aa7e8';
  roundRect(ctx, 0, backTop, tabW, backH, 10);
  ctx.fill();

  // ----- frente da pasta (degradê azul) -----
  const frontTop = backTop + backH - 10;
  const frontH = SIZE - frontTop;
  const grad = ctx.createLinearGradient(0, frontTop, 0, frontTop + frontH);
  grad.addColorStop(0, '#8ec9f2');
  grad.addColorStop(1, '#5b9fd6');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, frontTop, SIZE, frontH, 12);
  ctx.fill();
  // brilho superior da frente
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  roundRect(ctx, 0, frontTop, SIZE, Math.round(frontH * 0.16), 12);
  ctx.fill();

  // ----- contador de itens no centro da frente -----
  if (count > 0) {
    const txt = String(count);
    ctx.font = `700 ${Math.round(SIZE * 0.2)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // sombra leve p/ contraste
    ctx.fillStyle = 'rgba(12, 46, 84, 0.55)';
    ctx.fillText(txt, SIZE / 2, frontTop + frontH * 0.52 + 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(txt, SIZE / 2, frontTop + frontH * 0.52);
  }

  return canvas.toDataURL('image/png');
}

/** Retângulo com cantos arredondados (path apenas). */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
