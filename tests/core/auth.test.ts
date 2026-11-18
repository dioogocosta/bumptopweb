import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareAuth } from '../../src/auth/cloudflareAuth';
import type { SceneSnapshot } from '../../src/core/model/types';

describe('CloudflareAuth Adapter', () => {
  let auth: CloudflareAuth;

  beforeEach(() => {
    vi.restoreAllMocks();
    auth = new CloudflareAuth();
  });

  it('getSession devolve null quando a requisição falha ou não há sessão', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, user: null }),
    } as unknown as Response);

    const session = await auth.getSession();
    expect(session).toBeNull();
    expect(auth.getUser()).toBeNull();
  });

  it('getSession resolve o usuário autenticado e notifica listeners', async () => {
    const mockUser = { id: 'usr-123', email: 'teste@bumptop.com' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, user: mockUser }),
    } as unknown as Response);

    let notifiedUser = null;
    auth.onAuthStateChange((s) => {
      notifiedUser = s?.user ?? null;
    });

    const session = await auth.getSession();
    expect(session).not.toBeNull();
    expect(session?.user.email).toBe('teste@bumptop.com');
    expect(auth.getUser()?.email).toBe('teste@bumptop.com');
    expect(notifiedUser).toEqual(mockUser);
  });

  it('signIn bem-sucedido atualiza usuário e devolve ok: true', async () => {
    const mockUser = { id: 'usr-abc', email: 'usuario@bumptop.com' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, user: mockUser }),
    } as unknown as Response);

    const res = await auth.signIn('usuario@bumptop.com', 'senhaForte123');
    expect(res.ok).toBe(true);
    expect(res.user?.id).toBe('usr-abc');
    expect(auth.getUser()?.email).toBe('usuario@bumptop.com');
  });

  it('signIn com credenciais inválidas devolve ok: false com mensagem de erro', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'E-mail ou senha inválidos' }),
    } as unknown as Response);

    const res = await auth.signIn('usuario@bumptop.com', 'senhaErrada');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('E-mail ou senha inválidos');
    expect(auth.getUser()).toBeNull();
  });

  it('signUp bem-sucedido cadastra e atualiza usuário', async () => {
    const mockUser = { id: 'usr-new', email: 'novo@bumptop.com' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, user: mockUser }),
    } as unknown as Response);

    const res = await auth.signUp('novo@bumptop.com', 'senhaSegura123');
    expect(res.ok).toBe(true);
    expect(res.user?.email).toBe('novo@bumptop.com');
  });

  it('signOut limpa o usuário e notifica listeners com null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response);

    let state = 'inativo';
    auth.onAuthStateChange((s) => {
      state = s ? 'logado' : 'deslogado';
    });

    await auth.signOut();
    expect(auth.getUser()).toBeNull();
    expect(state).toBe('deslogado');
  });

  it('loadRemoteScene devolve snapshot se existente ou null se não houver', async () => {
    const mockSnapshot: SceneSnapshot = {
      schemaVersion: 1,
      objects: [],
      piles: {},
      camera: { target: { x: 0, y: 0, z: 0 }, distance: 100, azimuth: 0, elevation: 0.5, fov: 45 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, scene: mockSnapshot }),
    } as unknown as Response);

    const remote = await auth.loadRemoteScene();
    expect(remote).toEqual(mockSnapshot);
  });

  it('saveRemoteScene envia snapshot e devolve boolean de confirmação', async () => {
    const mockSnapshot: SceneSnapshot = {
      schemaVersion: 1,
      objects: [],
      piles: {},
      camera: { target: { x: 0, y: 0, z: 0 }, distance: 100, azimuth: 0, elevation: 0.5, fov: 45 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response);

    const ok = await auth.saveRemoteScene(mockSnapshot);
    expect(ok).toBe(true);
  });

  it('degradação graciosa: quando fetch falha por rede offline, não lança exceções não tratadas', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const session = await auth.getSession();
    expect(session).toBeNull();

    const signInRes = await auth.signIn('test@bumptop.com', '12345678');
    expect(signInRes.ok).toBe(false);
    expect(signInRes.error).toBe('Não foi possível conectar ao servidor');

    const scene = await auth.loadRemoteScene();
    expect(scene).toBeNull();

    const saved = await auth.saveRemoteScene({
      schemaVersion: 1,
      objects: [],
      piles: {},
      camera: { target: { x: 0, y: 0, z: 0 }, distance: 0, azimuth: 0, elevation: 0, fov: 45 },
    });
    expect(saved).toBe(false);
  });
});
