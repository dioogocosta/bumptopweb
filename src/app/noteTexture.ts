/**
 * Textura da face da nota adesiva (PR9) — espelha o BumpTop original:
 * o TEXTO é escrito no próprio papel amarelo. O texto é quebrado em linhas
 * e truncado (com "…") quando não cabe no papel. Clicar na nota abre o
 * conteúdo completo (leitor do PR8).
 *
 * Core continua puro: o World recebe esta função injetada via
 * `setNoteTextureProvider` — canvas só existe nesta camada de app.
 */

const SIZE = 256; // face do card é quadrada (12×12) → textura quadrada
const PAD = 20;
const FONT_SIZE = 22;
const LINE_HEIGHT = 30;

/**
 * Quebra `text` em linhas de até `maxChars` colunas (respeita \n; palavra
 * maior que a largura é cortada). Puro — testável sem DOM.
 */
export function wrapNoteLines(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const par of text.split('\n')) {
    if (par === '') {
      out.push('');
      continue;
    }
    let linha = '';
    for (const palavra of par.split(' ')) {
      // palavra gigante: corta dura
      let p = palavra;
      while (p.length > maxChars) {
        if (linha) {
          out.push(linha);
          linha = '';
        }
        out.push(p.slice(0, maxChars));
        p = p.slice(maxChars);
      }
      const cand = linha ? `${linha} ${p}` : p;
      if (cand.length > maxChars && linha) {
        out.push(linha);
        linha = p;
      } else {
        linha = cand;
      }
    }
    out.push(linha);
  }
  return out;
}

/**
 * Desenha o papel amarelo com o texto e devolve dataURL (ou null fora do
 * browser — testes em node).
 */
export function makeNoteTexture(text: string, bg = '#ffd43b'): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Papel
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Texto
  ctx.font = `500 ${FONT_SIZE}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.fillStyle = '#1f2933';
  ctx.textBaseline = 'top';
  const larguraUtil = SIZE - PAD * 2;
  // Largura média de glifo ~0.55em p/ a fonte do sistema
  const maxChars = Math.max(4, Math.floor(larguraUtil / (FONT_SIZE * 0.55)));
  const maxLines = Math.max(1, Math.floor((SIZE - PAD * 2) / LINE_HEIGHT));

  let lines = wrapNoteLines(text === '' ? '—' : text, maxChars);
  let trunc = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    trunc = true;
  }
  if (trunc) {
    // Última linha visível ganha "…" (corta chars se ainda assim estourar)
    let last = lines[maxLines - 1];
    while (ctx.measureText(`${last}…`).width > larguraUtil && last.length > 0) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  lines.forEach((ln, i) => ctx.fillText(ln, PAD, PAD + i * LINE_HEIGHT));

  return canvas.toDataURL('image/png');
}
