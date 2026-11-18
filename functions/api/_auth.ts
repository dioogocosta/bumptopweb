import type { D1Database, UserRow } from './_types';

export function bufferToHex(buf: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Calcula o SHA-256 de uma string em formato hexadecimal */
export async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return bufferToHex(new Uint8Array(hash));
}

/** Gera hash PBKDF2 (SHA-256, 100.000 iterações, 256 bits) */
export async function hashPassword(password: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  const saltBytes = saltHex ? hexToBuffer(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const salt = saltHex || bufferToHex(saltBytes);

  const enc = new TextEncoder().encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hash = bufferToHex(new Uint8Array(derived));
  return { salt, hash };
}

/** Verificação de senha em tempo constante */
export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

/** Cria nova sessão no D1 (token aleatório de 32 bytes; no banco salva SHA-256 do token) */
export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ token: string; expiresAt: number }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bufferToHex(tokenBytes);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 dias

  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run();

  return { token, expiresAt };
}

/** Extrai o token de sessão do cookie da requisição */
export function getSessionTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const [k, ...v] = c.trim().split('=');
    if (k === 'session') {
      return decodeURIComponent(v.join('='));
    }
  }
  return null;
}

/** Resolve o usuário logado a partir do cookie de sessão (retorna null se inválido/expirado) */
export async function getSessionUser(
  db: D1Database,
  request: Request
): Promise<{ id: string; email: string } | null> {
  const token = getSessionTokenFromRequest(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  try {
    const row = await db
      .prepare(
        'SELECT u.id, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?'
      )
      .bind(tokenHash, now)
      .first<Pick<UserRow, 'id' | 'email'>>();

    if (!row) return null;
    return { id: row.id, email: row.email };
  } catch (e) {
    console.error('Erro ao buscar sessão no D1:', e);
    return null;
  }
}

/** Monta cabeçalho Set-Cookie com atributos de segurança */
export function buildSessionCookie(token: string, maxAgeSeconds: number = 30 * 24 * 3600): string {
  return `session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Monta cabeçalho Set-Cookie para expirar/remover a sessão */
export function buildClearSessionCookie(): string {
  return `session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Rate limiting simples por IP (máximo 10 requisições por 5 minutos) */
export async function checkRateLimit(
  db: D1Database,
  ip: string,
  action: string,
  maxAttempts: number = 10,
  windowMs: number = 5 * 60 * 1000
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    // Limpeza oportunista de registros antigos
    await db
      .prepare('DELETE FROM rate_limits WHERE timestamp < ?')
      .bind(windowStart)
      .run();

    const countRow = await db
      .prepare('SELECT COUNT(*) as total FROM rate_limits WHERE ip = ? AND action = ? AND timestamp >= ?')
      .bind(ip, action, windowStart)
      .first<{ total: number }>();

    const total = countRow?.total ?? 0;
    if (total >= maxAttempts) {
      return false;
    }

    await db
      .prepare('INSERT INTO rate_limits (ip, action, timestamp) VALUES (?, ?, ?)')
      .bind(ip, action, now)
      .run();

    return true;
  } catch (e) {
    // Se tabela não existir ainda ou D1 falhar, degrada graciosamente permitindo a requisição
    console.warn('Rate limit ignorado por indisponibilidade:', e);
    return true;
  }
}

export function jsonResponse(data: unknown, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
