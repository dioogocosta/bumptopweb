/**
 * Cliente Multiplayer Online do TRON Light Cycles (`/api/tron-room`).
 * Inclui fallback automático via localStorage/BroadcastChannel quando `/api/tron-room`
 * não está disponível (ex.: vite preview local sem Wrangler).
 */
import type { BikeColor } from './tronEngine';

export interface TronOnlinePlayer {
  userId: string;
  nickname: string;
  color: BikeColor;
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

export interface TronStanding {
  placement: number;
  userId: string;
  nickname: string;
  color: string;
  alive: boolean;
  score: number;
  isWinner: boolean;
}

export interface TronOnlineRoom {
  code: string;
  status: 'lobby' | 'playing' | 'finished';
  maxPlayers: number;
  taigaProject: string | null;
  taigaBoxName: string | null;
  isHost: boolean;
  myUserId: string;
  players: TronOnlinePlayer[];
  standings: TronStanding[];
  updatedAt: number;
}

export interface TronMatchHistoryItem {
  id: string;
  roomCode: string;
  nickname: string;
  placement: number;
  totalPlayers: number;
  score: number;
  isWinner: boolean;
  playedAt: number;
}

export interface TronMatchHistoryResponse {
  totalMatches: number;
  totalWins: number;
  history: TronMatchHistoryItem[];
}

export interface TronAuthHeaders {
  taigaToken?: string | null;
  taigaName?: string | null;
  localUserId?: string | null;
}

const LOCAL_ROOMS_KEY = 'bumptop.tron.localRooms';
const LOCAL_HISTORY_KEY = 'bumptop.tron.localHistory';
const PALETTE: BikeColor[] = ['blue', 'red', 'yellow', 'orange', 'green', 'purple', 'cyan', 'pink', 'lime', 'white'];

function buildHeaders(auth?: TronAuthHeaders): HeadersInit {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (auth?.taigaToken) h['Authorization'] = `Bearer ${auth.taigaToken}`;
  if (auth?.taigaName) h['X-Taiga-Name'] = auth.taigaName;
  return h;
}

export function buildWhatsAppShareUrl(roomCode: string, standings: TronStanding[]): string {
  const winner = standings.find((s) => s.isWinner) ?? standings[0];
  const lines: string[] = [
    `🏍️ *TRON Light Cycles — BumpTop 3D*`,
    `🔑 Sala: *${roomCode}*`,
    winner ? `🏆 *Vencedor: ${winner.nickname}* (${winner.score} pts)` : '',
    ``,
    `📊 *Ranking da Partida (por sobrevivência):*`,
    ...standings.map((s) => {
      const medal = s.placement <= 3 ? ['🥇', '🥈', '🥉'][s.placement - 1] : `${s.placement}º`;
      return `${medal} ${s.nickname} — ${s.score} pts`;
    }),
  ].filter(Boolean);
  return `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
}

export async function createTronRoom(opts: {
  nickname: string;
  maxPlayers: number;
  taigaProject?: string | null;
  taigaBoxName?: string | null;
  auth?: TronAuthHeaders;
}): Promise<TronOnlineRoom | null> {
  try {
    const res = await fetch('/api/tron-room', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(opts.auth),
      body: JSON.stringify({
        action: 'create',
        nickname: opts.nickname,
        maxPlayers: opts.maxPlayers,
        taigaProject: opts.taigaProject ?? null,
        taigaBoxName: opts.taigaBoxName ?? null,
      }),
    });
    if (res.status === 404 || res.status === 503) {
      return localCreateRoom(opts);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { room: TronOnlineRoom };
    return data.room;
  } catch {
    return localCreateRoom(opts);
  }
}

export async function joinTronRoom(opts: {
  code: string;
  nickname: string;
  auth?: TronAuthHeaders;
}): Promise<{ room?: TronOnlineRoom; error?: string }> {
  try {
    const res = await fetch('/api/tron-room', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(opts.auth),
      body: JSON.stringify({
        action: 'join',
        code: opts.code.trim(),
        nickname: opts.nickname,
      }),
    });
    if (res.status === 404 && !res.headers.get('content-type')?.includes('application/json')) {
      return localJoinRoom(opts);
    }
    if (res.status === 503) return localJoinRoom(opts);
    const data = (await res.json().catch(() => ({}))) as { room?: TronOnlineRoom; error?: string };
    if (!res.ok) return { error: data.error || 'ROOM_NOT_FOUND' };
    return { room: data.room };
  } catch {
    return localJoinRoom(opts);
  }
}

export async function fetchTronRoom(code: string, auth?: TronAuthHeaders): Promise<TronOnlineRoom | null> {
  try {
    const res = await fetch(`/api/tron-room?code=${encodeURIComponent(code)}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: buildHeaders(auth),
    });
    if ((res.status === 404 && !res.headers.get('content-type')?.includes('application/json')) || res.status === 503) {
      return localGetRoom(code, auth?.localUserId || 'local-host');
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { room: TronOnlineRoom };
    return data.room;
  } catch {
    return localGetRoom(code, auth?.localUserId || 'local-host');
  }
}

