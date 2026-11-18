import type { PagesFunction } from '../_types';
import {
  getSessionTokenFromRequest,
  sha256Hex,
  buildClearSessionCookie,
  jsonResponse,
} from '../_auth';

export const onRequestPost: PagesFunction = async (context) => {
  const { request, env } = context;

  const token = getSessionTokenFromRequest(request);
  if (token && env.DB) {
    try {
      const tokenHash = await sha256Hex(token);
      await env.DB
        .prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(tokenHash)
        .run();
    } catch (e) {
      console.warn('Erro ao remover sessão no signout:', e);
    }
  }

  return jsonResponse(
    { ok: true },
    200,
    { 'Set-Cookie': buildClearSessionCookie() }
  );
};
