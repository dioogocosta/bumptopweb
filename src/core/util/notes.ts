/**
 * PR12 — utilidades PURAS do sistema de notas (estilo Keep).
 *
 * Conteúdo da nota é texto com "markdown-lite" (compatível com notas
 * antigas, que eram texto puro):
 *   `# `       → título grande (H1)
 *   `## `      → subtítulo (H2)
 *   `- [ ] `   → item de lista com checkbox (pendente)
 *   `- [x] `   → item de lista marcado (riscado + cinza na textura)
 *   `**b**`    → negrito      `*i*`    → itálico
 *   `__u__`    → sublinhado    `~~r~~`  → riscado
 *
 * Puro: sem DOM/canvas — testável em node. O `parseNoteMarkdown` recebe um
 * `measure` para quebrar linhas de verdade (largura de glifo), e o app passa
 * `ctx.measureText`.
 */

export type NoteInline = 'b' | 'i' | 'u' | 's';

/** Um trecho de texto com estilos inline aplicados. */
export interface NoteRun {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
}

/** Uma linha visual da nota (após parse + wrap). */
export interface NoteLine {
  kind: 'title' | 'h1' | 'h2' | 'text' | 'item';
  /** Item de checklist marcado (riscado). */
  done?: boolean;
  runs: NoteRun[];
}

/** Paleta de cores de fundo (estilo Keep) — 1ª é o amarelo padrão. */
export const NOTE_COLORS: string[] = [
  '#ffd43b', // amarelo padrão do card
  '#ffffff',
  '#f28b82',
  '#fbbc04',
  '#fff475',
  '#ccff90',
  '#a7ffeb',
  '#cbf0f8',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
  '#e6c9a8',
];

const MARKER_OF: Record<NoteInline, string> = { b: '**', i: '*', u: '__', s: '~~' };
const INLINE_MARKERS: string[] = ['**', '__', '~~', '*']; // 2-chars primeiro

/**
 * Converte texto markdown-lite em linhas visuais com runs estilizados.
 * `measure(s)` devolve a largura renderizada (px) para quebrar linhas.
 * Cada bloco (linha crua) gera ≥1 linha visual. Puro.
 */
export function parseNoteMarkdown(
  text: string,
  measure: (s: string) => number,
  maxW: number,
): NoteLine[] {
  const out: NoteLine[] = [];
  for (const raw of text.split('\n')) {
    let kind: NoteLine['kind'] = 'text';
    let body = raw;
    if (body.startsWith('# ')) {
      kind = 'h1';
      body = body.slice(2);
    } else if (body.startsWith('## ')) {
      kind = 'h2';
      body = body.slice(3);
    } else if (body.startsWith('- [x] ')) {
      kind = 'item';
      body = body.slice(6);
    } else if (body.startsWith('- [ ] ')) {
      kind = 'item';
      body = body.slice(6);
    }
    const runs = parseInline(body);
    const wrapped = wrapRuns(runs, kind === 'h1' || kind === 'h2' ? 0 : 1, measure, maxW);
    const done = kind === 'item' && raw.startsWith('- [x] ');
    for (const part of wrapped) {
      out.push({
        kind,
        done: done || undefined,
        runs: done ? part.map((r) => ({ ...r, s: true })) : part,
      });
    }
  }
  return out;
}

/**
 * Quebra `runs` em linhas de até `maxW` de largura. `hardFactor` reserva
 * margem à esquerda (itens de lista têm checkbox). Puro.
 */
export function wrapRuns(
  runs: NoteRun[],
  hardFactor: number,
  measure: (s: string) => number,
  maxW: number,
): NoteRun[][] {
  const usable = Math.max(8, maxW - hardFactor * 14);
  // Achata em palavras mantendo o estilo do run de origem (espaços junto)
  const words: Array<{ w: string; st: NoteRun }> = [];
  for (const r of runs) {
    const parts = r.text.split(' ');
    parts.forEach((p, i) => {
      if (p !== '') words.push({ w: p, st: r });
      if (i < parts.length - 1) words.push({ w: ' ', st: r });
    });
  }
  const lines: NoteRun[][] = [];
  let cur: NoteRun[] = [];
  let curW = 0;
  const flushLine = () => {
    // Linha visual sempre tem ≥1 run (linha vazia mantém o espaço)
    lines.push(cur.length > 0 ? cur : [{ text: '' }]);
    cur = [];
    curW = 0;
  };
  for (const { w, st } of words) {
    const ww = measure(w);
    if (curW + ww > usable && cur.some((r) => r.text.trim() !== '')) {
      flushLine();
      if (w === ' ') continue;
    }
    const last = cur[cur.length - 1];
    const same =
      last &&
      !!last.b === !!st.b &&
      !!last.i === !!st.i &&
      !!last.u === !!st.u &&
      !!last.s === !!st.s;
    if (same) last.text += w;
    else {
      const r: NoteRun = { text: w };
      if (st.b) r.b = true;
      if (st.i) r.i = true;
      if (st.u) r.u = true;
      if (st.s) r.s = true;
      cur.push(r);
    }
    curW += ww;
  }
  flushLine();
  return lines;
}