export async function startTronRoom(code: string, auth?: TronAuthHeaders): Promise<TronOnlineRoom | null> {
  try {
    const res = await fetch('/api/tron-room', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(auth),
      body: JSON.stringify({ action: 'start', code }),
    });
    if ((res.status === 404 && !res.headers.get('content-type')?.includes('application/json')) || res.status === 503) {
      return localStartRoom(code, auth?.localUserId || 'local-host');
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { room: TronOnlineRoom };
    return data.room;
  } catch {
    return localStartRoom(code, auth?.localUserId || 'local-host');
  }
}

export async function syncTronRoom(opts: {
  code: string;
  x: number;
  z: number;
  dir: number;
  alive: boolean;
  score: number;
  segments: Array<{ x1: number; z1: number; x2: number; z2: number }>;
  auth?: TronAuthHeaders;
}): Promise<TronOnlineRoom | null> {
  try {
    const res = await fetch('/api/tron-room', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(opts.auth),
      body: JSON.stringify({
        action: 'sync',
        code: opts.code,
        x: opts.x,
        z: opts.z,
        dir: opts.dir,
        alive: opts.alive,
        score: opts.score,
        segments: opts.segments,
      }),
    });
    if ((res.status === 404 && !res.headers.get('content-type')?.includes('application/json')) || res.status === 503) {
      return localSyncRoom(opts);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { room: TronOnlineRoom };
    return data.room;
  } catch {
    return localSyncRoom(opts);
  }
}

export async function fetchTronMatchHistory(auth?: TronAuthHeaders): Promise<TronMatchHistoryResponse | null> {
  try {
    const res = await fetch('/api/tron-room?history=1', {
      method: 'GET',
      credentials: 'same-origin',
      headers: buildHeaders(auth),
    });
    if ((res.status === 404 && !res.headers.get('content-type')?.includes('application/json')) || res.status === 503) {
      return localGetHistory(auth?.localUserId || 'local-host');
    }
    if (!res.ok) return null;
    return (await res.json()) as TronMatchHistoryResponse;
  } catch {
    return localGetHistory(auth?.localUserId || 'local-host');
  }
}

// ── Fallback local (para preview / testes sem Wrangler D1) ─────────────────

function readLocalRooms(): Record<string, TronOnlineRoom & { hostUserId: string }> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ROOMS_KEY) || '{}') as Record<
      string,
      TronOnlineRoom & { hostUserId: string }
    >;
  } catch {
    return {};
  }
}

