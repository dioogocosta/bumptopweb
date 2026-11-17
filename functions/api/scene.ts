/**
 * GET  /api/scene — snapshot da cena do usuário (null se nunca subiu).
 * PUT  /api/scene — salva o snapshot (uma linha por usuário; upsert).
 * user_id SEMPRE vem do cookie de sessão — o corpo do PUT é só o snapshot.
 */
import { ensureSchema, getSessionUser, json, type EnvLike, type FnCtx } from './_lib';

const MAX_PAYLOAD = 2 * 1024 * 1024; // 2 MB de segurança (D1 TEXT aguenta; evita abusos)

export const onRequestGet = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    const user = await getSessionUser(db, ctx.request);
    if (!user) return json({ error: 'AUTH_REQUIRED' }, 401);
    const row = await db
      .prepare(`SELECT payload FROM scenes WHERE user_id = ?`)
      .bind(user.userId)
      .first<{ payload: string }>();
    if (!row) return json({ scene: null });
    try {
      return json({ scene: JSON.parse(row.payload) });
    } catch {
      return json({ scene: null }); // payload corrompido → modo local
    }
  } catch (e) {
    console.warn('scene get error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};

export const onRequestPut = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    const user = await getSessionUser(db, ctx.request);
    if (!user) return json({ error: 'AUTH_REQUIRED' }, 401);

    const scene = await ctx.request.json().catch(() => null);
    if (!scene || typeof scene !== 'object' || !Array.isArray((scene as { objects?: unknown }).objects)) {
      return json({ error: 'AUTH_BAD_PAYLOAD' }, 400);
    }
    const payload = JSON.stringify(scene);
    if (payload.length > MAX_PAYLOAD) return json({ error: 'AUTH_TOO_LARGE' }, 413);

    await db
      .prepare(
        `INSERT INTO scenes (user_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .bind(user.userId, payload, Date.now())
      .run();
    return json({ ok: true });
  } catch (e) {
    console.warn('scene put error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};
