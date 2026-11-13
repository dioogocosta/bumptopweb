/**
 * PR12 — testes das utilidades PURAS das notas (markdown-lite, formatação,
 * lembretes). Sem DOM: `measure` fake conta glifos.
 */
import { describe, expect, it } from 'vitest';
import {
  applyInlineFormat,
  applyLineFormat,
  computeReminder,
  noteTextToHtml,
  parseInline,
  parseNoteMarkdown,
  toggleChecklist,
  wrapRuns,
} from '../../src/core/util/notes';

// measure fake: cada glifo = 10 de largura
const measure = (s: string) => s.length * 10;

describe('parseInline', () => {
  it('texto puro vira um run sem estilo', () => {
    expect(parseInline('oi')).toEqual([{ text: 'oi' }]);
  });

  it('negrito/itálico/sublinhado/riscado', () => {
    const runs = parseInline('**b** *i* __u__ ~~s~~');
    expect(runs).toEqual([
      { text: 'b', b: true },
      { text: ' ' },
      { text: 'i', i: true },
      { text: ' ' },
      { text: 'u', u: true },
      { text: ' ' },
      { text: 's', s: true },
    ]);
  });

  it('marcadores desligam ao reaparecer', () => {
    expect(parseInline('**a** normal **b**')).toEqual([
      { text: 'a', b: true },
      { text: ' normal ' },
      { text: 'b', b: true },
    ]);
  });
});

describe('parseNoteMarkdown', () => {
  it('classifica h1/h2/item/texto', () => {
    const lines = parseNoteMarkdown('# Título\n## Sub\n- [ ] tarefa\n- [x] feita\ntexto', measure, 1000);
    expect(lines.map((l) => l.kind)).toEqual(['h1', 'h2', 'item', 'item', 'text']);
    expect(lines[3].done).toBe(true);
    expect(lines[2].done).toBeUndefined();
  });

  it('itens marcados ficam riscados (s: true) em todos os runs', () => {
    const lines = parseNoteMarkdown('- [x] **importante**', measure, 1000);
    expect(lines[0].runs.every((r) => r.s === true)).toBe(true);
  });

  it('quebra linhas longas (wrap) preservando estilo', () => {
    // maxW 100 → 10 glifos por linha
    const lines = parseNoteMarkdown('abcdefghij klmno', measure, 100);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.kind === 'text')).toBe(true);
  });

  it('linha vazia mantém espaço (parágrafo)', () => {
    const lines = parseNoteMarkdown('a\n\nb', measure, 1000);
    expect(lines).toHaveLength(3);
    expect(lines[1].runs[0].text).toBe('');
  });
});

describe('wrapRuns', () => {
  it('linha curta não quebra', () => {
    expect(wrapRuns([{ text: 'ola' }], 0, measure, 1000)).toEqual([[{ text: 'ola' }]]);
  });

  it('quebra na largura e agrupa runs iguais', () => {
    // maxW 100 (10 glifos): "aaaa bbbb " cabe (10 glifos com espaços), "cccc" quebra
    const lines = wrapRuns([{ text: 'aaaa bbbb cccc' }], 0, measure, 100);
    expect(lines.length).toBe(2);
    expect(lines[0].map((r) => r.text).join('')).toBe('aaaa bbbb ');
    expect(lines[1][0].text).toBe('cccc');
  });

  it('hardFactor reserva margem (checkbox)', () => {
    const full = wrapRuns([{ text: 'aaaa bbbb cccc' }], 0, measure, 100);
    const withFactor = wrapRuns([{ text: 'aaaa bbbb cccc' }], 1, measure, 100);
    expect(withFactor.length).toBeGreaterThan(full.length);
  });
});

describe('applyLineFormat', () => {
  const t = 'um\ndois\ntres';

  it('aplica H1 na linha da seleção', () => {
    const r = applyLineFormat(t, 3, 7, 'h1'); // "dois" (índices 3..7)
    expect(r.text).toBe('um\n# dois\ntres');
  });

  it('toggle: H2 → H1 troca o prefixo', () => {
    const r = applyLineFormat('## dois', 0, 7, 'h1');
    expect(r.text).toBe('# dois');
  });

  it('toggle: já H1 → volta a texto normal', () => {
    const r = applyLineFormat('# dois', 0, 6, 'h1');
    expect(r.text).toBe('dois');
  });

  it('texto normal remove qualquer título', () => {
    expect(applyLineFormat('## a', 0, 4, 'text').text).toBe('a');
    expect(applyLineFormat('# a', 0, 3, 'text').text).toBe('a');
  });
});

