import type { PagesFunction, SceneRow } from './_types';
import { getSessionUser, jsonResponse } from './_auth';

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({ ok: false, error: 'Banco de dados não configurado' }, 503);
  }

  const user = await getSessionUser(env.DB, request);
  if (!user) {
    return jsonResponse({ ok: false, error: 'Não autenticado' }, 401);
  }

  try {
    const row = await env.DB
      .prepare('SELECT payload, updated_at FROM scenes WHERE user_id = ?')
      .bind(user.id)
      .first<Pick<SceneRow, 'payload' | 'updated_at'>>();

    if (!row || !row.payload) {
      return jsonResponse({ ok: true, scene: null });
    }

    let parsed = null;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      parsed = null;
    }

    return jsonResponse({
      ok: true,
      scene: parsed,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    console.error('Erro ao buscar cena no D1:', e);
    return jsonResponse({ ok: false, error: 'Erro ao carregar cena' }, 500);
  }
};

export const onRequestPut: PagesFunction = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({ ok: false, error: 'Banco de dados não configurado' }, 503);
  }

  const user = await getSessionUser(env.DB, request);
  if (!user) {
    return jsonResponse({ ok: false, error: 'Não autenticado' }, 401);
  }

  let body: { scene?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Corpo da requisição inválido' }, 400);
  }

  if (!body || typeof body !== 'object' || !body.scene) {
    return jsonResponse({ ok: false, error: 'Snapshot da cena ausente' }, 400);
  }

  const payloadStr = typeof body.scene === 'string' ? body.scene : JSON.stringify(body.scene);
  const now = Date.now();

  try {
    // Upsert na tabela scenes garantindo isolamento total por user_id
    await env.DB
      .prepare(
        `INSERT INTO scenes (user_id, payload, updated_at) 
         VALUES (?, ?, ?) 
         ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .bind(user.id, payloadStr, now)
      .run();

    return jsonResponse({ ok: true, updatedAt: now });
  } catch (e) {
    console.error('Erro ao salvar cena no D1:', e);
    return jsonResponse({ ok: false, error: 'Erro ao salvar cena' }, 500);
  }
};
