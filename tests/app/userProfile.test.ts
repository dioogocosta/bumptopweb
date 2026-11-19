import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeTaigaPassword, fetchTaigaMe, setTaigaToken } from '../../src/taiga/taiga';

describe('PR4.12 — Perfil de Usuário e Alteração de Senha Taiga', () => {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', mockLocalStorage);
    setTaigaToken('fake-jwt-token');
  });

  afterEach(() => {
    setTaigaToken(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetchTaigaMe extrai foto e dados do usuário autenticado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 45,
          username: 'diogo.soares',
          full_name: 'DIOGO COSTA RIBEIRO SOARES',
          email: 'diogo.soares@fnde.gov.br',
          big_photo: 'https://taiga.fnde.gov.br/media/user/photo.jpg',
        }),
      }),
    );

    const me = await fetchTaigaMe();
    expect(me).not.toBeNull();
    expect(me?.id).toBe(45);
    expect(me?.username).toBe('diogo.soares');
    expect(me?.fullName).toBe('DIOGO COSTA RIBEIRO SOARES');
    expect(me?.email).toBe('diogo.soares@fnde.gov.br');
    expect(me?.photo).toBe('https://taiga.fnde.gov.br/media/user/photo.jpg');
  });

  it('changeTaigaPassword dispara POST para /users/change_password com token e payload correto', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', mockFetch);

    const ok = await changeTaigaPassword('senhaAntiga123', 'novaSenha456');
    expect(ok).toBe(true);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/users/change_password'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-jwt-token',
        }),
        body: JSON.stringify({
          current_password: 'senhaAntiga123',
          password: 'novaSenha456',
        }),
      }),
    );
  });

  it('changeTaigaPassword falha graciosamente se a senha atual estiver incorreta (HTTP 400)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
      }),
    );

    await expect(changeTaigaPassword('senhaErrada', 'novaSenha456')).rejects.toThrow();
  });
});
