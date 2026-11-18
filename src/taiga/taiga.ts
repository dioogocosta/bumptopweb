// ---------------------------------------------------------------------------
// PR4.5 — Backlog (Taiga): leitura da API do Taiga da FNDE.
// A API real fica em `taiga-api.fnde.gov.br` (o `taiga.fnde.gov.br` serve
// só o SPA) e responde com `Access-Control-Allow-Origin: *`.
// PR4.6 — adiciona fetch de sprints (milestones) e stories por sprint.
// PR4.7 — suporte a autenticação por Bearer token (JWT) para acessar
// projetos privados, user stories e sprints da sessão logada.
// ---------------------------------------------------------------------------

import type { TaigaStory } from '../core/model/types';

const API = 'https://taiga-api.fnde.gov.br/api/v1';
const TOKEN_KEY = 'bumptop_taiga_token';

/** Obtém o token de autenticação salvo no navegador. */
export function getTaigaToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Salva ou remove o token de autenticação no navegador. */
export function setTaigaToken(token: string | null): void {
  try {
    if (token && token.trim()) {
      localStorage.setItem(TOKEN_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {}
}

/** Inicializa o token a partir do parâmetro ?taiga_token= na URL se presente. */
export function initTaigaTokenFromUrl(): void {
  try {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get('taiga_token');
    if (token) {
      setTaigaToken(token);
      url.searchParams.delete('taiga_token');
      window.history.replaceState({}, document.title, url.toString());
    }
  } catch {}
}

/** Um usuário do Taiga autenticado. */
export interface TaigaUser {
  id: number;
  username: string;
  fullName: string;
}

/** Um projeto do Taiga (público ou privado). */
export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
}

/** Uma sprint (milestone) do Taiga. */
export interface TaigaSprint {
  id: number;
  name: string;
  slug: string;
  closed: boolean;
  estimated_start: string | null;
  estimated_finish: string | null;
}

/** Erro amigável p/ a UI (mensagem já em chave i18n). */
export class TaigaError extends Error {}

async function getJson<T>(path: string): Promise<T> {
  let r: Response;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getTaigaToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    r = await fetch(`${API}${path}`, { headers });
  } catch {
    throw new TaigaError('ui.taiga.netError');
  }

  if (r.status === 401 || r.status === 403) {
    throw new TaigaError('ui.taiga.invalidToken');
  }
  if (!r.ok) throw new TaigaError('ui.taiga.httpError');

  try {
    return (await r.json()) as T;
  } catch {
    throw new TaigaError('ui.taiga.httpError');
  }
}

/** Obtém os dados do usuário autenticado no Taiga. Retorna null se não logado/inválido. */
export async function fetchTaigaMe(): Promise<TaigaUser | null> {
  const token = getTaigaToken();
  if (!token) return null;
  try {
    const raw = await getJson<{ id: number; username: string; full_name?: string }>('/users/me');
    if (!raw || typeof raw.id !== 'number') return null;
    return {
      id: raw.id,
      username: raw.username,
      fullName: raw.full_name || raw.username,
    };
  } catch {
    return null;
  }
}

/** Lista os projetos disponíveis (públicos e privados da conta logada). */
export async function fetchTaigaProjects(): Promise<TaigaProject[]> {
  const raw = await getJson<Array<{ id: number; slug: string; name: string }>>(
    '/projects?limit=100',
  );
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.slug === 'string')
    .map((p) => ({ id: p.id, slug: p.slug, name: p.name || p.slug }));
}

/**
 * Resolve o ID de um projeto pelo slug.
 * Tenta primeiro busca direta por slug (suporta projetos privados), depois fallback de lista.
 */
export async function resolveProjectId(slug: string): Promise<number> {
  const limpo = slug.trim().toLowerCase();
  if (!limpo) throw new TaigaError('ui.taiga.noSlug');

  try {
    const p = await getJson<{ id: number; slug: string }>(`/projects/by_slug?slug=${encodeURIComponent(limpo)}`);
    if (p && typeof p.id === 'number') return p.id;
  } catch {
    /* fallback para listar projetos */
  }

  const projetos = await getJson<Array<{ id: number; slug: string }>>('/projects?limit=100');
  const proj = Array.isArray(projetos) ? projetos.find((p) => p && p.slug === limpo) : null;
  if (!proj) throw new TaigaError('ui.taiga.notFound');
  return proj.id;
}

/** Lista as sprints (milestones) de um projeto — ordenadas por data de início desc. */
export async function fetchTaigaSprints(projectId: number): Promise<TaigaSprint[]> {
  const raw = await getJson<
    Array<{
      id: number;
      name: string;
      slug: string;
      closed: boolean;
      estimated_start: string | null;
      estimated_finish: string | null;
    }>
  >(`/milestones?project=${projectId}&order_by=-estimated_start&limit=20`);
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    id: s.id,
    name: s.name || `Sprint ${s.id}`,
    slug: s.slug || String(s.id),
    closed: !!s.closed,
    estimated_start: s.estimated_start ?? null,
    estimated_finish: s.estimated_finish ?? null,
  }));
}

/** Stories de uma sprint específica (milestone). */
export async function fetchSprintStories(milestoneId: number): Promise<TaigaStory[]> {
  const us = await getJson<
    Array<{
      id: number;
      ref: number;
      subject: string;
      status_extra_info?: { name?: string; color?: string; is_closed?: boolean };
    }>
  >(`/userstories?milestone=${milestoneId}&limit=200`);
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

/** Lista as user stories de um projeto (slug → id → stories, máx. 200). */
export async function fetchTaigaStories(slug: string): Promise<TaigaStory[]> {
  const projectId = await resolveProjectId(slug);
  const us = await getJson<
    Array<{
      id: number;
      ref: number;
      subject: string;
      status_extra_info?: { name?: string; color?: string; is_closed?: boolean };
    }>
  >(`/userstories?project=${projectId}&limit=200`);
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