describe('toggleChecklist', () => {
  it('marca linha simples como pendente', () => {
    expect(toggleChecklist('comprar leite', 0, 13).text).toBe('- [ ] comprar leite');
  });

  it('toggle: pendente → marcado', () => {
    expect(toggleChecklist('- [ ] a', 0, 7).text).toBe('- [x] a');
  });

  it('toggle: todas marcadas → desmarca', () => {
    expect(toggleChecklist('- [x] a\n- [x] b', 0, 15).text).toBe('a\nb');
  });

  it('títulos viram itens (perde o prefixo #)', () => {
    expect(toggleChecklist('# a', 0, 3).text).toBe('- [ ] a');
  });
});

describe('applyInlineFormat', () => {
  it('embrulha a seleção com **', () => {
    const r = applyInlineFormat('olá mundo', 4, 9, 'b');
    expect(r.text).toBe('olá **mundo**');
    expect(r.start).toBe(6); // cursor dentro do par
    expect(r.end).toBe(11);
  });

  it('toggle OFF remove marcadores vizinhos', () => {
    // 'olá **mundo**' — seleção = "mundo" (índices 6..11)
    const r = applyInlineFormat('olá **mundo**', 6, 11, 'b');
    expect(r.text).toBe('olá mundo');
  });

  it('seleção que já É o par marcado vira conteúdo puro', () => {
    const r = applyInlineFormat('olá **mundo**', 4, 13, 'b'); // seleção = "**mundo**"
    expect(r.text).toBe('olá mundo');
    expect(r.start).toBe(4);
  });

  it('seleção vazia insere o par e posiciona o cursor', () => {
    // marcador do itálico é '*' (1 char): 'a' + '*' + '' + '*' + 'b'
    const r = applyInlineFormat('ab', 1, 1, 'i');
    expect(r.text).toBe('a**b');
    expect(r.start).toBe(2);
  });
});

describe('noteTextToHtml', () => {
  it('linha simples vira div.nl-line.nl-p', () => {
    const html = noteTextToHtml('oi');
    expect(html).toBe('<div class="nl-line nl-p">oi</div>');
  });

  it('título e subtítulo ganham as classes nl-h1/nl-h2 (sem # visível)', () => {
    const html = noteTextToHtml('# Título\n## Sub');
    expect(html).toContain('<div class="nl-line nl-h1">Título</div>');
    expect(html).toContain('<div class="nl-line nl-h2">Sub</div>');
  });

  it('item de checklist tem .nl-box (contenteditable=false) e data-done', () => {
    const html = noteTextToHtml('- [ ] comprar\n- [x] feito');
    expect(html).toContain('class="nl-line nl-item" data-done="0"');
    expect(html).toContain('class="nl-line nl-item" data-done="1"');
    expect((html.match(/class="nl-box" contenteditable="false"/g) ?? []).length).toBe(2);
    expect(html).toContain('>comprar</span>');
    expect(html).toContain('>feito</span>');
  });

  it('formatação inline vira <b>/<i>/<u>/<s> de verdade', () => {
    const html = noteTextToHtml('**b** *i* __u__ ~~s~~');
    expect(html).toContain('<b>b</b>');
    expect(html).toContain('<i>i</i>');
    expect(html).toContain('<u>u</u>');
    expect(html).toContain('<s>s</s>');
  });

  it('escapa HTML do texto (segurança)', () => {
    const html = noteTextToHtml('<img src=x>&"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;&amp;&quot;');
  });

  it('texto vazio gera uma linha vazia (parágrafo)', () => {
    const html = noteTextToHtml('');
    expect(html).toBe('<div class="nl-line nl-p"></div>');
  });
});

describe('computeReminder', () => {
  // 2026-05-13 (quarta) 10:00 local
  const now = new Date(2026, 4, 13, 10, 0, 0, 0).getTime();

  it('hoje = 18:00 do mesmo dia', () => {
    const ms = computeReminder('today', now)!;
    const d = new Date(ms);
    expect(d.getHours()).toBe(18);
    expect(d.getDate()).toBe(13);
  });

  it('hoje após as 18h → agora+1h (outro dia, se virar)', () => {
    const tarde = new Date(2026, 4, 13, 18, 30).getTime();
    const ms = computeReminder('today', tarde)!;
    expect(ms).toBeGreaterThan(tarde);
  });

  it('amanhã = 08:00 do dia seguinte', () => {
    const d = new Date(computeReminder('tomorrow', now)!);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(8);
  });

  it('próxima semana = segunda 08:00', () => {
    const ms = computeReminder('nextweek', now)!;
    const d = new Date(ms);
    expect(d.getDay()).toBe(1); // segunda
    expect(d.getHours()).toBe(8);
    expect(ms).toBeGreaterThan(now);
  });

  it('custom devolve o epoch passado', () => {
    expect(computeReminder('custom', now, 12345)).toBe(12345);
    expect(computeReminder('custom', now)).toBeNull();
  });
});
