import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = new URL('../import-sites.mjs', import.meta.url);
const sql = "INSERT INTO sites(site_id,name,owner_id,allowed_domains,created_at) VALUES('Imported','Imported site','admin','[\"example.test\"]',123);";

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pvuv-sites-import-'));
  const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(new URL('../../shared/schema.sql', import.meta.url), 'utf8'));
    db.exec(`CREATE TABLE pvuv_kv(namespace TEXT,key TEXT,value TEXT,expires_at INTEGER);
      INSERT INTO sites(site_id,name,owner_id,allowed_domains,created_at) VALUES('Existing','Existing site','admin','[]',1);
      INSERT INTO users(user_id,email,created_at) VALUES('admin','dev@example.test',1);
      INSERT INTO pvuv_kv VALUES('site-config','site:Imported','stale',NULL);
      INSERT INTO pvuv_kv VALUES('site-config','botdir:v1','[]',NULL);`);
    const run = (input, args = ['-']) => spawnSync(process.execPath, [script.pathname, ...args], {
      input, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path },
    });
    fn({ db, dir, path, run });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('imports a path containing spaces; preserves existing data, defaults, and an online backup', () => fixture(({ db, dir, run }) => {
  const source = join(dir, 'sites export.sql');
  writeFileSync(source, sql);
  const result = run(undefined, [source]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Imported 1 site/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 2);
  assert.equal(db.prepare("SELECT owner_id FROM sites WHERE site_id='Imported'").get().owner_id, 'admin');
  assert.equal(db.prepare("SELECT timezone FROM sites WHERE site_id='Imported'").get().timezone, 'UTC');
  assert.deepEqual(db.prepare('SELECT key FROM pvuv_kv').all().map((row) => row.key), ['botdir:v1']);
  const saved = readdirSync(dir).find((name) => name.includes('.before-sites-'));
  assert.ok(saved, 'backup created');
  const backup = new DatabaseSync(join(dir, saved), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1); }
  finally { backup.close(); }
}));

test('a duplicate ID rolls back all inserts and cache changes', () => fixture(({ db, run }) => {
  const result = run(sql + sql.replaceAll('Imported', 'Existing'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNIQUE constraint/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pvuv_kv').get().n, 2);
}));

test('wrong-table SQL cannot mutate the target database', () => fixture(({ db, run }) => {
  const result = run(sql + 'DELETE FROM users;');
  assert.notEqual(result.status, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
}));

test('container-style ESM evaluation reads export SQL from stdin', () => fixture(({ db, path }) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', readFileSync(script, 'utf8'), 'import-sites.mjs', '-'], {
    input: sql, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 2);
}));

test('missing target database is refused without creating it', () => fixture(({ dir }) => {
  const path = join(dir, 'missing.sqlite');
  const result = spawnSync(process.execPath, [script.pathname, '-'], {
    input: sql, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist/);
  assert.equal(existsSync(path), false);
}));
