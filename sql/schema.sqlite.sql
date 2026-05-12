-- Uptime monitor schema (SQLite variant). Idempotent.
-- Timestamps are stored as ISO 8601 with millisecond precision: '%Y-%m-%dT%H:%M:%fZ'
-- so they're directly parseable by JavaScript's Date and lex-sortable in SQL.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

CREATE TABLE IF NOT EXISTS sites (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT    NOT NULL,
  url                      TEXT    NOT NULL,
  monitor_type             TEXT    NOT NULL DEFAULT 'active',
  method                   TEXT    NOT NULL DEFAULT 'GET',
  interval_seconds         INTEGER NOT NULL DEFAULT 60,
  timeout_ms               INTEGER NOT NULL DEFAULT 10000,
  check_type               TEXT    NULL DEFAULT 'status',
  expected_status          TEXT    NULL DEFAULT '200',
  expected_string          TEXT    NULL,
  json_path                TEXT    NULL,
  expected_json_value      TEXT    NULL,
  request_headers          TEXT    NULL,
  failure_threshold        INTEGER NOT NULL DEFAULT 1,
  heartbeat_token          TEXT    NULL,
  heartbeat_grace_seconds  INTEGER NOT NULL DEFAULT 60,
  last_heartbeat_at        TEXT    NULL,
  cloudflare_mode          INTEGER NOT NULL DEFAULT 0,
  paused                   INTEGER NOT NULL DEFAULT 0,
  current_state            TEXT    NOT NULL DEFAULT 'unknown' CHECK (current_state IN ('up','down','unknown')),
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sites_heartbeat_token
  ON sites (heartbeat_token) WHERE heartbeat_token IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_sites_updated_at
  AFTER UPDATE ON sites FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE sites SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id           INTEGER NOT NULL,
  checked_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_up             INTEGER NULL,
  status_code       INTEGER NULL,
  response_time_ms  INTEGER NULL,
  error_message     TEXT    NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checks_site_time ON checks (site_id, checked_at);

CREATE TABLE IF NOT EXISTS incidents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id           INTEGER NOT NULL,
  started_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at          TEXT    NULL,
  duration_seconds  INTEGER NULL,
  last_error        TEXT    NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_incidents_site_started ON incidents (site_id, started_at);

CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host           TEXT    NULL,
  smtp_port           INTEGER NOT NULL DEFAULT 587,
  smtp_secure         INTEGER NOT NULL DEFAULT 0,
  smtp_user           TEXT    NULL,
  smtp_pass           TEXT    NULL,
  smtp_from_address   TEXT    NULL,
  smtp_from_name      TEXT    NOT NULL DEFAULT 'Uptime',
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TRIGGER IF NOT EXISTS trg_settings_updated_at
  AFTER UPDATE ON settings FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_type ON channels (type);

CREATE TRIGGER IF NOT EXISTS trg_channels_updated_at
  AFTER UPDATE ON channels FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE channels SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS site_channels (
  site_id     INTEGER NOT NULL,
  channel_id  INTEGER NOT NULL,
  PRIMARY KEY (site_id, channel_id),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sc_channel ON site_channels (channel_id);
