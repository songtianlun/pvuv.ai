import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
const sqlite = new DatabaseSync(workerData.path);
sqlite.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
);
parentPort!.on("message", async ({ id, operation, sql, values, path }) => {
  try {
    let result: unknown;
    if (operation === "close") {
      sqlite.close();
      result = null;
    } else if (operation === "exec") {
      sqlite.exec(sql);
      result = null;
    } else if (operation === "backup") {
      await backup(sqlite, path);
      result = null;
    } else {
      const statement = sqlite.prepare(sql);
      // SQLite's ?1 parameters are named bindings in node:sqlite. Use the
      // statement's own parameter parser, never rewrite SQL or quoted strings.
      const params = (values ?? []) as SQLInputValue[];
      const named = Object.fromEntries(
        params.map((value, index) => [String(index + 1), value]),
      );
      let numbered = false;
      // Ignore strings/comments while recognizing numbered parameters.
      const parts =
        sql.match(
          /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?\d+|./g,
        ) ?? [];
      numbered = parts.some((token: string) => /^\?\d+$/.test(token));
      const args = numbered ? [named] : params;
      if (operation === "run") {
        const r = statement.run(...(args as SQLInputValue[]));
        result = {
          changes: Number(r.changes),
          last_row_id: Number(r.lastInsertRowid),
        };
      } else {
        const results = statement.all(...(args as SQLInputValue[]));
        const meta = sqlite
          .prepare(
            "SELECT changes() AS changes,last_insert_rowid() AS last_row_id",
          )
          .get();
        result = { success: true, results, meta };
      }
    }
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
