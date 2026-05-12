-- Uptime monitor schema. Idempotent: safe to run repeatedly.
-- Tables are created with IF NOT EXISTS so the app applies this on every boot.

CREATE TABLE IF NOT EXISTS sites (
  id                       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name                     VARCHAR(120) NOT NULL,
  url                      VARCHAR(2048) NOT NULL,
  monitor_type             VARCHAR(32) NOT NULL DEFAULT 'active',
  method                   VARCHAR(10) NOT NULL DEFAULT 'GET',
  interval_seconds         INT UNSIGNED NOT NULL DEFAULT 60,
  timeout_ms               INT UNSIGNED NOT NULL DEFAULT 10000,
  check_type               VARCHAR(32) NULL DEFAULT 'status',
  expected_status          VARCHAR(120) NULL DEFAULT '200',
  expected_string          TEXT NULL,
  json_path                VARCHAR(255) NULL,
  expected_json_value      VARCHAR(512) NULL,
  request_headers          JSON NULL,
  failure_threshold        INT UNSIGNED NOT NULL DEFAULT 1,
  heartbeat_token          VARCHAR(64) NULL,
  heartbeat_grace_seconds  INT UNSIGNED NOT NULL DEFAULT 60,
  last_heartbeat_at        DATETIME(3) NULL,
  cloudflare_mode          TINYINT(1) NOT NULL DEFAULT 0,
  paused                   TINYINT(1) NOT NULL DEFAULT 0,
  current_state            ENUM('up','down','unknown') NOT NULL DEFAULT 'unknown',
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_heartbeat_token (heartbeat_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS checks (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_id           INT UNSIGNED NOT NULL,
  checked_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_up             TINYINT(1) NULL,
  status_code       INT NULL,
  response_time_ms  INT UNSIGNED NULL,
  error_message     TEXT NULL,
  KEY idx_checks_site_time (site_id, checked_at),
  CONSTRAINT fk_checks_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incidents (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_id           INT UNSIGNED NOT NULL,
  started_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at          DATETIME(3) NULL,
  duration_seconds  INT UNSIGNED NULL,
  last_error        TEXT NULL,
  KEY idx_incidents_site_started (site_id, started_at),
  CONSTRAINT fk_incidents_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  id                  TINYINT UNSIGNED NOT NULL DEFAULT 1 PRIMARY KEY,
  smtp_host           VARCHAR(255) NULL,
  smtp_port           INT UNSIGNED NOT NULL DEFAULT 587,
  smtp_secure         TINYINT(1) NOT NULL DEFAULT 0,
  smtp_user           VARCHAR(255) NULL,
  smtp_pass           VARCHAR(512) NULL,
  smtp_from_address   VARCHAR(255) NULL,
  smtp_from_name      VARCHAR(120) NOT NULL DEFAULT 'Uptime',
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS channels (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  type        VARCHAR(32) NOT NULL,
  enabled     TINYINT(1) NOT NULL DEFAULT 1,
  config      JSON NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_channels_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_channels (
  site_id     INT UNSIGNED NOT NULL,
  channel_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (site_id, channel_id),
  KEY idx_sc_channel (channel_id),
  CONSTRAINT fk_sc_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT fk_sc_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
