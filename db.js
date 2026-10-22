import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname);
export const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  last_login TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  region TEXT
);

CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id INTEGER NOT NULL REFERENCES areas(id),
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  property_type TEXT NOT NULL,
  tiers TEXT NOT NULL,
  base_fee REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  effective_from TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_no TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  owner_name TEXT,
  relation TEXT,
  id_type TEXT,
  id_no TEXT,
  phone TEXT,
  phone_alt TEXT,
  area_id INTEGER REFERENCES areas(id),
  community_id INTEGER REFERENCES communities(id),
  building TEXT,
  unit TEXT,
  room TEXT,
  address TEXT,
  property_type TEXT NOT NULL DEFAULT '居民',
  tariff_id INTEGER REFERENCES tariffs(id),
  contract_capacity REAL,
  status TEXT NOT NULL DEFAULT 'active',
  open_date TEXT NOT NULL,
  close_date TEXT,
  payment_method TEXT,
  auto_debit INTEGER NOT NULL DEFAULT 0,
  credit_level TEXT,
  tags TEXT,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_area ON accounts(area_id);

CREATE TABLE IF NOT EXISTS metering_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  point_no TEXT UNIQUE NOT NULL,
  name TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_account ON metering_points(account_id);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT UNIQUE NOT NULL,
  serial_no TEXT,
  model TEXT,
  vendor TEXT,
  protocol TEXT,
  imei TEXT,
  sim_no TEXT,
  module_no TEXT,
  ratio REAL NOT NULL DEFAULT 1,
  accuracy TEXT,
  phase TEXT,
  voltage TEXT,
  firmware TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',
  manufacture_date TEXT,
  installed_at TEXT,
  removed_at TEXT,
  last_seen_at TEXT,
  offline_since TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL REFERENCES metering_points(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  seq INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  start_reading REAL NOT NULL DEFAULT 0,
  end_date TEXT,
  end_reading REAL,
  end_reading_source TEXT,
  end_reading_quality TEXT,
  ratio REAL NOT NULL DEFAULT 1,
  reason TEXT,
  work_order_no TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_point ON segments(point_id);

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL REFERENCES metering_points(id),
  segment_id INTEGER NOT NULL REFERENCES segments(id),
  device_id INTEGER REFERENCES devices(id),
  read_at TEXT NOT NULL,
  reading REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'iot_push',
  quality TEXT NOT NULL DEFAULT 'valid',
  superseded_by INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_point_time ON readings(point_id, read_at);

CREATE TABLE IF NOT EXISTS replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  point_id INTEGER NOT NULL REFERENCES metering_points(id),
  old_segment_id INTEGER,
  new_segment_id INTEGER,
  old_device_id INTEGER,
  new_device_id INTEGER,
  solution TEXT NOT NULL DEFAULT 'replace_meter',
  reason TEXT NOT NULL,
  fault_type TEXT,
  symptom TEXT,
  reported_at TEXT,
  planned_at TEXT,
  done_at TEXT,
  old_final_reading REAL,
  old_final_source TEXT,
  new_start_reading REAL,
  status TEXT NOT NULL DEFAULT 'reported',
  operator TEXT,
  reviewer TEXT,
  reviewed_at TEXT,
  photos TEXT,
  remark TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repl_status ON replacements(status);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT UNIQUE NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  period TEXT NOT NULL,
  usage_kwh REAL NOT NULL DEFAULT 0,
  energy_fee REAL NOT NULL DEFAULT 0,
  base_fee REAL NOT NULL DEFAULT 0,
  adjustment REAL NOT NULL DEFAULT 0,
  other_fee REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued',
  due_date TEXT,
  issued_at TEXT,
  paid_at TEXT,
  calc_detail TEXT,
  remark TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_acct_period ON bills(account_id, period);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  bill_id INTEGER REFERENCES bills(id),
  period TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  usage_kwh REAL NOT NULL DEFAULT 0,
  reason TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_bill_id INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_no TEXT UNIQUE NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  gateway_txn TEXT,
  idempotency_key TEXT UNIQUE,
  payer_name TEXT,
  paid_at TEXT,
  remark TEXT,
  raw TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS period_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT UNIQUE NOT NULL,
  ran_at TEXT NOT NULL,
  accounts_cnt INTEGER,
  kwh REAL,
  amount REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

db.exec(SCHEMA);

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export function setting(key, def = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : def;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}
