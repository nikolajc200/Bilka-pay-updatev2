CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  hashed_sync_code CHAR(64) NOT NULL UNIQUE,
  plan_data JSONB NOT NULL,
  client_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plans_updated_at_idx ON plans (updated_at DESC);

-- Plans used to be keyed by a shared sync code; they now belong to an account.
-- Written as a migration so an existing deployment upgrades in place.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE plans ALTER COLUMN hashed_sync_code DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS plans_user_id_key ON plans (user_id);

-- Personal UKG/Kronos calendar feed. Treat as a secret: the URL alone grants
-- read access to that person's whole work schedule.
ALTER TABLE users ADD COLUMN IF NOT EXISTS schedule_url TEXT;

-- Discord webhook plus the bookkeeping that stops the nightly job repeating
-- itself after a restart. Dates are stored in the user's own timezone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_webhook TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS schedule_synced_on DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_sent_on DATE;

-- Links a Discord account to this one so /sync knows whose roster to fetch.
-- The code is single-use and short-lived; the id is what persists.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_link_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_link_expires TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_discord_user_id_key
  ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;
