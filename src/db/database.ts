import { Database } from "bun:sqlite";
import { readdirSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Db extends Database {}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  seedDefaults(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      (r) => r.version,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // SQLite DDL is transactional; run each migration atomically.
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(sqlText);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw new Error(`Migration ${file} failed: ${err}`);
    }
    log.info("migration applied", { version: file });
  }
}

const DEFAULT_SETTINGS: Record<string, string> = {
  card_number: "",
  cardholder_name: "",
  currency: "تومان",
  report_enabled: "1",
  report_time: "07:30",
  report_send_empty: "0",
  report_recipients: "[]",
  last_report_status: "",
  last_report_error: "",
  // Channel membership enforcement — OFF by default so a fresh install (or an
  // install that never configures a channel) never blocks customers.
  channel_membership_enabled: "0",
  channel_membership_channel: "",
  channel_membership_message: "",
};

function seedDefaults(db: Db): void {
  const insert = db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
    // Default business hours: Sat–Thu 08:00–18:00 active, Fri closed (Persian week).
    const count = (db.query("SELECT COUNT(*) AS c FROM business_hours").get() as { c: number }).c;
    if (count === 0) {
      const ins = db.query(
        "INSERT INTO business_hours (weekday, open_time, close_time, active) VALUES (?, ?, ?, ?)",
      );
      // JS weekday: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
      // Active Sun–Thu (0-4) and Sat (6); closed Fri (5).
      for (let wd = 0; wd <= 6; wd++) {
        const active = wd === 5 ? 0 : 1;
        ins.run(wd, "08:00", "18:00", active);
      }
    }
  })();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Run fn inside an IMMEDIATE transaction (write lock up-front). */
export function tx<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped.immediate() as T;
}
