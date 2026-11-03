import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { connect, type Database } from "../database";
import { migrate } from "../migrate";
import { assets, SQLiteKV, SQLiteQueue } from "../bindings";
import { scheduled, consume, startJobs } from "../jobs";
import ingest from "../../workers/ingest/src/index";
import consoleWorker from "../../workers/console/src/index";
import { runDailyBatch } from "../../workers/cron/src/batch";

const site = "Backlog1";
async function fixture(work: (db: Database, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pvuv-regression-"));
  const db = connect(join(dir, "test.sqlite"));
  try {
    await migrate(db);
    await db.run("INSERT INTO sites(site_id,name,owner_id,allowed_domains,created_at) VALUES(?,'Regression','admin','[\"example.test\"]',?)", [site, Date.now()]);
    await work(db, dir);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function env(db: Database) {
  return {
    DB: db.asD1(),
    HMAC_KEY: "regression-only-key-at-least-32-characters",
    SITE_CONFIG: new SQLiteKV(db, "site-config").asKV(),
    BLOCKLIST: new SQLiteKV(db, "blocklist").asKV(),
    INGEST_QUEUE: new SQLiteQueue(db),
    runInTransaction: (work: () => Promise<void>) => db.transaction(work),
  };
}
async function queued(db: Database, n: number, age = 20 * 60_000) {
  const runtime = env(db);
  const response = await ingest.fetch(new Request("https://ingest.test/in", {
    method: "POST", headers: { origin: "https://example.test", "cf-connecting-ip": "192.0.2.5" },
    body: JSON.stringify({ s: site, e: "pageview", u: "https://example.test/", vid: "template", sid: "template" }),
  }) as never, runtime as never, {} as ExecutionContext);
  assert.equal(response.status, 204);
  const row = JSON.parse((await db.all<{ body: string }>("SELECT body FROM pvuv_queue ORDER BY id DESC LIMIT 1"))[0].body);
  await db.run("DELETE FROM pvuv_queue");
  const ts = Date.now() - age;
  await runtime.INGEST_QUEUE.sendBatch(Array.from({ length: n }, (_, i) => ({ body: {
    ...row, eid: `regression-${i}`, visitor_id: `visitor-${i}`, session_id: `session-${i}`, ts: ts + i,
  } })));
}
async function count(db: Database) {
  return (await db.all<{ n: number }>("SELECT COALESCE(SUM(sessions_count),0) AS n FROM visitor_profiles"))[0].n;
}
async function waitFor(predicate: () => Promise<boolean>) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail("Background work did not finish within 10 seconds");
}

test("restart drains 250 historical events before advancing analysis, including pending retries", () => fixture(async (db) => {
  await queued(db, 250);
  await db.run("UPDATE pvuv_queue SET available_at=?", [Date.now() + 60000]);
  assert.equal(await scheduled(db), false);
  assert.equal((await db.all("SELECT * FROM pvuv_jobs")).length, 0);
  await db.run("UPDATE pvuv_queue SET available_at=0");
  const stop = startJobs(db);
  try {
    await waitFor(async () => (await db.all("SELECT * FROM pvuv_jobs")).length === 2);
  } finally { await stop(); }
  assert.equal((await db.all("SELECT * FROM pvuv_queue")).length, 0);
  assert.equal(await count(db), 250);
  await runDailyBatch(env(db));
  assert.equal(await count(db), 250, "the next daily pass must not double-count");
}));

test("new backdated events remain ahead of the standalone analysis boundary", () => fixture(async (db) => {
  await scheduled(db);
  const row = await db.prepare("SELECT value FROM instance_settings WHERE key='batch_wm_profiles_ts'").first<{ value: string }>();
  assert.ok(Number(row?.value) <= Date.now() - 15 * 60_000);
  await queued(db, 1, 10 * 60_000);
  await consume(db);
  // Use the normal five-minute boundary to represent a later settled pass.
  await runDailyBatch(env(db));
  assert.equal(await count(db), 1);
}));

test("profile accumulation rolls back if its watermark cannot commit", () => fixture(async (db) => {
  await queued(db, 3);
  await consume(db);
  await db.exec("CREATE TRIGGER reject_watermark BEFORE INSERT ON instance_settings WHEN NEW.key='batch_wm_profiles_ts' BEGIN SELECT RAISE(ABORT,'watermark fixture'); END");
  await assert.rejects(runDailyBatch(env(db)), /watermark fixture/);
  assert.equal(await count(db), 0);
  assert.equal(await db.prepare("SELECT value FROM instance_settings WHERE key='batch_wm_profiles_ts'").first(), null);
  await db.exec("DROP TRIGGER reject_watermark");
  await runDailyBatch(env(db));
  assert.equal(await count(db), 3);
  await runDailyBatch(env(db));
  assert.equal(await count(db), 3);
}));

test("a waiting edge API does not hold the database gate or stop queue consumption", () => fixture(async (db) => {
  await db.run("INSERT INTO instance_settings(key,value) VALUES('cf_api_token','synthetic-token')");
  const savedFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const upstream = new Promise<Response>((resolve) => { release = resolve; });
  globalThis.fetch = (async (_request: unknown, options: RequestInit) => {
    assert.ok(options.signal, "edge requests must carry a timeout signal");
    entered();
    return upstream;
  }) as typeof fetch;
  const job = scheduled(db);
  try {
    await Promise.race([waiting, delay(3000).then(() => assert.fail("edge request was not reached"))]);
    await Promise.race([
      (async () => {
        assert.deepEqual(await db.all("SELECT 1 AS ok"), [{ ok: 1 }]);
        await queued(db, 1, 0);
        assert.equal(await consume(db), 1);
      })(),
      delay(1000).then(() => assert.fail("database request blocked behind network I/O")),
    ]);
  } finally {
    release(Response.json({ success: true, result: [] }));
    await job;
    globalThis.fetch = savedFetch;
  }
}));

test("HTML assets support custom and localized homes, indexes, HEAD, and traversal protection", () => fixture(async (db, dir) => {
  const root = join(dir, "public");
  await mkdir(join(root, "guide"), { recursive: true });
  await writeFile(join(root, "home.html"), "Custom home");
  await writeFile(join(root, "home.zh.html"), "中文首页");
  await writeFile(join(root, "guide/index.html"), "Guide");
  const binding = assets(root);
  for (const [path, content] of [["/home", "Custom home"], ["/home.zh", "中文首页"], ["/guide", "Guide"], ["/guide/", "Guide"]]) {
    const response = await binding.fetch(new Request(`https://console.test${path}`));
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.equal(await response.text(), content);
  }
  const head = await binding.fetch(new Request("https://console.test/home", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await binding.fetch(new Request("https://console.test/%2e%2e%2fsecret"))).status, 404);
  const runtime = { ...env(db), ASSETS: binding, ADMIN_EMAILS: "dev@example.test" };
  assert.equal(await (await consoleWorker.fetch(new Request("https://console.test/"), runtime)).text(), "Custom home");
  assert.equal(await (await consoleWorker.fetch(new Request("https://console.test/zh"), runtime)).text(), "中文首页");
}));

test("ledger-free imports accept retained partitions or no raw data and reject incomplete fixed schemas", () => fixture(async (db, dir) => {
  const schema = await readFile("shared/schema.sql", "utf8");
  const migratedSchema = (await db.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='table'"))
    .filter(({ name }) => name !== "d1_migrations" && !name.startsWith("pvuv_") && !name.startsWith("sqlite_"))
    .map(({ sql }) => sql + ";").join("\n");
  for (const [name, sourceSchema, changes] of [
    ["retained", schema, "ALTER TABLE events_202607 RENAME TO events_202608;"],
    ["empty", schema, "DROP TABLE events_202607;"],
    ["migrated", migratedSchema, "ALTER TABLE events_202607 RENAME TO events_202608;"],
  ]) {
    const source = join(dir, `${name}.sql`), target = join(dir, `${name}.sqlite`);
    await writeFile(source, sourceSchema + "\n" + changes);
    await promisify(execFile)(process.execPath, ["dist/server/import.mjs", source], { env: { ...process.env, SQLITE_PATH: target } });
    const restored = connect(target);
    try {
      assert.equal((await restored.all("SELECT * FROM d1_migrations")).length, 21);
      assert.equal(await restored.prepare("SELECT name FROM sqlite_master WHERE name='events_202607'").first(), null);
      if (name !== "empty") assert.ok(await restored.prepare("SELECT name FROM sqlite_master WHERE name='events_202608'").first());
    } finally { await restored.close(); }
  }
  for (const [name, changes] of [
    ["missing", "ALTER TABLE sites RENAME COLUMN public_token TO legacy_public_token;"],
    ["old-key", "ALTER TABLE sessions RENAME TO old_sessions; CREATE TABLE sessions AS SELECT * FROM old_sessions; DROP TABLE old_sessions;"],
  ]) {
    const source = join(dir, `${name}.sql`), target = join(dir, `${name}.sqlite`);
    await writeFile(source, schema + "\n" + changes);
    await assert.rejects(promisify(execFile)(process.execPath, ["dist/server/import.mjs", source], { env: { ...process.env, SQLITE_PATH: target } }), /missing sites.public_token|outdated primary key/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
}));
