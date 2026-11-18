import type { PagesFunction, UserRow } from '../_types';
import {
  checkRateLimit,
  createSession,
  buildSessionCookie,
  verifyPassword,
  jsonResponse,
} from '../_auth';

export const onRequestPost: PagesFunction = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({ ok: false, error: 'Banco de dados não configurado' }, 503);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const allowed = await checkRateLimit(env.DB, clientIp, 'signin', 10, 5 * 60 * 1000);
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'Muitas tentativas. Tente novamente mais tarde.' }, 429);
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Dados inválidos' }, 400);
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!rawEmail || !password) {
    return jsonResponse({ ok: false, error: 'E-mail ou senha inválidos' }, 400);
  }

  try {
    const user = await env.DB
      .prepare('SELECT id, email, salt, hash FROM users WHERE email = ?')
      .bind(rawEmail)
      .first<UserRow>();

    if (!user) {
      return jsonResponse({ ok: false, error: 'E-mail ou senha inválidos' }, 401);
    }

    const valid = await verifyPassword(password, user.salt, user.hash);
    if (!valid) {
      return jsonResponse({ ok: false, error: 'E-mail ou senha inválidos' }, 401);
    }

    const { token } = await createSession(env.DB, user.id);
    const cookie = buildSessionCookie(token);

    return jsonResponse(
      {
        ok: true,
        user: { id: user.id, email: user.email },
      },
      200,
      { 'Set-Cookie': cookie }
    );
  } catch (e) {
    console.error('Erro no signin:', e);
    return jsonResponse({ ok: false, error: 'Erro ao autenticar' }, 500);
  }
};
