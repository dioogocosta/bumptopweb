import type { PagesFunction } from '../_types';
import {
  checkRateLimit,
  createSession,
  buildSessionCookie,
  hashPassword,
  jsonResponse,
} from '../_auth';

export const onRequestPost: PagesFunction = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({ ok: false, error: 'Banco de dados não configurado' }, 503);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const allowed = await checkRateLimit(env.DB, clientIp, 'signup', 10, 5 * 60 * 1000);
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

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(rawEmail) || password.length < 8) {
    return jsonResponse({ ok: false, error: 'E-mail ou senha inválidos' }, 400);
  }

  try {
    // Verifica se já existe usuário com este e-mail
    const existing = await env.DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(rawEmail)
      .first<{ id: string }>();

    if (existing) {
      // Resposta genérica para evitar enumeração de contas
      return jsonResponse({ ok: false, error: 'E-mail ou senha inválidos' }, 400);
    }

    const userId = crypto.randomUUID();
    const { salt, hash } = await hashPassword(password);
    const createdAt = Date.now();

    await env.DB
      .prepare('INSERT INTO users (id, email, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, rawEmail, salt, hash, createdAt)
      .run();

    const { token } = await createSession(env.DB, userId);
    const cookie = buildSessionCookie(token);

    return jsonResponse(
      {
        ok: true,
        user: { id: userId, email: rawEmail },
      },
      200,
      { 'Set-Cookie': cookie }
    );
  } catch (e) {
    console.error('Erro no signup:', e);
    return jsonResponse({ ok: false, error: 'Erro ao criar conta' }, 500);
  }
};
