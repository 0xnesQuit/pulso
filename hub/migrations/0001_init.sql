-- OpenBand hub schema v1.
-- Every row that holds user data carries account_id; every query filters by it.
-- Times are unix epoch milliseconds (UTC).

CREATE TABLE accounts (
  id               TEXT    PRIMARY KEY,           -- random UUID
  token_hash       TEXT    NOT NULL UNIQUE,       -- hex SHA-256 of the bearer token; the token itself is never stored
  tz               TEXT    NOT NULL,              -- IANA time zone used for daily summaries
  name             TEXT    NOT NULL,              -- device_name given at sign-up
  created_at       INTEGER NOT NULL,
  token_rotated_at INTEGER
) STRICT;

CREATE TABLE devices (
  account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id          TEXT    NOT NULL,                   -- app-generated UUID (uppercase)
  name        TEXT    NOT NULL,
  model       TEXT    NOT NULL CHECK (model IN ('band10', 'band10pro')),
  app_version TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE samples (
  account_id     TEXT    NOT NULL,
  device_id      TEXT    NOT NULL,
  type           TEXT    NOT NULL CHECK (type IN ('live', 'battery')),
  ts             INTEGER NOT NULL,
  steps          INTEGER,
  calories       INTEGER,
  heart_rate     INTEGER,
  standing_hours INTEGER,
  level          INTEGER,
  received_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, type, ts),
  FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX samples_account_ts ON samples (account_id, ts);

CREATE TABLE webhooks (
  id               TEXT    PRIMARY KEY,           -- random UUID
  account_id       TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url              TEXT    NOT NULL,
  secret_enc       TEXT    NOT NULL,              -- AES-GCM ciphertext; plaintext is returned once at creation only
  created_at       INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_status      INTEGER,                       -- HTTP status of the last delivery, 0 = network error/timeout
  last_error       TEXT,
  UNIQUE (account_id, url)
) STRICT;

CREATE INDEX webhooks_account ON webhooks (account_id);

CREATE TABLE sessions (
  id_hash    TEXT    PRIMARY KEY,                 -- hex SHA-256 of the cookie value
  account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_account ON sessions (account_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Fixed-window counters. key = "<scope>:<subject>:<window seconds>".
-- Subjects are keyed HMACs of IPs or account ids, never raw IPs.
CREATE TABLE rate_limits (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,                  -- unix seconds
  count        INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
