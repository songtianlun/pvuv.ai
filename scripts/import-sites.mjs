/** Import a D1 sites-only, --no-schema export into an initialized SQLite DB. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

const source = process.argv[2];
const target = process.env.SQLITE_PATH;

try {
  if (!source || !target) {
    throw new Error('Usage: SQLITE_PATH=<existing.sqlite> node scripts/import-sites.mjs <sites.sql|->');
  }
  if (!existsSync(target)) {
    throw new Error('Target database does not exist; initialize it with make dev first');
  }
  const sql = readFileSync(source === '-' ? 0 : source, 'utf8');
  const db = new DatabaseSync(target);
  const staged = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sites'").get();
    const kv = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pvuv_kv'").get();
    if (!schema || !kv) throw new Error('Target schema is not initialized; run make dev first');

    // Execute export SQL only against a temporary sites table. The live DB
    // receives parameterized INSERTs, never the input SQL itself.
    staged.exec(schema.sql);
    staged.exec(sql);
    const rows = staged.prepare('SELECT * FROM sites').all();
    if (!rows.length) throw new Error('The SQL export contains no sites to import');
    const columns = db.prepare('PRAGMA table_info(sites)').all().map((column) => column.name);
    const quoted = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(',');

    const saved = `${target}.before-sites-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`;
    await backup(db, saved);
    console.log(`Backup: ${saved}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare(`INSERT INTO sites (${quoted}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) insert.run(...columns.map((name) => row[name]));
      db.prepare('DELETE FROM pvuv_kv WHERE namespace=? AND key LIKE ?').run('site-config', 'site:%');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(`Imported ${rows.length} site(s). Existing site IDs are never overwritten.`);
    console.table(rows.map(({ site_id, name, owner_id }) => ({ site_id, name, owner_id })));
    if (rows.some((row) => row.owner_id !== 'admin')) {
      console.log('Note: some owner_id values are not admin; their original ownership was preserved.');
    }
  } finally {
    staged.close();
    db.close();
  }
} catch (error) {
  console.error(`Sites import failed: ${error.message}`);
  process.exitCode = 1;
}
