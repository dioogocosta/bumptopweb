import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fetchTronRanking,
  submitTronScore,
  getSavedTronNickname,
  saveTronNickname,
} from '../../src/game/tronRanking';

const store = new Map<string, string>();
const mockStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', mockStorage);
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', mockStorage);
});

describe('TRON Ranking & Nickname', () => {
  it('salva e lê nickname localmente com limite de 20 caracteres', () => {
    saveTronNickname('  Flynn_12345678901234567890  ');
    expect(getSavedTronNickname()).toBe('Flynn_12345678901234');
  });

  it('envia pontuação para /api/tron-ranking e retorna ranking atualizado', async () => {
    const payload = {
      ok: true,
      me: { userId: 'u1', nickname: 'Flynn', bestScore: 1500, maxLevel: 3 },
      ranking: [
        { rank: 1, userId: 'u1', nickname: 'Flynn', bestScore: 1500, maxLevel: 3, isMe: true },
        { rank: 2, userId: 'u2', nickname: 'Clu', bestScore: 900, maxLevel: 2, isMe: false },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const res = await submitTronScore({ nickname: 'Flynn', score: 1500, level: 3 });
    expect(res?.me?.bestScore).toBe(1500);
    expect(res?.ranking).toHaveLength(2);
    expect(getSavedTronNickname()).toBe('Flynn');
  });

  it('faz fallback local seguro quando /api/tron-ranking retorna 404 (preview)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));

    const saved = await submitTronScore({ nickname: 'TronUser', score: 750, level: 2 });
    expect(saved?.me?.bestScore).toBe(750);
    expect(saved?.me?.maxLevel).toBe(2);

    const fetched = await fetchTronRanking({ taigaName: 'TronUser' });
    expect(fetched?.ranking[0]?.nickname).toBe('TronUser');
    expect(fetched?.ranking[0]?.bestScore).toBe(750);
  });

  it('retorna null se usuário não está autorizado (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    const res = await fetchTronRanking();
    expect(res).toBeNull();
  });
});
