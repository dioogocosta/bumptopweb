-- PR27 — Schema do Cloudflare D1 (login + cena na nuvem)
--
-- O dono cria o banco no dashboard (Workers & Pages → D1 → Create) e faz o
-- bind no Pages (Settings → Functions → D1 database bindings, nome `DB`).
-- Depois pode rodar este arquivo:
--   npx wrangler d1 execute <nome-do-banco> --remote --file docs/d1-setup.sql
--
-- OBS: as Pages Functions também garantem o schema automaticamente no 1º uso
-- (CREATE TABLE IF NOT EXISTS em functions/api/_lib.ts) — rodar o SQL abaixo
-- é opcional, mas fica aqui como referência canônica.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,            -- uuid (gerado no Worker)
  email      TEXT NOT NULL UNIQUE,        -- normalizado (lowercase/trim)
  salt       TEXT NOT NULL,               -- hex 16+ bytes POR usuário
  hash       TEXT NOT NULL,               -- PBKDF2-SHA256, 150k iterações (hex)
  created_at INTEGER NOT NULL             -- epoch ms
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,            -- SHA-256 hex do token (o token NUNCA vai ao banco)
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,            -- epoch ms (30 dias)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scenes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  payload    TEXT NOT NULL,               -- snapshot da cena (formato do export JSON)
  updated_at INTEGER NOT NULL             -- epoch ms
);

-- Rate limit é best-effort em memória por isolate (functions/api/_lib.ts);
-- para um limite forte global, migrar para KV/DO depois.
