/**
 * PR4.14 — Isolamento de projetos por usuário (Taiga).
 * O `/projects` devolve os projetos do usuário MAIS os públicos do servidor;
 * `pickMyProjects` deve ficar só com os de MEMBRO.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickMyProjects, fetchTaigaProjects, type TaigaProject } from '@taiga/taiga';

const p = (slug: string, isMember?: boolean): TaigaProject => ({
  id: 1,
  slug,
  name: slug,
  isMember,
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('pickMyProjects (PR4.14)', () => {
  it('mantém só os projetos dos quais o usuário é membro', () => {
    const all = [p('meu-projeto', true), p('publico-do-servidor', false), p('outro-alheio', false)];
    expect(pickMyProjects(all).map((x) => x.slug)).toEqual(['meu-projeto']);
  });

  it('mantém apenas os marcados como membro/owner', () => {
    const all = [p('membro-ou-dono', true), p('publico', false)];
    expect(pickMyProjects(all).map((x) => x.slug)).toEqual(['membro-ou-dono']);
  });

  it('API antiga sem flags (isMember undefined) → sem filtro, sem regressão', () => {
    const all = [p('a'), p('b')];
    expect(pickMyProjects(all)).toEqual(all);
  });

  it('nenhum membro (flags presentes) → lista vazia', () => {
    const all = [p('publico-1', false), p('publico-2', false)];
    expect(pickMyProjects(all)).toEqual([]);
  });

  it('lista vazia → lista vazia', () => {
    expect(pickMyProjects([])).toEqual([]);
  });
});

describe('fetchTaigaProjects — parse das flags do Taiga (PR4.14)', () => {
  it('lê i_am_member/i_am_owner em cada projeto', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: 1, slug: 'meu', name: 'Meu', i_am_member: true, i_am_owner: false },
            { id: 2, slug: 'dono', name: 'Dono', i_am_member: false, i_am_owner: true },
            { id: 3, slug: 'publico', name: 'Público', i_am_member: false, i_am_owner: false },
            { id: 4, slug: 'antigo', name: 'Sem flag' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const all = await fetchTaigaProjects();
    expect(all.map((x) => [x.slug, x.isMember])).toEqual([
      ['meu', true],
      ['dono', true],
      ['publico', false],
      ['antigo', undefined],
    ]);
    // e o isolamento conjunto → só os do usuário
    expect(pickMyProjects(all).map((x) => x.slug)).toEqual(['meu', 'dono']);
  });
});
