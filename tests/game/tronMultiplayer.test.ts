import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TronEngine } from '../../src/game/tronEngine';
import {
  buildWhatsAppShareUrl,
  createTronRoom,
  fetchTronMatchHistory,
  joinTronRoom,
  startTronRoom,
  syncTronRoom,
} from '../../src/game/tronMultiplayer';

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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
});

describe('TRON Multiplayer Online (5 a 10 jogadores, código 5 dígitos, WhatsApp & Histórico)', () => {
  it('TronEngine suporta 10 jogadores online simultâneos sem sobreposição de spawn', () => {
    const roster = Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      color: (['blue', 'red', 'yellow', 'orange', 'green', 'purple', 'cyan', 'pink', 'lime', 'white'] as const)[i]!,
      slot: i,
      isLocal: i === 0,
    }));
    const engine = new TronEngine({
      halfSize: 120,
      mode: 'online',
      playerColor: 'blue',
      onlineRoster: roster,
    });
    expect(engine.cycles).toHaveLength(10);
    // Avança 10 frames sem colisões imediatas no spawn
    for (let i = 0; i < 10; i++) engine.step(0.05);
    expect(engine.cycles.every((c) => c.alive)).toBe(true);
  });

  it('cria sala com código de 5 dígitos, permite entrar, jogar, gerar ranking por sobrevivência e registrar histórico', async () => {
    const room = await createTronRoom({
      nickname: 'HostFlynn',
      maxPlayers: 5,
      auth: { localUserId: 'u1' },
    });
    expect(room).not.toBeNull();
    expect(room!.code).toMatch(/^\d{5}$/);
    expect(room!.taigaProject).toBeNull();

    const joined = await joinTronRoom({
      code: room!.code,
      nickname: 'GuestClu',
      auth: { localUserId: 'u2' },
    });
    expect(joined.room?.players).toHaveLength(2);

    const started = await startTronRoom(room!.code, { localUserId: 'u1' });
    expect(started?.status).toBe('playing');

    // Guest bate primeiro -> Host vence por sobrevivência
    await syncTronRoom({
      code: room!.code,
      x: 10,
      z: 10,
      dir: 0,
      alive: false,
      score: 120,
      segments: [],
      auth: { localUserId: 'u2' },
    });

    const finished = await syncTronRoom({
      code: room!.code,
      x: 20,
      z: 20,
      dir: 1,
      alive: true,
      score: 480,
      segments: [],
      auth: { localUserId: 'u1' },
    });

    expect(finished?.status).toBe('finished');
    expect(finished?.standings[0]?.nickname).toBe('HostFlynn');
    expect(finished?.standings[0]?.isWinner).toBe(true);
    expect(finished?.standings[1]?.nickname).toBe('GuestClu');

    const waUrl = buildWhatsAppShareUrl(room!.code, finished!.standings);
    expect(waUrl).toContain('https://wa.me/?text=');
    expect(decodeURIComponent(waUrl)).toContain('HostFlynn');
    expect(decodeURIComponent(waUrl)).toContain(room!.code);

    const hist = await fetchTronMatchHistory({ localUserId: 'u1' });
    expect(hist?.totalMatches).toBe(1);
    expect(hist?.totalWins).toBe(1);
    expect(hist?.history[0]?.placement).toBe(1);
  });
});
