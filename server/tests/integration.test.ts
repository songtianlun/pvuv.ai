import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "../database";
import { migrate } from "../migrate";
import { SQLiteKV, SQLiteQueue, assets } from "../bindings";
import { consume, scheduled } from "../jobs";
import ingest from "../../workers/ingest/src/index";
import api from "../../workers/api/src/index";
import consoleWorker from "../../workers/console/src/index";
import { hmacSign } from "../../shared/ids";
import { hashIP } from "../../workers/ingest/src/enrich";
import { runHourlyRollup } from "../../workers/cron/src/rollup";
import { runDailyBatch } from "../../workers/cron/src/batch";
import {
  runRetentionPurge,
  storageReport,
} from "../../workers/cron/src/retention";
const dir = await mkdtemp(join(tmpdir(), "pvuv-sqlite-test-"));
const path = join(dir, "pvuv.sqlite");
const db = connect(path);
const key = "integration-only-key-at-least-32-characters";
const env = {
  DB: db.asD1(),
  HMAC_KEY: key,
  API_TOKEN: "integration-token",
  ADMIN_EMAILS: "admin@example.test",
  SITE_CONFIG: new SQLiteKV(db, "site-config").asKV(),
  BLOCKLIST: new SQLiteKV(db, "blocklist").asKV(),
  INGEST_QUEUE: new SQLiteQueue(db),
  ASSETS: assets(),
};
const site = "Test1234";
const now = Date.now();
const payload = btoa(JSON.stringify({ u: "admin", exp: now + 86400e3 }))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const cookie = `_pvc_s=${payload}.${await hmacSign(key, `session|${payload}`)}`;
after(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
test("business flow using original D1 SQL on persistent SQLite", async (t) => {
  await migrate(db);
  await migrate(db);
  assert.equal((await db.all("SELECT name FROM d1_migrations")).length, 21);
  await db.run(
    "INSERT INTO users(user_id,email,created_at) VALUES('admin','admin@example.test',?)",
    [now],
  );
  await db.run(
    "INSERT INTO sites(site_id,name,owner_id,allowed_domains,created_at,public_token) VALUES(?,'Integration','admin','[\"example.test\"]',?,'public-test-token-1234')",
    [site, now],
  );
  await t.test("numbered bindings, literals and atomic rollback", async () => {
    assert.deepEqual(
      await db.all("SELECT '?1' AS literal, ?1 AS x, ?1 AS y, ?2 AS z", [1, 2]),
      [{ literal: "?1", x: 1, y: 1, z: 2 }],
    );
    await assert.rejects(
      db.batch([
        db.prepare(
          "INSERT INTO instance_settings(key,value) VALUES('rollback','test')",
        ),
        db.prepare("INSERT INTO missing_table VALUES(1)"),
      ]),
    );
    assert.equal(
      await db
        .prepare("SELECT * FROM instance_settings WHERE key='rollback'")
        .first(),
      null,
    );
  });
  await t.test("transactions exclude concurrent requests", async () => {
    const a = db.transaction(async () => {
      await db.run(
        "INSERT INTO instance_settings(key,value) VALUES('gate','before')",
      );
      await new Promise((r) => setTimeout(r, 20));
      await db.run(
        "UPDATE instance_settings SET value='after' WHERE key='gate'",
      );
    });
    const b = db
      .prepare("SELECT value FROM instance_settings WHERE key='gate'")
      .first<{ value: string }>();
    await a;
    assert.equal((await b)?.value, "after");
  });
  await t.test("KV TTL, JSON and delete", async () => {
    const kv = new SQLiteKV(db, "test");
    await kv.put("key", '{"a":1}', { expirationTtl: 60 });
    assert.deepEqual(await kv.get("key", "json"), { a: 1 });
    await kv.delete("key");
    assert.equal(await kv.get("key"), null);
    await kv.put("expired", "x", { expiration: 1 });
    assert.equal(await kv.get("expired"), null);
  });
  await t.test(
    "ingest, durable queue, consumer, sessions and identity",
    async () => {
      const events = [
        {
          s: site,
          e: "pageview",
          u: "https://example.test/",
          vid: "visitor1",
          sid: "session1",
          uid: "user1",
          sw: 1440,
          sh: 900,
          lang: "en",
          ts: now - 10000,
        },
        {
          s: site,
          e: "pageview",
          u: "https://example.test/checkout",
          vid: "visitor1",
          sid: "session1",
          ts: now - 5000,
        },
        {
          s: site,
          e: "purchase",
          u: "https://example.test/checkout",
          vid: "visitor1",
          sid: "session1",
          p: { revenue: 12, currency: "USD" },
          ts: now,
        },
        {
          s: site,
          e: "page_leave",
          u: "https://example.test/checkout",
          vid: "visitor1",
          sid: "session1",
          d: 18000,
          hi: 1,
          ts: now + 1,
        },
      ];
      const response = await ingest.fetch(
        new Request("https://ingest.test/in", {
          method: "POST",
          headers: {
            origin: "https://example.test",
            "cf-connecting-ip": "192.0.2.4",
            "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
          },
          body: JSON.stringify(events),
        }) as never,
        env as never,
        {} as ExecutionContext,
      );
      assert.equal(response.status, 204, await response.text());
      assert.equal(await consume(db), 4);
      assert.equal(await consume(db), 0);
      assert.deepEqual(
        await db.all(
          "SELECT pageviews,events_count,duration_ms,is_bounce FROM sessions WHERE site_id=?",
          [site],
        ),
        [{ pageviews: 2, events_count: 4, duration_ms: 18000, is_bounce: 0 }],
      );
      assert.equal((await db.all("SELECT * FROM identities")).length, 1);
    },
  );
  const get = async (path: string) => {
    const r = await api.fetch(
      new Request(`https://api.test/v1/${path}`, {
        headers: { authorization: "Bearer integration-token" },
      }) as never,
      env,
    );
    assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
    return r.json();
  };
  for (const endpoint of [
    "overview",
    "realtime",
    "timeseries",
    "timeseries?interval=hour",
    "quality",
    "vitals",
    "ctit",
    "adguard",
    "edge",
    "alerts",
    "anomalies",
    "traffic",
    "visitors",
    "visitors?verdict=clean",
    "visitors/visitor1/profile",
    "funnels",
    `funnel?steps=${encodeURIComponent(
      JSON.stringify([
        { type: "page", value: "/" },
        { type: "page", value: "/checkout" },
      ]),
    )}&breakdown=country`,
    `funnel_dropoff?steps=${encodeURIComponent(
      JSON.stringify([
        { type: "page", value: "/" },
        { type: "page", value: "/checkout" },
      ]),
    )}`,
  ])
    await t.test(`API ${endpoint}`, async () => {
      await get(`sites/${site}/${endpoint}`);
    });
  for (const dim of [
    "page",
    "source",
    "referrer",
    "country",
    "region",
    "city",
    "device",
    "browser",
    "os",
    "size",
    "channel",
    "goal",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ft_source",
    "ft_medium",
    "ft_campaign",
    "bot_category",
    "hostname",
    "entry_page",
    "exit_page",
  ])
    await t.test(`breakdown ${dim}`, async () => {
      await get(`sites/${site}/breakdown?dim=${dim}`);
    });
  await t.test("metric values and auth refusal", async () => {
    const overview: any = await get(`sites/${site}/overview`);
    assert.equal(overview.pv, 2);
    assert.equal(overview.uv, 1);
    assert.equal(overview.conversions, 1);
    assert.equal(overview.revenue, 12);
    assert.equal(overview.bounce_rate, 0);
    const r = await api.fetch(
      new Request("https://api.test/v1/sites") as never,
      env,
    );
    assert.equal(r.status, 401);
  });
  await t.test("discovery and ranking", async () => {
    await get("sites");
    await get("ranking");
  });
  await t.test("hourly rollup is repeatable", async () => {
    await runHourlyRollup(env);
    const before = await db.all("SELECT * FROM rollup_site_daily");
    await runHourlyRollup(env);
    assert.deepEqual(await db.all("SELECT * FROM rollup_site_daily"), before);
    assert.equal(before[0].pv, 2);
  });
  await t.test("daily analysis and scheduler resume", async () => {
    await runDailyBatch(env);
    await runDailyBatch(env);
    await scheduled(db);
    const jobs = await db.all("SELECT * FROM pvuv_jobs ORDER BY name");
    await scheduled(db);
    assert.deepEqual(
      await db.all("SELECT * FROM pvuv_jobs ORDER BY name"),
      jobs,
    );
    assert.equal(jobs.length, 2);
  });
  await t.test("storage and retention", async () => {
    await storageReport(db.asD1());
    const r = await runRetentionPurge(env);
    assert.deepEqual(r.errors, []);
  });
  const consoleCall = async (path: string, method = "GET", body?: unknown) =>
    consoleWorker.fetch(
      new Request(`https://console.test${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as never,
      env as never,
    );
  await t.test("console pages, settings, SDK and diagnostics", async () => {
    for (const path of [
      "/",
      "/f.js",
      "/api/home",
      "/api/auth/providers",
      "/api/me",
      "/api/sites",
      "/api/tokens",
      "/api/storage",
      "/api/diagnostics",
    ]) {
      const r = await consoleCall(path);
      assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
    }
  });
  await t.test("personal token creation, scope and revocation", async () => {
    const r = await consoleCall("/api/tokens", "POST", {
      name: "Test",
      site_id: site,
    });
    assert.equal(r.status, 200);
    const data: any = await r.json();
    const token = data.token;
    assert.equal(typeof token, "string");
    const request = () =>
      api.fetch(
        new Request("https://api.test/v1/sites", {
          headers: { authorization: `Bearer ${token}` },
        }) as never,
        env,
      );
    assert.equal((await request()).status, 200);
    const revoked = await consoleCall(
      `/api/tokens?id=${data.token_id}`,
      "DELETE",
    );
    assert.equal(revoked.status, 200);
    assert.equal((await request()).status, 401);
  });
  await t.test(
    "queue failure rolls back counters and persists retry",
    async () => {
      const suffix = new Date(now).toISOString().slice(0, 7).replace("-", "");
      const row = await db
        .prepare(`SELECT * FROM events_${suffix} LIMIT 1`)
        .first<Record<string, unknown>>();
      assert.ok(row);
      delete row.id;
      row.eid = "retry-fixture";
      await env.INGEST_QUEUE.sendBatch([{ body: row }]);
      const prior = await db.all("SELECT * FROM sessions");
      await db.exec(
        "CREATE TRIGGER fail_delivery BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'test rollback'); END",
      );
      await consume(db);
      assert.deepEqual(await db.all("SELECT * FROM sessions"), prior);
      assert.equal(
        (
          await db
            .prepare("SELECT attempts FROM pvuv_queue")
            .first<{ attempts: number }>()
        )?.attempts,
        1,
      );
      await db.exec("DROP TRIGGER fail_delivery");
      await db.run("UPDATE pvuv_queue SET available_at=0");
      assert.equal(await consume(db), 1);
      assert.equal(await consume(db), 0);
    },
  );
  await t.test(
    "backup and restart preserve the SQLite file and queued work",
    async () => {
      const backup = join(dir, "backup.sqlite");
      await db.backup(backup);
      const reopened = connect(backup);
      try {
        await migrate(reopened);
        assert.equal(
          (
            await reopened
              .prepare("SELECT COUNT(*) AS n FROM sites")
              .first<{ n: number }>()
          )?.n,
          1,
        );
      } finally {
        await reopened.close();
      }
    },
  );
  await t.test(
    "D1 SQL import uses the same schema with no translation",
    async () => {
      const source = join(dir, "d1.sql"),
        target = join(dir, "restored.sqlite");
      await writeFile(
        source,
        (await readFile("shared/schema.sql", "utf8")) +
          "\nINSERT INTO users(user_id,email,created_at) VALUES('restored','restored@example.test',1);\n",
      );
      await promisify(execFile)(
        process.execPath,
        ["dist/server/import.mjs", source],
        { env: { ...process.env, SQLITE_PATH: target } },
      );
      const restored = connect(target);
      try {
        assert.equal(
          (
            await restored
              .prepare("SELECT email FROM users")
              .first<{ email: string }>()
          )?.email,
          "restored@example.test",
        );
        await migrate(restored);
      } finally {
        await restored.close();
      }
    },
  );
  await t.test(
    "real HTTP adapter starts, serves SDK and refuses anonymous APIs",
    async () => {
      const child = spawn(process.execPath, ["dist/server/index.mjs"], {
        env: {
          ...process.env,
          SQLITE_PATH: join(dir, "http.sqlite"),
          PORT: "0",
          HMAC_KEY: key,
          PUBLIC_URL: "https://analytics.example.test",
          ADMIN_EMAILS: "admin@example.test",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
          PROXY_TOKEN: "test-legacy-proxy-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      child.stderr.on("data", (c) => {
        logs += c;
      });
      try {
        const port = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`HTTP startup timed out: ${logs}`)),
            15000,
          );
          child.on("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`HTTP exited ${code}: ${logs}`));
          });
          child.stdout.on("data", (chunk) => {
            const match = String(chunk).match(/listening on (\d+)/);
            if (match) {
              clearTimeout(timeout);
              resolve(Number(match[1]));
            }
          });
        });
        for (const path of ["/healthz", "/api/home", "/f.js"])
          assert.equal(
            (await fetch(`http://127.0.0.1:${port}${path}`)).status,
            200,
            path,
          );
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/v1/sites`)).status,
          401,
        );
        const address = `http://127.0.0.1:${port}`;
        const oauth = await fetch(`${address}/api/auth/google/start`, {
          redirect: "manual", headers: { host: "analytics.example.test" },
        });
        assert.equal(oauth.status, 302);
        assert.equal(new URL(oauth.headers.get("location")!).searchParams.get("redirect_uri"),
          "https://analytics.example.test/api/auth/google/callback");
        assert.equal((await fetch(`${address}/f.js`, { headers: { host: "js.example.test" } })).status, 200);
        assert.equal((await fetch(`${address}/in`, { method: "OPTIONS", headers: { host: "in.example.test" } })).status, 204);
        const registration = await fetch(`${address}/api/diagnostics/selftest-site`, {
          method: "POST", headers: { cookie, host: "analytics.example.test", "content-type": "application/json" },
          body: JSON.stringify({ host: "example.test" }),
        });
        assert.equal(registration.status, 200);
        const { site_id: httpSite } = await registration.json() as { site_id: string };
        const httpNow = Date.now();
        for (const [visitor, forwarding] of [
          ["http-traefik", { "x-forwarded-for": "192.0.2.66, 203.0.113.9", "x-pv-ip": "192.0.2.99", "x-pv-country": "ZZ" }],
          ["http-legacy", { "x-pv-proxy": "test-legacy-proxy-token", "x-pv-ip": "192.0.2.4", "x-pv-country": "US" }],
        ] as const) {
          const received = await fetch(`${address}/in`, {
            method: "POST", headers: { host: "in.example.test", origin: "https://example.test", ...forwarding },
            body: JSON.stringify({ s: httpSite, e: "pageview", u: "https://example.test/", vid: visitor, sid: visitor, ts: httpNow }),
          });
          assert.equal(received.status, 204);
        }
        const query = await fetch(`${address}/v1/sites`, { headers: { cookie, host: "api.example.test" } });
        assert.equal(query.status, 200);
        const persisted = connect(join(dir, "http.sqlite"));
        try {
          const suffix = new Date(httpNow).toISOString().slice(0, 7).replace("-", "");
          let rows: { visitor_id: string; ip_hash: string; country: string | null }[] = [];
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            try {
              rows = await persisted.all(`SELECT visitor_id,ip_hash,country FROM events_${suffix} WHERE site_id=? ORDER BY visitor_id`, [httpSite]);
              if (rows.length === 2) break;
            } catch { /* consumer has not created the partition yet */ }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.deepEqual(rows, [
            { visitor_id: "http-legacy", ip_hash: (await hashIP(key, "192.0.2.4")).ip_hash, country: "US" },
            { visitor_id: "http-traefik", ip_hash: (await hashIP(key, "203.0.113.9")).ip_hash, country: null },
          ]);
        } finally { await persisted.close(); }
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
    },
  );
});
