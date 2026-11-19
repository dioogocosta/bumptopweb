/**
 * Textura da face da nota adesiva — PR9/PR12.
 *
 * PR9: o TEXTO é escrito no próprio papel (clicar na nota abre o leitor).
 * PR12: o papel entende "markdown-lite" (títulos, listas com checkbox,
 * negrito/itálico/sublinhado/riscado), cor de fundo (paleta), um selo 🔔
 * quando há lembrete e um DESENHO (dataURL PNG) composto no papel.
 *
 * O World recebe esta função injetada via `setNoteTextureProvider` — canvas
 * só existe nesta camada de app. Pode devolver Promise (o desenho carrega
 * async); o World aceita ambos.
 */
import { parseNoteMarkdown, wrapRuns, type NoteLine } from '@core/util/notes';

const SIZE = 512; // face do card é quadrada (12×12) → textura quadrada
const PAD = 40;
const FONT = { title: 64, h1: 56, h2: 48, text: 40, item: 40 };
const LINE = { title: 78, h1: 70, h2: 62, text: 54, item: 54 };
const FONT_STACK = `system-ui, -apple-system, 'Segoe UI', sans-serif`;
const INK = '#1f2933';
const INK_DONE = '#8a939e';

/** Entrada da face — espelha as chaves `meta.note*` do objeto. */
export interface NoteFaceInput {
  text?: string;
  title?: string;
  bg?: string;
  drawing?: string;
  reminder?: number;
}

function lineH(kind: NoteLine['kind']): number {
  return LINE[kind];
}

function fontOf(run: NoteLine['runs'][number], kind: NoteLine['kind']): string {
  const size = FONT[kind];
  const weight = run.b || kind === 'title' || kind === 'h1' || kind === 'h2' ? '700' : '500';
  const style = run.i ? 'italic ' : '';
  return `${style}${weight} ${size}px ${FONT_STACK}`;
}

/** Altura do papel já consumida pelas linhas + reticências p/ truncar. */
function buildLines(input: NoteFaceInput, ctx: CanvasRenderingContext2D): NoteLine[] {
  const measure = (s: string): number => ctx.measureText(s).width;
  const maxW = SIZE - PAD * 2;
  const lines: NoteLine[] = [];
  if (input.title && input.title.trim() !== '') {
    ctx.font = `700 ${FONT.title}px ${FONT_STACK}`;
    const runs = wrapRuns([{ text: input.title.trim() }], 0, measure, maxW);
    for (const r of runs) lines.push({ kind: 'title', runs: r });
  }
  ctx.font = `500 ${FONT.text}px ${FONT_STACK}`;
  return lines.concat(parseNoteMarkdown(input.text ?? '', measure, maxW));
}

/**
 * Desenha o papel e devolve dataURL (ou null fora do browser — node).
 * Com `drawing`, devolve Promise (o PNG carrega async).
 */
