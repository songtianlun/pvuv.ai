import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Database } from "./database";
export async function migrate(db: Database) {
  await db.transaction(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
   CREATE TABLE IF NOT EXISTS pvuv_migration_checksums(name TEXT PRIMARY KEY,checksum TEXT NOT NULL);`);
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const prior = await db
        .prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(name)
        .first();
      if (prior) {
        const verified = await db
          .prepare("SELECT checksum FROM pvuv_migration_checksums WHERE name=?")
          .bind(name)
          .first<{ checksum: string }>();
        if (verified && verified.checksum !== hash)
          throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      await db.exec(sql);
      await db
        .prepare("INSERT INTO d1_migrations(name) VALUES(?)")
        .bind(name)
        .run();
      await db
        .prepare(
          "INSERT INTO pvuv_migration_checksums(name,checksum) VALUES(?,?)",
        )
        .bind(name, hash)
        .run();
    }
    await db.exec(`CREATE TABLE IF NOT EXISTS pvuv_kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER,PRIMARY KEY(namespace,key));
   CREATE INDEX IF NOT EXISTS pvuv_kv_expiry ON pvuv_kv(expires_at);
   CREATE TABLE IF NOT EXISTS pvuv_queue(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,dead_at INTEGER,last_error TEXT);
   CREATE INDEX IF NOT EXISTS pvuv_queue_ready ON pvuv_queue(dead_at,available_at,id);
   CREATE TABLE IF NOT EXISTS pvuv_jobs(name TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
  `);
    // D1 exports contain canonical directory/block evidence but no KV dump.
    const directory = await db
      .prepare("SELECT value FROM instance_settings WHERE key='bot_directory'")
      .first<{ value: string }>();
    if (directory)
      await db
        .prepare(
          "INSERT OR IGNORE INTO pvuv_kv(namespace,key,value) VALUES('site-config','botdir:v1',?)",
        )
        .bind(directory.value)
        .run();
    const clusters = await db
      .prepare(
        "SELECT * FROM cluster_flags WHERE action='block' AND expires_at>?",
      )
      .bind(Date.now())
      .all<Record<string, any>>();
    for (const c of clusters.results) {
      const e = JSON.parse(c.evidence);
      const key = e.fp ? `bl:fp:${e.fp}` : e.ip24 ? `bl:ip24:${e.ip24}` : null;
      if (key)
        await db
          .prepare(
            "INSERT OR IGNORE INTO pvuv_kv(namespace,key,value,expires_at) VALUES('blocklist',?,?,?)",
          )
          .bind(
            key,
            JSON.stringify({
              cluster: c.cluster_id,
              members: c.member_count,
              at: c.created_at,
            }),
            c.expires_at,
          )
          .run();
    }
  });
}
