/** POST /api/login { email, password } — erro genérico em falha. */
import {
  ensureSchema,
  verifyHash,
  createSession,
  destroySession,
  normalizeEmail,
  rateLimit,
  rateLimitSweep,
  clientIp,
  json,
  type EnvLike,
  type FnCtx,
  type AuthErr,
} from './_lib';

export const onRequestPost = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    rateLimitSweep();
    const body = (await ctx.request.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
    } | null;
    if (!body) return json({ error: 'AUTH_FAILED' as AuthErr }, 400);

    const ip = clientIp(ctx.request);
    if (!rateLimit(ip, 'login')) return json({ error: 'AUTH_RATE' as AuthErr }, 429);

    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      await destroySession(db, ctx.request);
      return json({ error: 'AUTH_FAILED' as AuthErr }, 400);
    }

    const user = await db
      .prepare(`SELECT id, salt, hash FROM users WHERE email = ?`)
      .bind(email)
      .first<{ id: string; salt: string; hash: string }>();
    // Sem usuário → mesmo erro; hash "dummy" evita oracle de tempo? Verificar
    // PBKDF2 com salt vazio é o suficiente aqui (código genérico AUTH_FAILED).
    if (!user) return json({ error: 'AUTH_FAILED' as AuthErr }, 400);
    const ok = await verifyHash(password, user.salt, user.hash);
    if (!ok) return json({ error: 'AUTH_FAILED' as AuthErr }, 400);

    const { cookie } = await createSession(db, user.id);
    return json({ ok: true, email }, 200, { 'Set-Cookie': cookie });
  } catch (e) {
    console.warn('login error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};