export function makeNoteTexture(
  input: NoteFaceInput,
): string | null | Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = input.bg ?? '#ffd43b';
  const lines = buildLines(input, ctx);

  // Orçamento de linhas: quantas cabem no papel
  const usable = SIZE - PAD * 2;
  let acc = 0;
  let budget = 0;
  for (const line of lines) {
    const h = lineH(line.kind);
    if (acc + h > usable) break;
    acc += h;
    budget++;
  }
  const trunc = budget < lines.length;

  const compose = (img: HTMLImageElement | null): string => {
    // Papel (re-pintado no compose async p/ não perder o fundo)
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.textBaseline = 'top';

    // Selo de lembrete (🔔 no canto sup-dir)
    if (typeof input.reminder === 'number') {
      ctx.font = `46px ${FONT_STACK}`;
      ctx.fillText('🔔', SIZE - PAD - 48, PAD - 10);
    }

    let y = PAD;
    for (let i = 0; i < budget; i++) {
      const line = lines[i];
      let x = PAD;
      // Checkbox do item de lista (☑)
      if (line.kind === 'item') {
        const box = 30;
        const by = y + 8;
        if (line.done) {
          ctx.fillStyle = '#2f9e44';
          ctx.fillRect(x, by, box, box);
          ctx.fillStyle = '#ffffff';
          ctx.font = `700 26px ${FONT_STACK}`;
          ctx.fillText('✓', x + 5, by + 3);
        } else {
          ctx.strokeStyle = '#57606a';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 1.5, by + 1.5, box - 3, box - 3);
        }
        x += 44;
      }
      for (const run of line.runs) {
        ctx.font = fontOf(run, line.kind);
        ctx.fillStyle = line.done ? INK_DONE : INK;
        const w = ctx.measureText(run.text).width;
        ctx.fillText(run.text, x, y);
        if (run.u) ctx.fillRect(x, y + FONT[line.kind] + 3, w, 3);
        if (run.s) ctx.fillRect(x, y + lineH(line.kind) / 2, w, 4);
        x += w;
      }
      y += lineH(line.kind);
    }
    if (trunc) {
      ctx.font = `500 ${FONT.text}px ${FONT_STACK}`;
      ctx.fillStyle = INK;
      ctx.fillText('…', PAD, Math.min(y, SIZE - PAD - LINE.text));
    }

    // Desenho composto no papel (abaixo do texto; ocupa tudo se não há texto)
    if (img) {
      const hasText = lines.slice(0, budget).some((l) => l.runs.some((r) => r.text.trim() !== ''));
      const top = hasText ? Math.min(y + 8, SIZE - PAD - 40) : PAD;
      const rw = SIZE - PAD * 2;
      const rh = SIZE - PAD - top;
      if (rw > 10 && rh > 10) {
        const scale = Math.min(rw / img.width, rh / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, PAD + (rw - w) / 2, top + Math.max(0, (rh - h) / 2), w, h);
      }
    }
    return canvas.toDataURL('image/png');
  };

  if (!input.drawing) return compose(null);
  const drawing = input.drawing;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(compose(img));
    img.onerror = () => resolve(compose(null));
    img.src = drawing;
  });
}

/** PR4.11 — Entrada para textura da face do card de história do Taiga. */
export interface TaigaCardFaceInput {
  ref: number;
  subject: string;
  statusName: string;
  statusColor?: string;
  showTitle?: boolean;
}

/**
 * PR4.11 — Gera a textura (dataURL) para a face superior do card do Taiga.
 * Quando showTitle=true, renderiza o título completo na capa do card com quebra de linha.
 * Quando showTitle=false, exibe o cabeçalho de status e o #ref em destaque central.
 */
export function makeTaigaCardTexture(input: TaigaCardFaceInput): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const statusColor = input.statusColor || '#8b5cf6';
  const showTitle = input.showTitle ?? true;

  // Fundo branco limpo estilo card físico
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Borda perimetral suave com a cor do status
  ctx.lineWidth = 10;
  ctx.strokeStyle = statusColor;
  ctx.strokeRect(5, 5, SIZE - 10, SIZE - 10);

  // Barra de cabeçalho colorida com status
  ctx.fillStyle = statusColor;
  ctx.fillRect(10, 10, SIZE - 20, 86);

  // #ref no cabeçalho (esquerda)
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 42px ${FONT_STACK}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(`#${input.ref}`, 26, 53);

  // Nome do status no cabeçalho (direita)
  if (input.statusName) {
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    const statusText = input.statusName.toUpperCase();
    ctx.fillText(statusText, SIZE - 26, 53);
  }

  // Título completo na capa do card
  if (showTitle && input.subject) {
    const text = input.subject.trim();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';

    const maxW = SIZE - 48;
    const startX = 24;
    const startY = 118;
    const maxHeight = SIZE - 138;

    // Ajusta o tamanho da fonte dinamicamente para o título caber 100% completo sem cortes
    let fontSize = 34;
    let lineHeight = 44;
    let lines: string[] = [];

    while (fontSize >= 18) {
      ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
      lineHeight = Math.round(fontSize * 1.32);
      lines = [];
      const words = text.split(/\s+/);
      let curLine = '';
      for (const w of words) {
        const testLine = curLine ? `${curLine} ${w}` : w;
        if (ctx.measureText(testLine).width <= maxW) {
          curLine = testLine;
        } else {
          if (curLine) lines.push(curLine);
          curLine = w;
        }
      }
      if (curLine) lines.push(curLine);

      if (lines.length * lineHeight <= maxHeight) {
        break;
      }
      fontSize -= 2;
    }

    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    let y = startY;
    for (const l of lines) {
      ctx.fillText(l, startX, y);
      y += lineHeight;
    }
  } else {
    // Quando nomes estão desativados: exibe #ref em tamanho grande no centro
    ctx.fillStyle = statusColor;
    ctx.font = `bold 96px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${input.ref}`, SIZE / 2, 280);
  }

  return canvas.toDataURL('image/png');
}
