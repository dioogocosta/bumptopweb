/**
 * API Multiplayer Online do TRON Light Cycles (/api/tron-room).
 * - GET  ?history=1 -> histórico de partidas e vitórias do usuário logado
 * - GET  ?code=XXXXX -> estado atual da sala (lobby / playing / finished)
 * - POST { action: 'create' | 'join' | 'start' | 'sync' | 'leave', ... }
 * Acesso restrito a usuários autenticados (BumpTop D1 ou Taiga JWT).
 */
import { ensureSchema, getSessionUser, json, type D1Like, type EnvLike, type FnCtx } from './_lib';

const PALETTE = [
  'blue',
  'red',
  'yellow',
  'orange',
  'green',
  'purple',
  'cyan',
  'pink',
  'lime',
  'white',
] as const;

export interface RoomPlayer {
  userId: string;
  nickname: string;
  color: string;
  slot: number;
  x: number;
  z: number;
  dir: number;
  alive: boolean;
  score: number;
  crashedAt: number | null;
  segments: Array<{ x1: number; z1: number; x2: number; z2: number }>;
  updatedAt: number;
}

interface RoomRow {
  code: string;
  host_user_id: string;
  status: 'lobby' | 'playing' | 'finished';
  max_players: number;
  taiga_project: string | null;
  taiga_box_name: string | null;
  players_json: string;
  created_at: number;
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
    const payload = JSON.parse(atob(b64)) as { user_id?: number | string; exp?: number };
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
): Promise<{ userId: string; defaultNick: string; hasTaiga: boolean } | null> {
  const taigaId = parseTaigaJwtUserId(request);
  const session = await getSessionUser(db, request);
  if (session) {
    return {
      userId: session.userId,
      defaultNick: session.email.split('@')[0] || 'Player',
      hasTaiga: !!taigaId,
    };
  }
  if (taigaId) {
    const hint = request.headers.get('X-Taiga-Name')?.trim();
    return {
      userId: taigaId,
      defaultNick: (hint && hint.slice(0, 20)) || 'Piloto Taiga',
      hasTaiga: true,
    };
  }
  return null;
}

function sanitizeNick(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback.slice(0, 20);
  const clean = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
  return clean.length >= 2 ? clean : fallback.slice(0, 20);
}

function computeStandings(players: RoomPlayer[]) {
  // Último sobrevivente = 1º lugar (vencedor). Entre os que bateram, quem durou mais fica na frente.
  const ordered = [...players].sort((a, b) => {
    if (a.alive && !b.alive) return -1;
    if (!a.alive && b.alive) return 1;
    const ca = a.crashedAt ?? Number.MAX_SAFE_INTEGER;
    const cb = b.crashedAt ?? Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return cb - ca;
    return b.score - a.score;
  });
  return ordered.map((p, idx) => ({
    placement: idx + 1,
    userId: p.userId,
    nickname: p.nickname,
    color: p.color,
    alive: p.alive,
    score: p.score + (ordered.length - idx) * 200,
    isWinner: idx === 0,
  }));
}

function formatRoomResponse(row: RoomRow, currentUserId: string) {
  let players: RoomPlayer[] = [];
  try {
    players = JSON.parse(row.players_json) as RoomPlayer[];
  } catch {
    players = [];
  }
  return {
    code: row.code,
    status: row.status,
    maxPlayers: row.max_players,
    taigaProject: row.taiga_project,
    taigaBoxName: row.taiga_box_name,
    isHost: row.host_user_id === currentUserId,
    myUserId: currentUserId,
    players,
    standings: row.status === 'finished' ? computeStandings(players) : [],
    updatedAt: row.updated_at,
  };
}

