-- Signals for suggested Highlights (admin approves; nothing is published automatically)
ALTER TABLE photos ADD COLUMN sharp REAL;
ALTER TABLE photos ADD COLUMN exposure REAL;
ALTER TABLE photos ADD COLUMN suggest_skip INTEGER NOT NULL DEFAULT 0;

-- One row per guest per photo per action, so counts are unique people, not repeated taps
CREATE TABLE engage (
  photo_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,          -- view | download | share
  at       INTEGER NOT NULL,
  PRIMARY KEY (photo_id, user_id, kind)
);
CREATE INDEX engage_photo ON engage (photo_id);