/** Parser inline: `**b**`, `__u__`, `~~s~~`, `*i*` (não aninhado). */
export function parseInline(text: string): NoteRun[] {
  const runs: NoteRun[] = [];
  const st: Record<NoteInline, boolean> = { b: false, i: false, u: false, s: false };
  let buf = '';
  const flush = () => {
    if (buf === '') return;
    const r: NoteRun = { text: buf };
    if (st.b) r.b = true;
    if (st.i) r.i = true;
    if (st.u) r.u = true;
    if (st.s) r.s = true;
    runs.push(r);
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const m of INLINE_MARKERS) {
      if (text.startsWith(m, i)) {
        flush();
        const key = (Object.keys(MARKER_OF) as NoteInline[]).find(
          (k) => MARKER_OF[k] === m,
        )!;
        st[key] = !st[key];
        i += m.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      buf += text[i];
      i++;
    }
  }
  flush();
  return runs.length === 0 ? [{ text: '' }] : runs;
}

/** Resultado de uma edição de formato: novo texto + seleção ajustada. */
export interface FormatResult {
  text: string;
  start: number;
  end: number;
}

/** Limites do bloco de linhas tocado pela seleção [a..b) no texto. */
function lineRange(text: string, selStart: number, selEnd: number) {
  const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
  const lineEndIdx = text.indexOf('\n', Math.max(selEnd, selStart));
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return { lineStart, lineEnd };
}

/**
 * Formato de LINHA (H1/H2/texto normal) nas linhas tocadas pela seleção.
 * Toggle: todas já com o prefixo alvo → remove; senão aplica (trocando o
 * prefixo de título existente).
 */
export function applyLineFormat(
  text: string,
  selStart: number,
  selEnd: number,
  kind: 'h1' | 'h2' | 'text',
): FormatResult {
  const { lineStart, lineEnd } = lineRange(text, selStart, selEnd);
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const prefix = kind === 'h1' ? '# ' : kind === 'h2' ? '## ' : '';
  const allHave = prefix !== '' && lines.every((l) => l.startsWith(prefix));
  const changed = lines.map((l) => {
    const stripped = l.replace(/^#{1,2} /, '');
    if (kind === 'text' || allHave) return stripped;
    return prefix + stripped;
  });
  const newBlock = changed.join('\n');
  const next = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
  return { text: next, start: selStart, end: selEnd + (newBlock.length - block.length) };
}

/** Liga/desliga checklist nas linhas da seleção (toggle `- [x] `). */
export function toggleChecklist(text: string, selStart: number, selEnd: number): FormatResult {
  const { lineStart, lineEnd } = lineRange(text, selStart, selEnd);
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allChecked = lines.every((l) => l.startsWith('- [x] '));
  const changed = lines.map((l) => {
    if (allChecked) return l.replace(/^- \[x\] /, '');
    if (l.startsWith('- [x] ')) return `- [ ] ${l.slice(6)}`;
    if (l.startsWith('- [ ] ')) return `- [x] ${l.slice(6)}`;
    return `- [ ] ${l.replace(/^#{1,2} /, '')}`;
  });
  const newBlock = changed.join('\n');
  const next = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
  return { text: next, start: selStart, end: selEnd + (newBlock.length - block.length) };
}

/**
 * Formato INLINE (B/I/U/S): se os marcadores encostam na seleção por fora
 * OU a seleção é `m…m`, remove; senão embrulha. Seleção vazia insere o par
 * e posiciona o cursor entre os marcadores.
 */
export function applyInlineFormat(
  text: string,
  selStart: number,
  selEnd: number,
  inline: NoteInline,
): FormatResult {
  const m = MARKER_OF[inline];
  const len = m.length;
  if (
    selEnd > selStart &&
    text.slice(Math.max(0, selStart - len), selStart) === m &&
    text.slice(selEnd, selEnd + len) === m
  ) {
    const next =
      text.slice(0, selStart - len) + text.slice(selStart, selEnd) + text.slice(selEnd + len);
    return { text: next, start: selStart - len, end: selEnd - len };
  }
  const sel = text.slice(selStart, selEnd);
  if (
    sel.length > len * 2 &&
    sel.startsWith(m) &&
    sel.endsWith(m) &&
    !sel.slice(len, -len).includes(m)
  ) {
    const inner = sel.slice(len, -len);
    const next = text.slice(0, selStart) + inner + text.slice(selEnd);
    return { text: next, start: selStart, end: selStart + inner.length };
  }
  const next = text.slice(0, selStart) + m + sel + m + text.slice(selEnd);
  return { text: next, start: selStart + len, end: selEnd + len };
}

/** Tipos de lembrete rápido do popover "Lembrar depois". */
export type ReminderKind = 'today' | 'tomorrow' | 'nextweek' | 'custom';

/**
 * Lembrete rápido → epoch ms a partir de `now`:
 * hoje = 18:00 (se já passou, agora+1h); amanhã = 08:00;
 * próxima semana = segunda-feira 08:00; `custom` usa `customMs`.
 */
export function computeReminder(kind: ReminderKind, now: number, customMs?: number): number | null {
  if (kind === 'custom') return typeof customMs === 'number' ? customMs : null;
  const d = new Date(now);
  const at = (h: number, min: number): number => {
    d.setHours(h, min, 0, 0);
    return d.getTime();
  };
  if (kind === 'today') {
    const t = at(18, 0);
    return t > now ? t : at(d.getHours() + 1, 0);
  }
  if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return at(8, 0);
  }
  const dow = d.getDay(); // 0=dom
  d.setDate(d.getDate() + ((8 - dow) % 7 || 7));
  return at(8, 0);
}
