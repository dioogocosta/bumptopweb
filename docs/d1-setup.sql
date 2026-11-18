-- =============================================================================
-- Setup do Cloudflare D1 para o BumpTop 3D Web (PR19)
-- =============================================================================
-- Como executar:
-- 1. No Cloudflare Dashboard: Workers & Pages -> D1 -> Create database ("bumptop-d1")
-- 2. Em Pages: Settings -> Functions -> D1 database bindings -> Variable name: DB -> Database: bumptop-d1
-- 3. Executar este arquivo via Wrangler:
--      wrangler d1 execute bumptop-d1 --file=docs/d1-setup.sql
--    Ou cole o conteúdo abaixo no console SQL do Cloudflare Dashboard.
-- =============================================================================

-- Tabela de Usuários
-- Senhas são protegidas com PBKDF2 (SHA-256, 100.000 iterações) e salt único de 16 bytes.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Tabela de Sessões
-- O token é gerado com 32 bytes criptograficamente aleatórios.
-- No banco, salva-se APENAS o SHA-256 do token (token_hash). O cookie HttpOnly contém o token original.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Tabela de Cenas por Usuário
-- Isolamento absoluto: cada usuário possui exatamente uma linha com o snapshot completo da sua cena 3D.
-- O front-end NUNCA envia user_id; o backend sempre resolve o user_id a partir do cookie de sessão.
CREATE TABLE IF NOT EXISTS scenes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Tabela de Rate Limiting simples (10 tentativas a cada 5 minutos por IP)
CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits(ip, action, timestamp);
