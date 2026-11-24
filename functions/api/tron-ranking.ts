/**
 * GET  /api/tron-ranking — retorna o ranking Top 20 do TRON Light Cycles e os dados do usuário logado.
 * POST /api/tron-ranking — registra/atualiza nickname, pontuação máxima e nível máximo do usuário logado.
 *
 * Acesso restrito a usuários autenticados (sessão BumpTop D1 via cookie OU token JWT do Taiga).
 */
import { ensureSchema, getSessionUser, json, type D1Like, type EnvLike, type FnCtx } from './_lib';

interface TronScoreRow {
  user_id: string;
  nickname: string;
  best_score: number;
  max_level: number;
  updated_at: number;
}

function parseTaigaJwtUserId(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = atob(b64);
    const payload = JSON.parse(jsonStr) as { user_id?: number | string; exp?: number };
    if (!payload || payload.user_id === undefined || payload.user_id === null) return null;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return `taiga:${String(payload.user_id)}`;
  } catch {
    return null;
  }
}

async function resolveLoggedUser(
  db: D1Like,
  request: Request,
): Promise<{ userId: string; defaultNick: string } | null> {
  const session = await getSessionUser(db, request);
  if (session) {
    return {
      userId: session.userId,
      defaultNick: session.email.split('@')[0] || 'Player',
    };
  }
  const taigaId = parseTaigaJwtUserId(request);
  if (taigaId) {
    const hint = request.headers.get('X-Taiga-Name')?.trim();
    return {
      userId: taigaId,
      defaultNick: (hint && hint.slice(0, 20)) || 'Piloto Taiga',
    };
  }
  return null;
}

function sanitizeNickname(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback.slice(0, 20);
  const clean = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
  return clean.length >= 2 ? clean : fallback.slice(0, 20);
}

async function loadRanking(db: D1Like, currentUserId: string) {
  const res = await db
    .prepare(
      `SELECT user_id, nickname, best_score, max_level, updated_at
       FROM tron_scores
       ORDER BY best_score DESC, max_level DESC, updated_at ASC
       LIMIT 20`,
    )
    .all<TronScoreRow>();

  const rows = res.results ?? [];
  const ranking = rows.map((r, idx) => ({
    rank: idx + 1,
    userId: r.user_id,
    nickname: r.nickname,
    bestScore: Number(r.best_score) || 0,
    maxLevel: Number(r.max_level) || 1,
    isMe: r.user_id === currentUserId,
  }));

  const meRow = await db
    .prepare(`SELECT user_id, nickname, best_score, max_level FROM tron_scores WHERE user_id = ?`)
    .bind(currentUserId)
    .first<TronScoreRow>();

  const me = meRow
    ? {
        userId: meRow.user_id,
        nickname: meRow.nickname,
        bestScore: Number(meRow.best_score) || 0,
        maxLevel: Number(meRow.max_level) || 1,
      }
    : null;

  return { me, ranking };
}

export const onRequestGet = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    const user = await resolveLoggedUser(db, ctx.request);
    if (!user) return json({ error: 'AUTH_REQUIRED' }, 401);

    const data = await loadRanking(db, user.userId);
    return json(data);
  } catch (e) {
    console.warn('tron-ranking get error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};

export const onRequestPost = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    const user = await resolveLoggedUser(db, ctx.request);
    if (!user) return json({ error: 'AUTH_REQUIRED' }, 401);

    const body = (await ctx.request.json().catch(() => null)) as {
      nickname?: unknown;
      score?: unknown;
      level?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'BAD_PAYLOAD' }, 400);
    }

    const existing = await db
      .prepare(`SELECT nickname, best_score, max_level FROM tron_scores WHERE user_id = ?`)
      .bind(user.userId)
      .first<{ nickname: string; best_score: number; max_level: number }>();

    const nickname = sanitizeNickname(body.nickname, existing?.nickname || user.defaultNick);
    const scoreIn = typeof body.score === 'number' && Number.isFinite(body.score) ? Math.max(0, Math.floor(body.score)) : 0;
    const levelIn = typeof body.level === 'number' && Number.isFinite(body.level) ? Math.max(1, Math.floor(body.level)) : 1;

    const bestScore = Math.max(existing?.best_score ?? 0, scoreIn);
    const maxLevel = Math.max(existing?.max_level ?? 1, levelIn);

    await db
      .prepare(
        `INSERT INTO tron_scores (user_id, nickname, best_score, max_level, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           nickname = excluded.nickname,
           best_score = MAX(tron_scores.best_score, excluded.best_score),
           max_level = MAX(tron_scores.max_level, excluded.max_level),
           updated_at = excluded.updated_at`,
      )
      .bind(user.userId, nickname, bestScore, maxLevel, Date.now())
      .run();

    const data = await loadRanking(db, user.userId);
    return json({ ok: true, ...data });
  } catch (e) {
    console.warn('tron-ranking post error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};
