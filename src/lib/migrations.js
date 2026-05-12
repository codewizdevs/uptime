'use strict';

// Idempotent column additions for both SQLite and MySQL.
// Run by server.js after ensureSchema(). Each entry is applied only if the
// column is missing; safe to re-run on every boot.

const db = require('../db');
const logger = require('../logger');

async function columnExists(table, column) {
  if (db.dialect === 'sqlite') {
    const rows = await db.query(`PRAGMA table_info(${table})`);
    return rows.some((r) => String(r.name).toLowerCase() === column.toLowerCase());
  }
  const rows = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(name) {
  if (db.dialect === 'sqlite') {
    const rows = await db.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`,
      [name]
    );
    return rows.length > 0;
  }
  const rows = await db.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND index_name = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function addColumn(table, column, sqliteDef, mysqlDef) {
  if (await columnExists(table, column)) return false;
  const def = db.dialect === 'sqlite' ? sqliteDef : mysqlDef;
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  logger.info({ table, column, dialect: db.dialect }, 'migrations.column_added');
  return true;
}

async function addIndex(name, table, cols) {
  if (await indexExists(name)) return false;
  await db.query(`CREATE INDEX ${name} ON ${table} (${cols.join(',')})`);
  logger.info({ index: name, table, cols, dialect: db.dialect }, 'migrations.index_added');
  return true;
}

async function ensureTable(name, sqliteDdl, mysqlDdl) {
  const ddl = db.dialect === 'sqlite' ? sqliteDdl : mysqlDdl;
  await db.query(ddl);
}

// Columns that are part of the legacy schema but no longer used by the app.
// They get pruned out of the table on the next rebuild.
const DEPRECATED_SITES_COLUMNS = new Set(['discord_webhook']);

// The original schema pinned `sites.monitor_type` and `sites.check_type` to
// a fixed set via SQLite CHECK / MySQL ENUM. As new types are added (cert
// in Phase 3, tcp/ping/dns/regex in Phase 4), those constraints must be
// loosened to plain text. We keep app-layer validation in routes/sites.js.
async function relaxSitesTypeConstraints() {
  if (db.dialect === 'sqlite') {
    // Inspect the current table DDL — only rebuild if it still has a CHECK,
    // or if a deprecated column is still hanging around.
    const tblRow = await db.query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='sites'`
    );
    if (!tblRow.length) return false;
    const existingDdl = String(tblRow[0].sql || '');
    const hasMonitorCheck = /CHECK\s*\(\s*monitor_type\b/i.test(existingDdl);
    const hasCheckCheck   = /CHECK\s*\([^)]*check_type\b/i.test(existingDdl);

    const colInfo = await db.query(`PRAGMA table_info(sites)`);
    const hasDeprecated = colInfo.some((c) => DEPRECATED_SITES_COLUMNS.has(c.name));
    if (!hasMonitorCheck && !hasCheckCheck && !hasDeprecated) return false;

    logger.info('migrations.rebuilding_sites_table');

    // Build a fresh CREATE TABLE deterministically from PRAGMA. We preserve
    // every non-deprecated column, drop CHECK constraints by virtue of not
    // re-emitting them, and re-create indexes/triggers explicitly.
    const keptCols = colInfo.filter((c) => !DEPRECATED_SITES_COLUMNS.has(c.name));
    const colDefs = keptCols.map((c) => {
      const isPk = !!c.pk;
      const isInteger = String(c.type).toUpperCase() === 'INTEGER';
      if (isPk && isInteger) {
        return `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
      }
      let def = `${c.name} ${c.type || 'TEXT'}`;
      if (c.notnull) def += ' NOT NULL';
      if (c.dflt_value != null) {
        // SQLite requires non-literal default expressions to be parenthesised.
        // Literals (numbers, quoted strings) come back without parens; calls
        // (strftime(…), CURRENT_TIMESTAMP, etc.) do too, so we wrap when the
        // raw text isn't already a self-contained literal.
        const raw = String(c.dflt_value);
        const isQuotedString = /^'.*'$/.test(raw) || /^".*"$/.test(raw);
        const isNumber = /^-?\d+(?:\.\d+)?$/.test(raw);
        const isAlreadyWrapped = /^\(.*\)$/.test(raw);
        const isBareConstant = /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(raw);
        const needsWrap = !isQuotedString && !isNumber && !isAlreadyWrapped && !isBareConstant;
        def += ` DEFAULT ${needsWrap ? `(${raw})` : raw}`;
      }
      return def;
    });
    const colList = keptCols.map((c) => c.name).join(', ');
    const newDdl = `CREATE TABLE sites__new (\n  ${colDefs.join(',\n  ')}\n)`;

    db.raw.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      ${newDdl};
      INSERT INTO sites__new (${colList}) SELECT ${colList} FROM sites;
      DROP TABLE sites;
      ALTER TABLE sites__new RENAME TO sites;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_sites_heartbeat_token
        ON sites (heartbeat_token) WHERE heartbeat_token IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trg_sites_updated_at
        AFTER UPDATE ON sites FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE sites SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    return true;
  }
  // MySQL — ALTER COLUMN type from ENUM to VARCHAR (keeps existing values).
  const rows = await db.query(
    `SELECT column_name, column_type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'sites'
        AND column_name IN ('monitor_type','check_type')`
  );
  let changed = false;
  for (const r of rows) {
    const name = r.column_name || r.COLUMN_NAME;
    const ct = String(r.column_type || r.COLUMN_TYPE || '').toLowerCase();
    if (!ct.startsWith('enum(')) continue;
    const newType = name === 'check_type'
      ? 'VARCHAR(32) NULL DEFAULT \'status\''
      : 'VARCHAR(32) NOT NULL DEFAULT \'active\'';
    await db.query(`ALTER TABLE sites MODIFY COLUMN ${name} ${newType}`);
    changed = true;
  }
  // Drop deprecated discord_webhook column if present on MySQL too.
  const depRows = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'sites' AND column_name = 'discord_webhook' LIMIT 1`
  );
  if (depRows.length) {
    await db.query(`ALTER TABLE sites DROP COLUMN discord_webhook`);
    changed = true;
  }
  if (changed) logger.info('migrations.altered_sites_table');
  return changed;
}

// Old installs created channels.type as a CHECK / ENUM pinned to
// (discord, webhook, email). Phase 2 introduces 7 new channel types, so the
// constraint has to be lifted to plain text.
async function relaxChannelTypeConstraint() {
  if (db.dialect === 'sqlite') {
    const rows = await db.query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'`
    );
    if (!rows.length) return false;
    const ddl = String(rows[0].sql || '');
    if (!/CHECK\s*\(\s*type\s+IN/i.test(ddl)) return false;
    logger.info('migrations.rebuilding_channels_table_to_drop_check_constraint');
    db.raw.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      CREATE TABLE channels__new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        config      TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO channels__new (id, name, type, enabled, config, created_at, updated_at)
        SELECT id, name, type, enabled, config, created_at, updated_at FROM channels;
      DROP TABLE channels;
      ALTER TABLE channels__new RENAME TO channels;
      CREATE INDEX IF NOT EXISTS idx_channels_type ON channels (type);
      CREATE TRIGGER IF NOT EXISTS trg_channels_updated_at
        AFTER UPDATE ON channels FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE channels SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
      END;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    return true;
  }
  // MySQL — drop the ENUM in favour of VARCHAR(32).
  const rows = await db.query(
    `SELECT column_type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'channels' AND column_name = 'type' LIMIT 1`
  );
  const ct = String(rows[0]?.column_type || rows[0]?.COLUMN_TYPE || '').toLowerCase();
  if (!ct.startsWith('enum(')) return false;
  logger.info('migrations.alter_channels_type_enum_to_varchar');
  await db.query(`ALTER TABLE channels MODIFY COLUMN type VARCHAR(32) NOT NULL`);
  return true;
}

async function run() {
  // Drop legacy type constraints before adding columns so subsequent
  // INSERTs with new monitor_type / check_type values can succeed.
  await relaxSitesTypeConstraints();

  // Phase 1 — public status page
  await addColumn('sites', 'display_name',
    'TEXT NULL',
    'VARCHAR(255) NULL');
  await addColumn('sites', 'status_page_group',
    'TEXT NULL',
    'VARCHAR(120) NULL');
  await addColumn('sites', 'status_page_excluded',
    'INTEGER NOT NULL DEFAULT 0',
    'TINYINT NOT NULL DEFAULT 0');
  await addColumn('sites', 'status_page_order',
    'INTEGER NOT NULL DEFAULT 0',
    'INT NOT NULL DEFAULT 0');

  await addColumn('settings', 'status_page_enabled',
    'INTEGER NOT NULL DEFAULT 1',
    'TINYINT NOT NULL DEFAULT 1');
  await addColumn('settings', 'status_page_public',
    'INTEGER NOT NULL DEFAULT 1',
    'TINYINT NOT NULL DEFAULT 1');
  await addColumn('settings', 'status_page_token',
    'TEXT NULL',
    'VARCHAR(80) NULL');
  await addColumn('settings', 'status_page_title',
    'TEXT NULL',
    'VARCHAR(255) NULL');
  await addColumn('settings', 'status_page_description',
    'TEXT NULL',
    'TEXT NULL');

  await addIndex('idx_sites_status_group', 'sites', ['status_page_group', 'status_page_order']);
  await addIndex('idx_sites_excluded', 'sites', ['status_page_excluded']);

  // Phase 2 — relax channels.type so the new channel types can be inserted.
  await relaxChannelTypeConstraint();

  // Phase 3 — SSL/TLS cert visibility + cert-expiry alerts.
  await addColumn('sites', 'last_cert_subject',           'TEXT NULL', 'VARCHAR(255) NULL');
  await addColumn('sites', 'last_cert_issuer',            'TEXT NULL', 'VARCHAR(255) NULL');
  await addColumn('sites', 'last_cert_valid_to',          'TEXT NULL', 'DATETIME(3) NULL');
  await addColumn('sites', 'last_cert_days_remaining',    'INTEGER NULL', 'INT NULL');
  await addColumn('sites', 'last_cert_checked_at',        'TEXT NULL', 'DATETIME(3) NULL');
  await addColumn('sites', 'cert_expiry_warn_days',       'INTEGER NOT NULL DEFAULT 14', 'INT NOT NULL DEFAULT 14');
  await addColumn('sites', 'cert_expiry_alerted_at',      'TEXT NULL', 'DATETIME(3) NULL');
  await addColumn('sites', 'cert_expiry_alerted_at_days', 'INTEGER NULL', 'INT NULL');
  // Used by the cert monitor type to know which host/port to inspect when
  // the URL alone isn't enough (e.g. SMTPS on 465, IMAPS on 993).
  await addColumn('sites', 'cert_host',                   'TEXT NULL', 'VARCHAR(255) NULL');
  await addColumn('sites', 'cert_port',                   'INTEGER NULL', 'INT NULL');

  // Phase 4 — TCP / Ping (ICMP) / DNS monitor types.
  await addColumn('sites', 'tcp_host',        'TEXT NULL',    'VARCHAR(255) NULL');
  await addColumn('sites', 'tcp_port',        'INTEGER NULL', 'INT NULL');
  await addColumn('sites', 'ping_host',       'TEXT NULL',    'VARCHAR(255) NULL');
  await addColumn('sites', 'ping_count',      'INTEGER NOT NULL DEFAULT 1', 'INT NOT NULL DEFAULT 1');
  await addColumn('sites', 'dns_query',       'TEXT NULL',    'VARCHAR(255) NULL');
  await addColumn('sites', 'dns_record_type', 'TEXT NULL',    'VARCHAR(16) NULL');
  await addColumn('sites', 'dns_resolver',    'TEXT NULL',    'VARCHAR(255) NULL');
  await addColumn('sites', 'dns_expected',    'TEXT NULL',    'TEXT NULL');

  // Phase 5 — maintenance windows.
  await ensureTable(
    'maintenance_windows',
    `CREATE TABLE IF NOT EXISTS maintenance_windows (
       id                      INTEGER PRIMARY KEY AUTOINCREMENT,
       name                    TEXT    NOT NULL,
       enabled                 INTEGER NOT NULL DEFAULT 1,
       scope                   TEXT    NOT NULL DEFAULT 'global',
       scope_value             TEXT    NULL,
       kind                    TEXT    NOT NULL DEFAULT 'oneoff',
       starts_at               TEXT    NULL,
       ends_at                 TEXT    NULL,
       cron                    TEXT    NULL,
       duration_minutes        INTEGER NULL,
       timezone                TEXT    NULL DEFAULT 'UTC',
       suppress_notifications  INTEGER NOT NULL DEFAULT 1,
       pause_probes            INTEGER NOT NULL DEFAULT 0,
       created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS maintenance_windows (
       id                      INT AUTO_INCREMENT PRIMARY KEY,
       name                    VARCHAR(160) NOT NULL,
       enabled                 TINYINT NOT NULL DEFAULT 1,
       scope                   VARCHAR(16) NOT NULL DEFAULT 'global',
       scope_value             VARCHAR(64) NULL,
       kind                    VARCHAR(16) NOT NULL DEFAULT 'oneoff',
       starts_at               DATETIME(3) NULL,
       ends_at                 DATETIME(3) NULL,
       cron                    VARCHAR(160) NULL,
       duration_minutes        INT NULL,
       timezone                VARCHAR(64) NULL DEFAULT 'UTC',
       suppress_notifications  TINYINT NOT NULL DEFAULT 1,
       pause_probes            TINYINT NOT NULL DEFAULT 0,
       created_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       KEY idx_mw_scope (scope, scope_value),
       KEY idx_mw_enabled (enabled)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_mw_scope', 'maintenance_windows', ['scope', 'scope_value']);
  await addIndex('idx_mw_enabled', 'maintenance_windows', ['enabled']);

  await addColumn('incidents', 'during_maintenance',
    'INTEGER NOT NULL DEFAULT 0',
    'TINYINT NOT NULL DEFAULT 0');

  // Phase 6 — tags / groups / bulk actions.
  await ensureTable(
    'tags',
    `CREATE TABLE IF NOT EXISTS tags (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       name        TEXT    NOT NULL,
       color       TEXT    NOT NULL DEFAULT 'secondary',
       created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS tags (
       id          INT AUTO_INCREMENT PRIMARY KEY,
       name        VARCHAR(64)  NOT NULL,
       color       VARCHAR(32)  NOT NULL DEFAULT 'secondary',
       created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       UNIQUE KEY uniq_tags_name (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // SQLite needs the unique index added separately so the migration is idempotent
  // (`CREATE TABLE IF NOT EXISTS` without the constraint wouldn't add it later).
  if (db.dialect === 'sqlite') {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_tags_name ON tags (name)`);
  }

  await ensureTable(
    'site_tags',
    `CREATE TABLE IF NOT EXISTS site_tags (
       site_id  INTEGER NOT NULL,
       tag_id   INTEGER NOT NULL,
       PRIMARY KEY (site_id, tag_id)
     )`,
    `CREATE TABLE IF NOT EXISTS site_tags (
       site_id  INT NOT NULL,
       tag_id   INT NOT NULL,
       PRIMARY KEY (site_id, tag_id),
       KEY idx_st_tag (tag_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_site_tags_tag', 'site_tags', ['tag_id']);

  // Phase 7 — Improved heartbeat (cron schedule, start/success/exit signals).
  await addColumn('sites', 'heartbeat_schedule_kind',
    "TEXT NOT NULL DEFAULT 'interval'",
    "VARCHAR(16) NOT NULL DEFAULT 'interval'");
  await addColumn('sites', 'heartbeat_cron',         'TEXT NULL',    'VARCHAR(160) NULL');
  await addColumn('sites', 'heartbeat_timezone',     'TEXT NULL',    'VARCHAR(64) NULL');
  await addColumn('sites', 'last_heartbeat_start_at','TEXT NULL',    'DATETIME(3) NULL');
  await addColumn('sites', 'last_heartbeat_kind',    'TEXT NULL',    'VARCHAR(16) NULL');
  await addColumn('sites', 'last_heartbeat_exit_code','INTEGER NULL','INT NULL');
  await addColumn('sites', 'last_heartbeat_duration_ms','INTEGER NULL','INT NULL');
  await addColumn('sites', 'last_heartbeat_body',    'TEXT NULL',    'TEXT NULL');

  await ensureTable(
    'heartbeat_pings',
    `CREATE TABLE IF NOT EXISTS heartbeat_pings (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       site_id      INTEGER NOT NULL,
       kind         TEXT    NOT NULL DEFAULT 'success',
       exit_code    INTEGER NULL,
       duration_ms  INTEGER NULL,
       body         TEXT    NULL,
       source_ip    TEXT    NULL,
       user_agent   TEXT    NULL,
       received_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS heartbeat_pings (
       id           INT AUTO_INCREMENT PRIMARY KEY,
       site_id      INT NOT NULL,
       kind         VARCHAR(16) NOT NULL DEFAULT 'success',
       exit_code    INT NULL,
       duration_ms  INT NULL,
       body         TEXT NULL,
       source_ip    VARCHAR(64) NULL,
       user_agent   VARCHAR(255) NULL,
       received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       KEY idx_hb_site_received (site_id, received_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_hb_site_received', 'heartbeat_pings', ['site_id', 'received_at']);

  // Phase 8 — API tokens.
  await ensureTable(
    'api_tokens',
    `CREATE TABLE IF NOT EXISTS api_tokens (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       name         TEXT    NOT NULL,
       token_hash   TEXT    NOT NULL,
       scope        TEXT    NOT NULL DEFAULT 'read',
       last_used_at TEXT    NULL,
       created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS api_tokens (
       id           INT AUTO_INCREMENT PRIMARY KEY,
       name         VARCHAR(160) NOT NULL,
       token_hash   VARCHAR(128) NOT NULL,
       scope        VARCHAR(16)  NOT NULL DEFAULT 'read',
       last_used_at DATETIME(3)  NULL,
       created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       UNIQUE KEY uniq_api_token_hash (token_hash)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  if (db.dialect === 'sqlite') {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_api_token_hash ON api_tokens (token_hash)`);
  }

  // Phase 9 — Audit log + 2FA storage.
  await ensureTable(
    'audit_log',
    `CREATE TABLE IF NOT EXISTS audit_log (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       actor        TEXT    NULL,
       ip           TEXT    NULL,
       action       TEXT    NOT NULL,
       target_type  TEXT    NULL,
       target_id    TEXT    NULL,
       meta         TEXT    NULL
     )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
       id           INT AUTO_INCREMENT PRIMARY KEY,
       at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       actor        VARCHAR(64) NULL,
       ip           VARCHAR(64) NULL,
       action       VARCHAR(64) NOT NULL,
       target_type  VARCHAR(32) NULL,
       target_id    VARCHAR(32) NULL,
       meta         TEXT NULL,
       KEY idx_audit_at (at),
       KEY idx_audit_action (action)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_audit_at', 'audit_log', ['at']);
  await addIndex('idx_audit_action', 'audit_log', ['action']);

  await addColumn('settings', 'totp_secret',
    'TEXT NULL', 'VARCHAR(64) NULL');
  await addColumn('settings', 'totp_enabled',
    'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
  await addColumn('settings', 'totp_recovery_codes',
    'TEXT NULL', 'TEXT NULL');

  // Phase 10 — Per-monitor probe options.
  await addColumn('sites', 'request_body',         'TEXT NULL',                      'TEXT NULL');
  await addColumn('sites', 'request_body_type',    "TEXT NOT NULL DEFAULT 'text'",   "VARCHAR(16) NOT NULL DEFAULT 'text'");
  await addColumn('sites', 'auth_type',            "TEXT NOT NULL DEFAULT 'none'",   "VARCHAR(16) NOT NULL DEFAULT 'none'");
  await addColumn('sites', 'auth_username',        'TEXT NULL',                      'VARCHAR(255) NULL');
  await addColumn('sites', 'auth_password',        'TEXT NULL',                      'VARCHAR(255) NULL');
  await addColumn('sites', 'auth_token',           'TEXT NULL',                      'VARCHAR(1024) NULL');
  await addColumn('sites', 'follow_redirects',     'INTEGER NOT NULL DEFAULT 1',     'TINYINT NOT NULL DEFAULT 1');
  await addColumn('sites', 'skip_tls_verify',      'INTEGER NOT NULL DEFAULT 0',     'TINYINT NOT NULL DEFAULT 0');
  await addColumn('sites', 'max_response_time_ms', 'INTEGER NULL',                   'INT NULL');

  // Phase 11 — Data hygiene / retention / notes / mute / failure snapshots.
  await addColumn('sites', 'notes',              'TEXT NULL',                  'TEXT NULL');
  await addColumn('sites', 'mute_notifications', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT NOT NULL DEFAULT 0');
  await addColumn('incidents', 'failure_snapshot','TEXT NULL',                 'TEXT NULL');

  // Phase 14 — Multi-user with per-monitor ACLs.
  // The env super-admin stays as a permanent break-glass account and is NEVER
  // stored in this table. Reserved username (== `config.admin.user`) cannot
  // be created as a DB user (enforced in src/lib/users.js).
  await ensureTable(
    'users',
    `CREATE TABLE IF NOT EXISTS users (
       id                      INTEGER PRIMARY KEY AUTOINCREMENT,
       username                TEXT    NOT NULL UNIQUE,
       password_hash           TEXT    NOT NULL,
       role                    TEXT    NOT NULL DEFAULT 'viewer',
       email                   TEXT    NULL,
       display_name            TEXT    NULL,
       totp_secret             TEXT    NULL,
       totp_enabled            INTEGER NOT NULL DEFAULT 0,
       totp_recovery_codes     TEXT    NULL,
       disabled                INTEGER NOT NULL DEFAULT 0,
       must_change_password    INTEGER NOT NULL DEFAULT 0,
       last_login_at           TEXT    NULL,
       last_login_ip           TEXT    NULL,
       password_changed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       created_by_user_id      INTEGER NULL
     )`,
    `CREATE TABLE IF NOT EXISTS users (
       id                      INT AUTO_INCREMENT PRIMARY KEY,
       username                VARCHAR(64) NOT NULL UNIQUE,
       password_hash           VARCHAR(255) NOT NULL,
       role                    VARCHAR(16) NOT NULL DEFAULT 'viewer',
       email                   VARCHAR(255) NULL,
       display_name            VARCHAR(120) NULL,
       totp_secret             VARCHAR(64) NULL,
       totp_enabled            TINYINT NOT NULL DEFAULT 0,
       totp_recovery_codes     TEXT NULL,
       disabled                TINYINT NOT NULL DEFAULT 0,
       must_change_password    TINYINT NOT NULL DEFAULT 0,
       last_login_at           DATETIME(3) NULL,
       last_login_ip           VARCHAR(64) NULL,
       password_changed_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       created_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       created_by_user_id      INT NULL,
       KEY idx_users_role (role),
       KEY idx_users_disabled (disabled)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_users_role', 'users', ['role']);
  await addIndex('idx_users_disabled', 'users', ['disabled']);

  // Per-monitor ACL grants. NULL owner_user_id means "legacy/env-admin-owned"
  // — only admins (env or DB) see it until an owner is explicitly assigned.
  await addColumn('sites', 'owner_user_id', 'INTEGER NULL', 'INT NULL');
  await addIndex('idx_sites_owner', 'sites', ['owner_user_id']);

  await ensureTable(
    'site_grants',
    `CREATE TABLE IF NOT EXISTS site_grants (
       site_id              INTEGER NOT NULL,
       user_id              INTEGER NOT NULL,
       permission           TEXT    NOT NULL DEFAULT 'view',
       granted_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       granted_by_user_id   INTEGER NULL,
       PRIMARY KEY (site_id, user_id)
     )`,
    `CREATE TABLE IF NOT EXISTS site_grants (
       site_id              INT NOT NULL,
       user_id              INT NOT NULL,
       permission           VARCHAR(16) NOT NULL DEFAULT 'view',
       granted_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       granted_by_user_id   INT NULL,
       PRIMARY KEY (site_id, user_id),
       KEY idx_grants_user (user_id),
       KEY idx_grants_site (site_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addIndex('idx_grants_user', 'site_grants', ['user_id']);
  await addIndex('idx_grants_site', 'site_grants', ['site_id']);

  // Tie audit log + api tokens + channels to acting user (NULL == env admin).
  await addColumn('audit_log', 'actor_user_id', 'INTEGER NULL', 'INT NULL');
  await addIndex('idx_audit_actor_user', 'audit_log', ['actor_user_id']);
  await addColumn('api_tokens', 'user_id', 'INTEGER NULL', 'INT NULL');
  await addIndex('idx_api_tokens_user', 'api_tokens', ['user_id']);
  await addColumn('channels', 'created_by_user_id', 'INTEGER NULL', 'INT NULL');

  // Phase 13 — Move whitelabel/branding from .env into the database so it
  // can be edited from /settings/branding without redeploying.
  // All columns are nullable; null means "fall back to env / built-in default".
  await addColumn('settings', 'brand_app_name',        'TEXT NULL', 'VARCHAR(120) NULL');
  await addColumn('settings', 'brand_tagline',         'TEXT NULL', 'VARCHAR(255) NULL');
  await addColumn('settings', 'brand_credits_hide',    'INTEGER NULL', 'TINYINT NULL');
  await addColumn('settings', 'brand_credits_lead',    'TEXT NULL', 'VARCHAR(120) NULL');
  await addColumn('settings', 'brand_credits_text',    'TEXT NULL', 'VARCHAR(120) NULL');
  await addColumn('settings', 'brand_credits_url',     'TEXT NULL', 'VARCHAR(512) NULL');

  // Binary uploads (logo / favicon). Stored inline rather than on disk so
  // backup/import is a single JSON file and there are no FS perms to worry
  // about. One row per `kind` ("logo" | "favicon"). updated_at drives the
  // ETag/cache-bust for /branding/logo and /branding/favicon.
  await ensureTable(
    'branding_assets',
    `CREATE TABLE IF NOT EXISTS branding_assets (
       kind        TEXT    NOT NULL PRIMARY KEY,
       mime        TEXT    NOT NULL,
       filename    TEXT    NULL,
       bytes       BLOB    NOT NULL,
       updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS branding_assets (
       kind        VARCHAR(16) NOT NULL PRIMARY KEY,
       mime        VARCHAR(64) NOT NULL,
       filename    VARCHAR(255) NULL,
       bytes       LONGBLOB NOT NULL,
       updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  logger.info('migrations.complete');
}

module.exports = { run, addColumn, addIndex, ensureTable, columnExists, indexExists };
