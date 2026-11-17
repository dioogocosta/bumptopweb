/** GET /api/session — estado da sessão (resume do cookie no 1º load). */
import { ensureSchema, getSessionUser, json, type EnvLike, type FnCtx } from './_lib';

export const onRequestGet = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ authenticated: false }, 200);
  try {
    await ensureSchema(db);
    const user = await getSessionUser(db, ctx.request);
    return json(user ? { authenticated: true, email: user.email } : { authenticated: false });
  } catch (e) {
    console.warn('session error', e);
    // Degradação graciosa: sem banco, o app segue 100% funcional em modo local
    return json({ authenticated: false, error: 'AUTH_UNAVAILABLE' }, 200);
  }
};