async function recordMatchHistory(db: D1Like, roomCode: string, players: RoomPlayer[]): Promise<void> {
  const standings = computeStandings(players);
  const now = Date.now();
  for (const s of standings) {
    const id = `${roomCode}_${s.userId}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO tron_match_history
         (id, user_id, room_code, nickname, placement, total_players, score, is_winner, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.userId, roomCode, s.nickname, s.placement, standings.length, s.score, s.isWinner ? 1 : 0, now)
      .run();
  }
}

export const onRequestGet = async (ctx: FnCtx<EnvLike>): Promise<Response> => {
  const db = ctx.env.DB;
  if (!db) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
  try {
    await ensureSchema(db);
    const user = await resolveLoggedUser(db, ctx.request);
    if (!user) return json({ error: 'AUTH_REQUIRED' }, 401);

    const url = new URL(ctx.request.url);
    if (url.searchParams.get('history') === '1') {
      const rows = await db
        .prepare(
          `SELECT id, room_code, nickname, placement, total_players, score, is_winner, played_at
           FROM tron_match_history
           WHERE user_id = ?
           ORDER BY played_at DESC
           LIMIT 25`,
        )
        .bind(user.userId)
        .all<{
          id: string;
          room_code: string;
          nickname: string;
          placement: number;
          total_players: number;
          score: number;
          is_winner: number;
          played_at: number;
        }>();
      const history = (rows.results ?? []).map((r) => ({
        id: r.id,
        roomCode: r.room_code,
        nickname: r.nickname,
        placement: Number(r.placement),
        totalPlayers: Number(r.total_players),
        score: Number(r.score),
        isWinner: Number(r.is_winner) === 1,
        playedAt: Number(r.played_at),
      }));
      const totalWins = history.filter((h) => h.isWinner).length;
      return json({ totalMatches: history.length, totalWins, history });
    }

    const code = (url.searchParams.get('code') || '').trim();
    if (!/^\d{5}$/.test(code)) return json({ error: 'INVALID_CODE' }, 400);

    const row = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
    if (!row) return json({ error: 'ROOM_NOT_FOUND' }, 404);

    return json({ room: formatRoomResponse(row, user.userId) });
  } catch (e) {
    console.warn('tron-room get error', e);
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

    const body = (await ctx.request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: 'BAD_PAYLOAD' }, 400);
    const action = String(body.action || '');
    const now = Date.now();

    if (action === 'create') {
      const maxPlayers = Math.min(10, Math.max(2, Number(body.maxPlayers) || 5));
      const nickname = sanitizeNick(body.nickname, user.defaultNick);
      const taigaProject = user.hasTaiga && typeof body.taigaProject === 'string' && body.taigaProject ? body.taigaProject.slice(0, 120) : null;
      const taigaBoxName = taigaProject && typeof body.taigaBoxName === 'string' ? body.taigaBoxName.slice(0, 120) : null;

      // Gera código de 5 dígitos único
      let code = '';
      for (let i = 0; i < 6; i++) {
        const candidate = String(10000 + Math.floor(Math.random() * 90000));
        const exists = await db.prepare(`SELECT code FROM tron_rooms WHERE code = ?`).bind(candidate).first();
        if (!exists) {
          code = candidate;
          break;
        }
      }
      if (!code) code = String(10000 + Math.floor(Math.random() * 90000));

      const hostPlayer: RoomPlayer = {
        userId: user.userId,
        nickname,
        color: PALETTE[0],
        slot: 0,
        x: 0,
        z: 0,
        dir: 0,
        alive: true,
        score: 0,
        crashedAt: null,
        segments: [],
        updatedAt: now,
      };

      await db
        .prepare(
          `INSERT INTO tron_rooms (code, host_user_id, status, max_players, taiga_project, taiga_box_name, players_json, created_at, updated_at)
           VALUES (?, ?, 'lobby', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(code, user.userId, maxPlayers, taigaProject, taigaBoxName, JSON.stringify([hostPlayer]), now, now)
        .run();

      const row = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
      return json({ room: formatRoomResponse(row!, user.userId) });
    }

    const code = String(body.code || '').trim();
    if (!/^\d{5}$/.test(code)) return json({ error: 'INVALID_CODE' }, 400);

    const row = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
    if (!row) return json({ error: 'ROOM_NOT_FOUND' }, 404);

    let players = JSON.parse(row.players_json) as RoomPlayer[];

    if (action === 'join') {
      const nickname = sanitizeNick(body.nickname, user.defaultNick);
      const existing = players.find((p) => p.userId === user.userId);
      if (existing) {
        existing.nickname = nickname;
        existing.updatedAt = now;
      } else {
        if (row.status !== 'lobby') return json({ error: 'ROOM_ALREADY_STARTED' }, 409);
        if (players.length >= row.max_players) return json({ error: 'ROOM_FULL' }, 409);
        const slot = players.length;
        players.push({
          userId: user.userId,
          nickname,
          color: PALETTE[slot % PALETTE.length]!,
          slot,
          x: 0,
          z: 0,
          dir: 0,
          alive: true,
          score: 0,
          crashedAt: null,
          segments: [],
          updatedAt: now,
        });
      }
      await db
        .prepare(`UPDATE tron_rooms SET players_json = ?, updated_at = ? WHERE code = ?`)
        .bind(JSON.stringify(players), now, code)
        .run();
      const updated = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
      return json({ room: formatRoomResponse(updated!, user.userId) });
    }

    if (action === 'start') {
      if (row.host_user_id !== user.userId) return json({ error: 'FORBIDDEN' }, 403);
      players = players.map((p, idx) => ({
        ...p,
        slot: idx,
        color: PALETTE[idx % PALETTE.length]!,
        alive: true,
        score: 0,
        crashedAt: null,
        segments: [],
        updatedAt: now,
      }));
      await db
        .prepare(`UPDATE tron_rooms SET status = 'playing', players_json = ?, updated_at = ? WHERE code = ?`)
        .bind(JSON.stringify(players), now, code)
        .run();
      const updated = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
      return json({ room: formatRoomResponse(updated!, user.userId) });
    }

    if (action === 'sync') {
      const me = players.find((p) => p.userId === user.userId);
      if (me && row.status === 'playing') {
        if (typeof body.x === 'number') me.x = body.x;
        if (typeof body.z === 'number') me.z = body.z;
        if (typeof body.dir === 'number') me.dir = body.dir;
        if (typeof body.score === 'number') me.score = body.score;
        if (Array.isArray(body.segments)) {
          me.segments = (body.segments as Array<{ x1: number; z1: number; x2: number; z2: number }>).slice(-120);
        }
        if (body.alive === false && me.alive) {
          me.alive = false;
          me.crashedAt = now;
        }
        me.updatedAt = now;
      }

      let nextStatus = row.status;
      if (row.status === 'playing' && players.length >= 2) {
        const aliveCount = players.filter((p) => p.alive).length;
        if (aliveCount <= 1) {
          nextStatus = 'finished';
          await recordMatchHistory(db, code, players);
        }
      }

      await db
        .prepare(`UPDATE tron_rooms SET status = ?, players_json = ?, updated_at = ? WHERE code = ?`)
        .bind(nextStatus, JSON.stringify(players), now, code)
        .run();
      const updated = await db.prepare(`SELECT * FROM tron_rooms WHERE code = ?`).bind(code).first<RoomRow>();
      return json({ room: formatRoomResponse(updated!, user.userId) });
    }

    return json({ error: 'BAD_ACTION' }, 400);
  } catch (e) {
    console.warn('tron-room post error', e);
    return json({ error: 'AUTH_UNAVAILABLE' }, 500);
  }
};
