/**
 * PR27 — Helpers compartilhados das Pages Functions de auth/cena.
 *
 * SEGURANÇA (spec rígida — não desviar):
 * - Senha: PBKDF2-SHA256 via WebCrypto do Worker, 150.000 iterações,
 *   salt aleatório de 16 bytes POR usuário. A senha nunca é armazenada.
 * - Sessão: token aleatório de 32 bytes; o browser recebe o token em cookie
 *   HttpOnly + Secure + SameSite=Strict (30 dias); no banco vai SÓ o SHA-256
 *   do token (vazamento do DB não vira sessão válida).
 * - user_id SEMPRE resolvido do cookie no servidor; o front nunca manda.
 * - Erro genérico em login/signup ("E-mail ou senha inválidos") — não revela
 *   se a conta existe ou se a senha está errada.
 *
 * Este arquivo começa com `_` → o roteador do Pages não cria rota para ele.
 */

// --- Tipos mínimos do D1 (o repo não depende de @cloudflare/workers-types) ---
export interface D1LikeResult {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
}
export interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1LikeResult>;
}
export interface D1Like {
  prepare(query: string): D1LikeStatement;
}

export interface EnvLike {
  DB?: D1Like;
}

export type FnCtx<E> = {
  request: Request;
  env: E;
  /** Vem do runtime do Pages; em dev/wrangler pode faltar. */
  waitUntil?: (p: Promise<unknown>) => void;
};

// ---------------------------------------------------------------------------
// Respostas JSON + cookie
// ---------------------------------------------------------------------------

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export const COOKIE_NAME = 'bt_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function cookieToken(request: Request): string | null {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema (garantia no 1º uso — o docs/d1-setup.sql é a referência canônica)
// ---------------------------------------------------------------------------

let schemaReady = false;
export async function ensureSchema(db: D1Like): Promise<void> {
  if (schemaReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS scenes (
      user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  ).run();
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Criptografia (WebCrypto do Worker)
// ---------------------------------------------------------------------------

const PBKDF2_ITER = 150_000;

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function makeHash(password: string): Promise<{ salt: string; hash: string }> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pbkdf2(password, salt) };
}

export async function verifyHash(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const test = await pbkdf2(password, saltHex);
  return constEqHex(test, hashHex);
}

/** Comparação em tempo constante p/ hex strings. */
function constEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Token de sessão: 32 bytes aleatórios → base64url. */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const s = btoa(String.fromCharCode(...b));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(bits));
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

export interface SessionUser {
  userId: string;
  email: string;
}

/** Resolve o user a partir do COOKIE (nunca do corpo). Apaga sessão expirada. */
export async function getSessionUser(db: D1Like, request: Request): Promise<SessionUser | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.user_id AS uid, u.email AS email, s.expires_at AS exp
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ uid: string; email: string; exp: number }>();
  if (!row) return null;
  if (row.exp < Date.now()) {
    await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }
  return { userId: row.uid, email: row.email };
}

/** Cria a sessão (grava SÓ o hash do token) e devolve o cookie Set-Cookie. */
export async function createSession(
  db: D1Like,
  userId: string,
): Promise<{ token: string; cookie: string }> {
  const token = newToken();
  const now = Date.now();
  await db
    .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256Hex(token), userId, now + SESSION_MS, now)
    .run();
  // Higiene: sessões expiradas do usuário fora
  await db
    .prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at < ?`)
    .bind(userId, now)
    .run();
  return { token, cookie: sessionCookie(token) };
}

export async function destroySession(db: D1Like, request: Request): Promise<void> {
  const token = cookieToken(request);
  if (!token) return;
  await db
    .prepare(`DELETE FROM sessions WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .run();
}

// ---------------------------------------------------------------------------
// Rate limit simples (best-effort: memória por isolate; spec aceita)
// ---------------------------------------------------------------------------

const attempts = new Map<string, { n: number; windowStart: number }>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function rateLimit(ip: string, bucket: string): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const e = attempts.get(key);
  if (!e || now - e.windowStart > WINDOW_MS) {
    attempts.set(key, { n: 1, windowStart: now });
    return true;
  }
  e.n += 1;
  return e.n <= MAX_ATTEMPTS;
}

export function rateLimitSweep(): void {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.windowStart > WINDOW_MS) attempts.delete(k);
}

// ---------------------------------------------------------------------------
// Utilidades de request
// ---------------------------------------------------------------------------

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'local'
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}
export function validPassword(pw: unknown): pw is string {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 256;
}

/** Códigos de erro estáveis que o front traduz no i18n. */
export type AuthErr = 'AUTH_BAD_EMAIL' | 'AUTH_BAD_PASSWORD' | 'AUTH_FAILED' | 'AUTH_RATE' | 'AUTH_REQUIRED';
