-- Freeband hub schema v2: health data from the band's activity files.
-- Additive only: `samples` keeps live/battery; the new types get their own
-- tables. Every row carries account_id and device_id; every query filters by
-- account_id. Times are unix epoch milliseconds (UTC).
--
-- minute, sleep and score are upserts keyed by (account_id, device_id, ts):
-- the last write wins (docs/API.md).

-- One row per non-empty minute (`type: "minute"`).
CREATE TABLE minutes (
  account_id      TEXT    NOT NULL,
  device_id       TEXT    NOT NULL,
  ts              INTEGER NOT NULL,              -- start of the minute (multiple of 60 000)
  steps           INTEGER NOT NULL,
  heart_rate      INTEGER,                       -- bpm, 30–220
  spo2            INTEGER,                       -- %, 70–100
  stress          INTEGER,                       -- 1–100
  active_calories INTEGER,                       -- kcal
  distance_m      INTEGER,                       -- metres
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, ts),
  FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX minutes_account_ts ON minutes (account_id, ts);

-- One row per sleep session (`type: "sleep"`), keyed by bed time.
CREATE TABLE sleeps (
  account_id  TEXT    NOT NULL,
  device_id   TEXT    NOT NULL,
  ts          INTEGER NOT NULL,                  -- bed time
  end_ts      INTEGER NOT NULL,                  -- wake time; the night belongs to this local day
  is_nap      INTEGER NOT NULL CHECK (is_nap IN (0, 1)),
  deep_min    INTEGER NOT NULL,
  light_min   INTEGER NOT NULL,
  rem_min     INTEGER NOT NULL,
  awake_min   INTEGER NOT NULL,
  wake_count  INTEGER NOT NULL,
  efficiency  INTEGER NOT NULL,                  -- %, 0–100
  stages      TEXT    NOT NULL,                  -- JSON [[offset_min, stage, dur_min], ...]
  hr_min      INTEGER,
  spo2_avg    REAL,
  spo2_min    INTEGER,
  hrv_rmssd   REAL,                              -- ms
  received_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, ts),
  FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX sleeps_account_end ON sleeps (account_id, end_ts);

-- One row per local day (`type: "score"`); ts is that day's local midnight.
CREATE TABLE scores (
  account_id     TEXT    NOT NULL,
  device_id      TEXT    NOT NULL,
  ts             INTEGER NOT NULL,               -- local midnight of `date` as a UTC instant
  date           TEXT    NOT NULL,               -- YYYY-MM-DD in the phone's time zone
  sleep_score    INTEGER,
  recovery_score INTEGER,
  strain_score   REAL,                           -- 0–21
  rhr            INTEGER,
  hrv_rmssd      REAL,
  conf_sleep     TEXT    NOT NULL CHECK (conf_sleep IN ('high', 'medium', 'low', 'none')),
  conf_recovery  TEXT    NOT NULL CHECK (conf_recovery IN ('high', 'medium', 'low', 'none')),
  conf_strain    TEXT    NOT NULL CHECK (conf_strain IN ('high', 'medium', 'low', 'none')),
  contributors   TEXT    NOT NULL,               -- JSON array
  algo           TEXT    NOT NULL,
  received_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id, ts),
  FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX scores_account_date ON scores (account_id, date);
CREATE INDEX scores_account_ts ON scores (account_id, ts);
