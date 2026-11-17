/**
 * PR27 — Adapter de auth/nuvem (FORA do core): fala com as Pages Functions
 * same-origin (`/api/*`). Implementa a porta `IAuthPort` + sincronização da
 * cena por snapshot (GET/PUT `/api/scene`, formato igual ao export JSON).
 * Sem a API (ex.: D1 não configurado), tudo falha graciosamente → modo local.
 */
import type { AuthSession, IAuthPort } from '@core/ports/index';
import type { SceneSnapshot } from '@core/model/types';

type AuthResult = { ok: boolean; error?: string };

export class CloudflareAuth implements IAuthPort {
  private session: AuthSession | null = null;
  private cbs: Array<(s: AuthSession | null) => void> = [];
  /**
   * PR27 — API ausente (ex.: vite preview/Netlify sem as Pages Functions,
   * rota 404): marca `apiDown` e para de chamar /api/* — degradação limpa,
   * sem requisições nem ruído de console repetidos. O app segue 100%
   * funcional em modo local. Em produção com D1 bindado NUNCA dá 404.
   */
  private apiDown = false;

  private markApiDown(): void {
    this.apiDown = true;
  }

  async getSession(): Promise<AuthSession | null> {
    if (this.apiDown) return null;
    try {
      const r = await fetch('/api/session', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (r.status === 404) {
        this.markApiDown();
        return null;
      }
      if (!r.ok) {
        this.session = null;
        return null;
      }
      const j = (await r.json().catch(() => null)) as { authenticated?: boolean; email?: string } | null;
      this.session = j?.authenticated && j.email ? { email: j.email } : null;
      return this.session;
    } catch {
      this.session = null;
      return null;
    }
  }

  onChanged(cb: (s: AuthSession | null) => void): void {
    this.cbs.push(cb);
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    return this.post('/api/signup', email, password);
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    return this.post('/api/login', email, password);
  }

  async signOut(): Promise<void> {
    if (!this.apiDown) {
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      } catch {
        // mesmo sem a API, o estado local vai para deslogado
      }
    }
    this.session = null;
    this.emit();
  }

  /**
   * Snapshot da cena na conta do usuário (resolvido pelo COOKIE no servidor).
   * null = nunca subiu nada / indisponível.
   */
  async getRemoteScene(): Promise<SceneSnapshot | null> {
    if (this.apiDown) return null;
    try {
      const r = await fetch('/api/scene', { credentials: 'same-origin' });
      if (r.status === 404) {
        this.markApiDown();
        return null;
      }
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { scene?: SceneSnapshot | null } | null;
      return j?.scene && Array.isArray(j.scene.objects) ? j.scene : null;
    } catch {
      return null;
    }
  }

  /** Envia o snapshot (debounce no chamador). false = falhou (segue modo local). */
  async putRemoteScene(snapshot: SceneSnapshot): Promise<boolean> {
    if (this.apiDown) return false;
    try {
      const r = await fetch('/api/scene', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (r.status === 404) {
        this.markApiDown();
        return false;
      }
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Estado corrente (sem ida ao servidor) — p/ o sync decidir se envia. */
  current(): AuthSession | null {
    return this.session;
  }

  private async post(url: string, email: string, password: string): Promise<AuthResult> {
    if (this.apiDown) return { ok: false, error: 'AUTH_UNAVAILABLE' };
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; email?: string; error?: string } | null;
      if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? 'AUTH_UNAVAILABLE' };
      this.session = { email: j.email ?? email };
      this.emit();
      return { ok: true };
    } catch {
      return { ok: false, error: 'AUTH_UNAVAILABLE' };
    }
  }

  private emit(): void {
    for (const cb of this.cbs) cb(this.session);
  }
}
