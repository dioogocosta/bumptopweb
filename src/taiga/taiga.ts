// ---------------------------------------------------------------------------
// PR4.5 — Backlog (Taiga): leitura PÚBLICA da API do Taiga da FNDE.
// A API real fica em `taiga-api.fnde.gov.br` (o `taiga.fnde.gov.br` serve
// só o SPA) e responde com `Access-Control-Allow-Origin: *` — dá para
// chamar direto do browser, sem Pages Functions proxy.
// Escopo v1: só leitura de projetos/user stories públicos (sem login).
// ---------------------------------------------------------------------------

import type { TaigaStory } from '../core/model/types';

const API = 'https://taiga-api.fnde.gov.br/api/v1';

/** Um projeto público do Taiga (só o necessário p/ o seletor). */
export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
}

/** Erro amigável p/ a UI (mensagem já em PT). */
export class TaigaError extends Error {}

async function getJson<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new TaigaError('ui.taiga.netError');
  }
  if (!r.ok) throw new TaigaError('ui.taiga.httpError');
  try {
    return (await r.json()) as T;
  } catch {
    throw new TaigaError('ui.taiga.httpError');
  }
}

/** Lista os projetos públicos (máx. 50) — p/ o seletor quando não há slug. */
export async function fetchTaigaProjects(): Promise<TaigaProject[]> {
  const raw = await getJson<Array<{ id: number; slug: string; name: string }>>(
    '/projects?limit=50',
  );
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.slug === 'string')
    .map((p) => ({ id: p.id, slug: p.slug, name: p.name || p.slug }));
}

/** Lista as user stories de um projeto (slug → id → stories, máx. 200). */
export async function fetchTaigaStories(slug: string): Promise<TaigaStory[]> {
  const limpo = slug.trim().toLowerCase();
  if (!limpo) throw new TaigaError('ui.taiga.noSlug');
  // ATENÇÃO: o filtro `?slug=` do /projects desta instância é IGNORADO
  // (sempre devolve a lista toda) — busca o projeto listando e casa local.
  const projetos = await getJson<Array<{ id: number; slug: string }>>('/projects?limit=50');
  const proj = Array.isArray(projetos) ? projetos.find((p) => p && p.slug === limpo) : null;
  if (!proj) throw new TaigaError('ui.taiga.notFound');
  const us = await getJson<
    Array<{
      id: number;
      ref: number;
      subject: string;
      status_extra_info?: { name?: string; color?: string; is_closed?: boolean };
    }>
  >(`/userstories?project=${proj.id}&limit=200`);
  if (!Array.isArray(us)) return [];
  return us.map((s) => ({
    id: s.id,
    ref: s.ref ?? 0,
    subject: s.subject || `#${s.ref}`,
    statusName: s.status_extra_info?.name || 'Backlog',
    statusColor: s.status_extra_info?.color || '#8b5cf6',
    isClosed: !!s.status_extra_info?.is_closed,
  }));
}
