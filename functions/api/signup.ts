/**
 * POST /api/signup { email, password } — cria conta + sessão (auto-login).
 * Erros SEMPRE genéricos (AUTH_FAILED) p/ não revelar existência de conta.
 */
import {
  ensureSchema,
  makeHash,
  createSession,
  normalizeEmail,
  validPassword,
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

    const email = normalizeEmail(body.email);
    if (!email) return json({ error: 'AUTH_BAD_EMAIL' as AuthErr }, 400);
    if (!validPassword(body.password)) return json({ error: 'AUTH_BAD_PASSWORD' as AuthErr }, 400);

    const ip = clientIp(ctx.request);
    if (!rateLimit(ip, 'signup')) return json({ error: 'AUTH_RATE' as AuthErr }, 429);

    // Conta já existe? Mesmo erro genérico do login (não revelar).
    const existing = await db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .bind(email)
      .first<{ id: string }>();
    if (existing) return json({ error: 'AUTH_FAILED' as AuthErr }, 400);

    const { salt, hash } = await makeHash(body.password);
    const userId = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO users (id, email, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(userId, email, salt, hash, Date.now())
      .run();

    const { cookie } = await createSession(db, userId);
    return json({ ok: true, email }, 200, { 'Set-Cookie': cookie });
  } catch (e) {
    console.warn('signup error', e);
    // TEMP (diagnóstico CPU): expõe a mensagem do erro no 500. REMOVER após o diagnóstico.
    const detail = String((e as Error)?.message ?? e).slice(0, 80);
    return json({ error: 'AUTH_UNAVAILABLE', detail }, 500);
  }
};
