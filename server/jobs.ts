import consumer from "../workers/consumer/src/index";
import cron from "../workers/cron/src/index";
import type { Database } from "./database";
import { SQLiteKV } from "./bindings";
export async function consume(db: Database): Promise<number> {
  return db.transaction(async () => {
    const rows = await db.all<{ id: number; body: string }>(
      "SELECT id,body FROM pvuv_queue WHERE dead_at IS NULL AND available_at<=? ORDER BY id LIMIT 50",
      [Date.now()],
    );
    if (!rows.length) return 0;
    let ack = false;
    const batch = {
      messages: rows.map((r) => ({
        id: String(r.id),
        body: JSON.parse(r.body),
      })),
      ackAll() {
        ack = true;
      },
      retryAll() {
        ack = false;
      },
    };
    try {
      await db.transaction(async () => {
        await consumer.queue(batch as unknown as MessageBatch<unknown>, {
          DB: db.asD1(),
          ENSURE_SCHEMA_EACH_BATCH: true,
        });
        if (!ack) throw new Error("Consumer requested retry");
      });
    } catch (error) {
      console.error("queue delivery failed", error);
      ack = false;
    }
    for (const row of rows) {
      if (ack) await db.run("DELETE FROM pvuv_queue WHERE id=?", [row.id]);
      else
        await db.run(
          "UPDATE pvuv_queue SET attempts=attempts+1,available_at=?,dead_at=CASE WHEN attempts>=3 THEN ? END,last_error='Consumer requested retry; see logs' WHERE id=?",
          [Date.now() + 30000, Date.now(), row.id],
        );
    }
    return rows.length;
  });
}
export async function scheduled(db: Database, now = new Date()) {
  // Do not advance analysis watermarks past accepted but unconsumed work,
  // including delayed retries. The consumer continues independently.
  if (await db.prepare("SELECT 1 FROM pvuv_queue WHERE dead_at IS NULL LIMIT 1").first())
    return false;
  const env = {
    DB: db.asD1(),
    BLOCKLIST: new SQLiteKV(db, "blocklist").asKV(),
    // Ingest accepts timestamps up to ten minutes in the past. Work arriving
    // after the queue check must remain newer than this analysis boundary.
    batchEnd: Date.now() - 15 * 60_000,
    runInTransaction: (work: () => Promise<void>) => db.transaction(work),
  };
  for (const [name, expression, due] of [
    [
      "hourly",
      "5 * * * *",
      new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          now.getUTCHours(),
          5,
        ),
      ),
    ],
    [
      "daily",
      "30 3 * * *",
      new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          3,
          30,
        ),
      ),
    ],
  ] as const) {
    if (due > now)
      due.setTime(due.getTime() - (name === "hourly" ? 3600e3 : 86400e3));
    const last = await db
      .prepare("SELECT last_run FROM pvuv_jobs WHERE name=?")
      .bind(name)
      .first<{ last_run: number }>();
    if (last && last.last_run >= due.getTime()) continue;
    const pending: Promise<unknown>[] = [];
    await cron.scheduled(
      { cron: expression } as ScheduledController,
      env,
      {
        waitUntil(p: Promise<unknown>) {
          pending.push(p);
        },
      } as ExecutionContext,
    );
    await Promise.all(pending);
    await db.run(
      "INSERT INTO pvuv_jobs(name,last_run) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run",
      [name, due.getTime()],
    );
  }
  await db.run("DELETE FROM pvuv_kv WHERE expires_at<?", [Date.now()]);
  return true;
}
export function startJobs(db: Database) {
  let stopped = false;
  const queueLoop = (async () => {
    while (!stopped) {
      try {
        const n = await consume(db);
        if (n) continue;
      } catch (e) {
        console.error("queue", e);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  const cronLoop = (async () => {
    while (!stopped) {
      let complete = false;
      try {
        complete = await scheduled(db);
      } catch (e) {
        console.error("scheduler", e);
      }
      for (let i = 0; i < (complete ? 30 : 1) && !stopped; i++)
        await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return async () => {
    stopped = true;
    await Promise.all([queueLoop, cronLoop]);
  };
}
