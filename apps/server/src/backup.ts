import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const DAY_MS = 24 * 3600 * 1000;
const KEEP = 7;

/** Copies the database to `dir` now and then once a day, keeping the newest KEEP copies. Returns a stop function. */
export function startDailyBackup(sqlite: Database.Database, dir: string, log: { info(o: object, m: string): void; error(o: object, m: string): void }) {
  mkdirSync(dir, { recursive: true });

  const run = async () => {
    const file = path.join(dir, `orchestrator-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    try {
      await sqlite.backup(file); // consistent snapshot, safe while the db is in use (WAL)
      const old = readdirSync(dir).filter((f) => /^orchestrator-.*\.sqlite$/.test(f)).sort().slice(0, -KEEP);
      for (const f of old) rmSync(path.join(dir, f));
      log.info({ file, removed: old.length }, 'database backup written');
    } catch (err) {
      log.error({ err }, 'database backup failed');
    }
  };

  void run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