function writeLocalRooms(rooms: Record<string, TronOnlineRoom & { hostUserId: string }>): void {
  try {
    localStorage.setItem(LOCAL_ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // ignore
  }
}

function localCreateRoom(opts: {
  nickname: string;
  maxPlayers: number;
  taigaProject?: string | null;
  taigaBoxName?: string | null;
  auth?: TronAuthHeaders;
}): TronOnlineRoom {
  const rooms = readLocalRooms();
  const code = String(10000 + Math.floor(Math.random() * 90000));
  const uid = opts.auth?.localUserId || 'local-host';
  const now = Date.now();
  const room: TronOnlineRoom & { hostUserId: string } = {
    code,
    hostUserId: uid,
    status: 'lobby',
    maxPlayers: Math.min(10, Math.max(2, opts.maxPlayers)),
    taigaProject: opts.taigaProject ?? null,
    taigaBoxName: opts.taigaBoxName ?? null,
    isHost: true,
    myUserId: uid,
    players: [
      {
        userId: uid,
        nickname: opts.nickname.trim().slice(0, 20) || 'Piloto',
        color: PALETTE[0]!,
        slot: 0,
        x: 0,
        z: 0,
        dir: 0,
        alive: true,
        score: 0,
        crashedAt: null,
        segments: [],
        updatedAt: now,
      },
    ],
    standings: [],
    updatedAt: now,
  };
  rooms[code] = room;
  writeLocalRooms(rooms);
  return room;
}

function localJoinRoom(opts: {
  code: string;
  nickname: string;
  auth?: TronAuthHeaders;
}): { room?: TronOnlineRoom; error?: string } {
  const rooms = readLocalRooms();
  const room = rooms[opts.code.trim()];
  if (!room) return { error: 'ROOM_NOT_FOUND' };
  const uid = opts.auth?.localUserId || 'local-guest';
  const now = Date.now();
  const existing = room.players.find((p) => p.userId === uid);
  if (existing) {
    existing.nickname = opts.nickname.trim().slice(0, 20) || existing.nickname;
  } else {
    if (room.status !== 'lobby') return { error: 'ROOM_ALREADY_STARTED' };
    if (room.players.length >= room.maxPlayers) return { error: 'ROOM_FULL' };
    const slot = room.players.length;
    room.players.push({
      userId: uid,
      nickname: opts.nickname.trim().slice(0, 20) || `Piloto ${slot + 1}`,
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
  room.updatedAt = now;
  writeLocalRooms(rooms);
  return { room: { ...room, isHost: room.hostUserId === uid, myUserId: uid } };
}

function localGetRoom(code: string, uid: string): TronOnlineRoom | null {
  const rooms = readLocalRooms();
  const room = rooms[code];
  if (!room) return null;
  return { ...room, isHost: room.hostUserId === uid, myUserId: uid };
}

function localStartRoom(code: string, uid: string): TronOnlineRoom | null {
  const rooms = readLocalRooms();
  const room = rooms[code];
  if (!room) return null;
  room.status = 'playing';
  room.updatedAt = Date.now();
  writeLocalRooms(rooms);
  return { ...room, isHost: room.hostUserId === uid, myUserId: uid };
}

function localSyncRoom(opts: {
  code: string;
  x: number;
  z: number;
  dir: number;
  alive: boolean;
  score: number;
  segments: Array<{ x1: number; z1: number; x2: number; z2: number }>;
  auth?: TronAuthHeaders;
}): TronOnlineRoom | null {
  const rooms = readLocalRooms();
  const room = rooms[opts.code];
  if (!room) return null;
  const uid = opts.auth?.localUserId || 'local-host';
  const now = Date.now();
  const me = room.players.find((p) => p.userId === uid);
  if (me && room.status === 'playing') {
    me.x = opts.x;
    me.z = opts.z;
    me.dir = opts.dir;
    me.score = opts.score;
    me.segments = opts.segments.slice(-120);
    if (!opts.alive && me.alive) {
      me.alive = false;
      me.crashedAt = now;
    }
    me.updatedAt = now;
  }
  if (room.status === 'playing' && room.players.length >= 2) {
    const aliveCount = room.players.filter((p) => p.alive).length;
    if (aliveCount <= 1) {
      room.status = 'finished';
      const sorted = [...room.players].sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        return (b.crashedAt ?? Number.MAX_SAFE_INTEGER) - (a.crashedAt ?? Number.MAX_SAFE_INTEGER);
      });
      room.standings = sorted.map((p, idx) => ({
        placement: idx + 1,
        userId: p.userId,
        nickname: p.nickname,
        color: p.color,
        alive: p.alive,
        score: p.score + (sorted.length - idx) * 200,
        isWinner: idx === 0,
      }));
    }
  }
  if (room.status === 'finished' && room.standings.length > 0) {
    localRecordHistory(room.code, uid, room.standings);
  }
  room.updatedAt = now;
  writeLocalRooms(rooms);
  return { ...room, isHost: room.hostUserId === uid, myUserId: uid };
}

function localGetHistory(uid: string): TronMatchHistoryResponse {
  try {
    const list = (JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]') as Array<TronMatchHistoryItem & { userId?: string }>)
      .filter((x) => !x.userId || x.userId === uid);
    return {
      totalMatches: list.length,
      totalWins: list.filter((x) => x.isWinner).length,
      history: list,
    };
  } catch {
    return { totalMatches: 0, totalWins: 0, history: [] };
  }
}

function localRecordHistory(roomCode: string, uid: string, standings: TronStanding[]): void {
  const mine = standings.find((s) => s.userId === uid);
  if (!mine) return;
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]') as Array<TronMatchHistoryItem & { userId?: string }>;
    const id = `${roomCode}_${uid}`;
    if (list.some((x) => x.id === id)) return;
    list.unshift({
      id,
      userId: uid,
      roomCode,
      nickname: mine.nickname,
      placement: mine.placement,
      totalPlayers: standings.length,
      score: mine.score,
      isWinner: mine.isWinner,
      playedAt: Date.now(),
    });
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(list.slice(0, 25)));
  } catch {
    // ignore
  }
}
