-- Wedding album schema. Phone numbers are stored only as keyed hashes (HMAC) plus last 4 digits.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  phone_hmac   TEXT NOT NULL UNIQUE,
  phone_last4  TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  side         TEXT NOT NULL DEFAULT 'groom',
  role         TEXT NOT NULL DEFAULT 'guest',      -- guest | admin
  status       TEXT NOT NULL DEFAULT 'active',     -- active | banned
  enrolled     INTEGER NOT NULL DEFAULT 0,
  liveness_mode TEXT,                              -- live | stills
  enroll_fails INTEGER NOT NULL DEFAULT 0,
  enroll_locked_until INTEGER NOT NULL DEFAULT 0,
  consent_at   INTEGER,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER
);
CREATE INDEX users_pending ON users (enrolled, created_at);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  elevated_until INTEGER NOT NULL DEFAULT 0,       -- admin passcode unlocked until
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE otp_requests (
  id          TEXT PRIMARY KEY,
  phone_hmac  TEXT NOT NULL,
  phone_enc   TEXT NOT NULL,                       -- AES-GCM encrypted number, deleted after use
  provider    TEXT NOT NULL,
  provider_ref TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'sent',        -- sent | verified | failed
  created_at  INTEGER NOT NULL
);
CREATE INDEX otp_phone ON otp_requests (phone_hmac, created_at);

CREATE TABLE rate (
  k        TEXT PRIMARY KEY,
  win      INTEGER NOT NULL,
  n        INTEGER NOT NULL
);

CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,                        -- self | family
  label      TEXT,
  sequence   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- A face "group" is one enrolled person: the guest themself or one of their family members.
CREATE TABLE face_groups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                        -- self | family
  label      TEXT,
  status     TEXT NOT NULL DEFAULT 'active',       -- active | pending | revoked
  liveness_mode TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX face_groups_user ON face_groups (user_id, status);

CREATE TABLE templates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id  TEXT NOT NULL,
  source    TEXT NOT NULL,                         -- enroll | confirmed
  q         TEXT NOT NULL,                         -- base64 int8[512]
  s         REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX templates_group ON templates (group_id);

CREATE TABLE photos (
  id          TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  source      TEXT NOT NULL,                       -- guest | photographer
  credit      TEXT,
  event       TEXT NOT NULL,
  side        TEXT NOT NULL,
  taken_at    INTEGER,
  sort_ts     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'processing',  -- processing | ready | failed
  w INTEGER, h INTEGER, bytes INTEGER,
  face_count  INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  highlight   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX photos_uploader ON photos (uploader_id, sort_ts DESC);
CREATE INDEX photos_highlight ON photos (highlight, hidden, sort_ts DESC);
CREATE INDEX photos_all ON photos (hidden, sort_ts DESC, id DESC);
CREATE INDEX photos_status ON photos (status, created_at);

CREATE TABLE faces (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id  TEXT NOT NULL,
  x REAL, y REAL, w REAL, h REAL,
  score REAL, quality REAL,
  q TEXT NOT NULL, s REAL NOT NULL
);
CREATE INDEX faces_photo ON faces (photo_id);

CREATE TABLE access (
  user_id   TEXT NOT NULL,
  photo_id  TEXT NOT NULL,
  reason    TEXT NOT NULL,                         -- upload | match | confirmed
  group_id  TEXT NOT NULL DEFAULT '',              -- '' for the uploader's own access
  score     REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, photo_id, group_id)
);
CREATE INDEX access_photo ON access (photo_id);

CREATE TABLE candidates (
  user_id   TEXT NOT NULL,
  face_id   INTEGER NOT NULL,
  photo_id  TEXT NOT NULL,
  group_id  TEXT NOT NULL,
  score     REAL NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending',       -- pending | yes | no
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, face_id)
);
CREATE INDEX candidates_status ON candidates (user_id, status);

CREATE TABLE flags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,
  user_id   TEXT,
  detail    TEXT,
  created_at INTEGER NOT NULL,
  resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id  TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES
  ('signup_cap', '1000'),
  ('family_max', '2'),
  ('family_approval', 'off'),
  ('uploads_open', '1'),
  ('upload_daily_cap', '300'),
  ('sms_daily_budget', '1500'),
  ('match_confident', '0.45'),
  ('match_possible', '0.32'),
  ('retention_date', ''),
  ('templates_version', '1');
