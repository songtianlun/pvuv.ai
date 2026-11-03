/** Restore D1 SQL into a NEW SQLite file. No database dialect/data conversion. */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { connect } from "./database";
import { migrate } from "./migrate";
const source = process.argv[2];
const target = process.env.SQLITE_PATH;
if (!source || !target)
  throw new Error(
    "Usage: SQLITE_PATH=/data/pvuv.sqlite node dist/server/import.mjs <d1-export.sql>",
  );
if (existsSync(target))
  throw new Error("Target already exists; restore into a NEW SQLite file");
const db = connect(target);
let success = false;
try {
  await db.exec(readFileSync(source, "utf8"));
  const recorded = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
    )
    .first();
  if (!recorded) {
    // Some D1 exports omit the internal migration ledger. Adopt ONLY a full
    // current schema; never guess which historical ALTER migrations were applied.
    const expected = new DatabaseSync(":memory:");
    expected.exec(readFileSync("shared/schema.sql", "utf8"));
    try {
      const tables = expected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[];
      for (const { name } of tables) {
        const actual = new Set(
          (await db.all<{ name: string }>(`PRAGMA table_info(${name})`)).map(
            (r) => r.name,
          ),
        );
        for (const row of expected.prepare(`PRAGMA table_info(${name})`).all())
          if (!actual.has(String(row.name)))
            throw new Error(
              `Export is missing ${name}.${row.name}; apply D1 migrations before exporting`,
            );
      }
    } finally {
      expected.close();
    }
    await db.exec(
      "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    );
    for (const name of readdirSync("migrations")
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await db.run("INSERT INTO d1_migrations(name) VALUES(?)", [name]);
  }
  await migrate(db);
  const check = await db
    .prepare("PRAGMA integrity_check")
    .first<{ integrity_check: string }>();
  if (check?.integrity_check !== "ok")
    throw new Error("SQLite integrity check failed");
  await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  success = true;
  console.log(
    "D1 export restored and integrity verified. Preserve the existing HMAC_KEY, OAuth settings and domains before switching traffic.",
  );
} finally {
  await db.close();
  if (!success)
    for (const path of [target, `${target}-wal`, `${target}-shm`])
      if (existsSync(path)) unlinkSync(path);
}
