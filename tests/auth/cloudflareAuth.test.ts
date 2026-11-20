/**
 * PR27 — testes do adapter de auth (fora do core; fetch é stub global).
 * Cobre: sessão, signIn/signUp com erro genérico, indisponibilidade (modo
 * local), signOut e sync da cena por snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareAuth } from '@auth/cloudflareAuth';

function fetchJson(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('CloudflareAuth (PR27)', () => {
  it('signIn ok: guarda a sessão e dispara onChanged', async () => {
    const f = fetchJson(200, { ok: true, email: 'a@b.co' });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    const seen: Array<{ email: string } | null> = [];
    auth.onChanged((s) => seen.push(s));
    const res = await auth.signIn('a@b.co', 'senha-forte-1');
    expect(res.ok).toBe(true);
    expect(auth.current()).toEqual({ email: 'a@b.co' });
    expect(seen).toEqual([{ email: 'a@b.co' }]);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co', password: 'senha-forte-1' });
  });

  it('signIn com falha do servidor: erro genérico propagado, sem sessão', async () => {
    const f = fetchJson(400, { error: 'AUTH_FAILED' });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    const res = await auth.signIn('a@b.co', 'errada-999');
    expect(res).toEqual({ ok: false, error: 'AUTH_FAILED' });
    expect(auth.current()).toBeNull();
  });

  it('API indisponível (fetch lança): AUTH_UNAVAILABLE e app segue em modo local', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const auth = new CloudflareAuth();
    const res = await auth.signIn('a@b.co', 'senha-forte-1');
    expect(res).toEqual({ ok: false, error: 'AUTH_UNAVAILABLE' });
    expect(auth.current()).toBeNull();
  });

  it('getSession: cookie válido → sessão; cookie ausente → null', async () => {
    const f = fetchJson(200, { authenticated: true, email: 'x@y.io' });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toEqual({ email: 'x@y.io' });
    const f2 = fetchJson(200, { authenticated: false });
    vi.stubGlobal('fetch', f2);
    const auth2 = new CloudflareAuth();
    expect(await auth2.getSession()).toBeNull();
  });

  it('signOut: POST no logout e limpa a sessão local', async () => {
    const f = fetchJson(200, { ok: true });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    // "loga" direto pelo estado interno via signIn simulado
    vi.stubGlobal('fetch', fetchJson(200, { ok: true, email: 'z@w.uz' }));
    await auth.signIn('z@w.uz', 'senha-forte-1');
    vi.stubGlobal('fetch', f);
    const seen: Array<{ email: string } | null> = [];
    auth.onChanged((s) => seen.push(s));
    await auth.signOut();
    expect(seen).toEqual([null]);
    expect(auth.current()).toBeNull();
  });

  it('sync da cena: PUT leva o snapshot; GET devolve o snapshot salvo', async () => {
    const snap = { schemaVersion: 1, objects: [], camera: {}, piles: {} };
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ scene: snap }), { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    expect(await auth.putRemoteScene(snap as never)).toBe(true);
    const scene = await auth.getRemoteScene();
    expect(scene).toEqual(snap);
  });

  it('getRemoteScene com payload corrompido → null (não quebra)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"scene": {"objects": "não é array"}}', { status: 200 })));
    const auth = new CloudflareAuth();
    expect(await auth.getRemoteScene()).toBeNull();
  });

  it('API ausente (404): marca apiDown e para de chamar /api/* (modo local limpo)', async () => {
    const f = fetchJson(404, { error: 'not found' });
    vi.stubGlobal('fetch', f);
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toBeNull();
    expect(await auth.getRemoteScene()).toBeNull();
    expect(await auth.putRemoteScene({ schemaVersion: 1, objects: [], camera: {}, piles: {} } as never)).toBe(false);
    const res = await auth.signIn('a@b.co', 'senha-forte-1');
    expect(res).toEqual({ ok: false, error: 'AUTH_UNAVAILABLE' });
    // só a PRIMEIRA chamada chegou à rede; as seguintes são cortadas localmente
    expect(f).toHaveBeenCalledTimes(1);
    await auth.signOut(); // sem fetch (apiDown)
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('CloudflareAuth — sessão conhecida / muro de login (PR4.14)', () => {
  it('começa indeterminada (sem checagem não há muro)', () => {
    const auth = new CloudflareAuth();
    expect(auth.isSessionKnown()).toBe(false);
  });

  it('resposta JSON válida (200 authenticated:false) → sessão conhecida = visitante confirmado', async () => {
    vi.stubGlobal('fetch', fetchJson(200, { authenticated: false }));
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toBeNull();
    expect(auth.isSessionKnown()).toBe(true);
  });

  it('logado → sessão presente E conhecida', async () => {
    vi.stubGlobal('fetch', fetchJson(200, { authenticated: true, email: 'x@y.io' }));
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toEqual({ email: 'x@y.io' });
    expect(auth.isSessionKnown()).toBe(true);
  });

  it('404 (API ausente) → indeterminada: app segue em modo demo (fail-open)', async () => {
    vi.stubGlobal('fetch', fetchJson(404, { error: 'not found' }));
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toBeNull();
    expect(auth.isSessionKnown()).toBe(false);
  });

  it('resposta que não é JSON (SPA fallback) → indeterminada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><title>app</title>', { status: 200 })),
    );
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toBeNull();
    expect(auth.isSessionKnown()).toBe(false);
  });

  it('erro de rede → indeterminada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const auth = new CloudflareAuth();
    expect(await auth.getSession()).toBeNull();
    expect(auth.isSessionKnown()).toBe(false);
  });
});
