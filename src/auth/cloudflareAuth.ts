import type { AuthSession, AuthUser, IAuthPort } from '../core/ports';
import type { SceneSnapshot } from '../core/model/types';

const AUTH_KEY = 'bumptop_auth';

export class CloudflareAuth implements IAuthPort {
  private user: AuthUser | null = null;
  private listeners = new Set<(session: AuthSession | null) => void>();

  constructor(private baseUrl: string = '') {}

  private notify(session: AuthSession | null): void {
    for (const fn of this.listeners) {
      try {
        fn(session);
      } catch (err) {
        console.warn('Erro em listener de auth:', err);
      }
    }
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getUser(): AuthUser | null {
    return this.user;
  }

  async getSession(): Promise<AuthSession | null> {
    try {
      // Se não há indicador de sessão salva localmente, não faz probe desnecessário (evita 404 no console em modo local)
      if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_KEY) !== '1') {
        this.user = null;
        return null;
      }

      const res = await fetch(`${this.baseUrl}/api/auth/me`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_KEY);
        this.user = null;
        return null;
      }
      const data = await res.json();
      if (data && data.ok && data.user) {
        this.user = { id: data.user.id, email: data.user.email };
        if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_KEY, '1');
        const session: AuthSession = { user: this.user };
        this.notify(session);
        return session;
      }
      if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_KEY);
      this.user = null;
      this.notify(null);
      return null;
    } catch {
      // Degradação graciosa quando a API não estiver disponível ou offline
      this.user = null;
      return null;
    }
  }

  async signIn(
    email: string,
    password: string
  ): Promise<{ ok: boolean; error?: string; user?: AuthUser }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/signin`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        return {
          ok: false,
          error: data?.error || 'E-mail ou senha inválidos',
        };
      }

      this.user = { id: data.user.id, email: data.user.email };
      if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_KEY, '1');
      this.notify({ user: this.user });
      return { ok: true, user: this.user };
    } catch (err) {
      console.warn('Falha na requisição de signin:', err);
      return {
        ok: false,
        error: 'Não foi possível conectar ao servidor',
      };
    }
  }

  async signUp(
    email: string,
    password: string
  ): Promise<{ ok: boolean; error?: string; user?: AuthUser }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/signup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        return {
          ok: false,
          error: data?.error || 'E-mail ou senha inválidos',
        };
      }

      this.user = { id: data.user.id, email: data.user.email };
      if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_KEY, '1');
      this.notify({ user: this.user });
      return { ok: true, user: this.user };
    } catch (err) {
      console.warn('Falha na requisição de signup:', err);
      return {
        ok: false,
        error: 'Não foi possível conectar ao servidor',
      };
    }
  }

  async signOut(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/auth/signout`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      console.warn('Falha na requisição de signout:', err);
    } finally {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_KEY);
      this.user = null;
      this.notify(null);
    }
  }

  async loadRemoteScene(): Promise<SceneSnapshot | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/scene`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data?.ok && data.scene && Array.isArray(data.scene.objects)) {
        return data.scene as SceneSnapshot;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveRemoteScene(snapshot: SceneSnapshot): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/scene`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ scene: snapshot }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return !!data?.ok;
    } catch {
      return false;
    }
  }
}
