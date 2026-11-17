/** POST /api/logout — apaga a sessão no banco + limpa o cookie. */
import { ensureSchema, destroySession, clearSessionCookie, json, type EnvLike, type FnCtx } from './_lib';

export const onRequestPost = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  try {
    await ensureSchema(db);
    await destroySession(db, ctx.request);
  } catch (e) {
    console.warn('logout error', e);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
};
