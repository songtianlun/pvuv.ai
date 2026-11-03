/** Restore D1 SQL into a NEW SQLite file. No database dialect/data conversion. */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { connect } from "./database";
import { migrate } from "./migrate";
import { ensureEventColumns, eventsIndexDDL } from "../shared/events";
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
      const validate = async (name: string, template = name) => {
        const actual = await db.all<{ name: string; pk: number }>(`PRAGMA table_info(${name})`);
        const names = new Set(actual.map((r) => r.name));
        const columns = expected.prepare(`PRAGMA table_info(${template})`).all();
        for (const row of columns)
          if (!names.has(String(row.name)))
            throw new Error(
              `Export is missing ${name}.${row.name}; apply D1 migrations before exporting`,
            );
        const keys = (rows: { name: unknown; pk: unknown }[]) => rows
          .filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((r) => r.name).join(",");
        if (keys(actual) !== keys(columns as { name: unknown; pk: unknown }[]))
          throw new Error(`Export has an outdated primary key on ${name}; apply D1 migrations before exporting`);
      };
      for (const { name } of tables) {
        // Retention legitimately removes the initial month (and may leave no
        // raw partitions at all). Fixed tables define the migration version.
        if (!/^events_\d{6}$/.test(name)) await validate(name);
      }
      const partitions = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'"))
        .filter(({ name }) => /^events_\d{6}$/.test(name));
      for (const { name } of partitions) {
        const suffix = name.slice(7);
        await ensureEventColumns(db.asD1(), suffix);
        await db.batch(eventsIndexDDL(suffix).map((sql) => db.prepare(sql)));
        await validate(name, "events_202607");
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
