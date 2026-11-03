import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import consoleWorker from "../workers/console/src/index";
import apiWorker from "../workers/api/src/index";
import ingestWorker from "../workers/ingest/src/index";
import { connect } from "./database";
import { migrate } from "./migrate";
import { assets, SQLiteKV, SQLiteQueue } from "./bindings";
import { startJobs } from "./jobs";
const db = connect();
await migrate(db);
if (process.argv.includes("--migrate")) {
  await db.close();
  process.exit(0);
}
if (!process.env.HMAC_KEY || process.env.HMAC_KEY.length < 32)
  throw new Error(
    "HMAC_KEY must contain at least 32 characters (reuse the previous deployment key during migration)",
  );
const env = {
  ...process.env,
  DB: db.asD1(),
  SITE_CONFIG: new SQLiteKV(db, "site-config").asKV(),
  BLOCKLIST: new SQLiteKV(db, "blocklist").asKV(),
  INGEST_QUEUE: new SQLiteQueue(db),
  ASSETS: assets(),
};
const trusted = (req: IncomingMessage) => {
  const value = req.headers["x-pv-proxy"];
  const secret = process.env.PROXY_TOKEN;
  return !!(
    secret &&
    typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(secret))
  );
};
const server = createServer(async (req, res) => {
  try {
    const isTrusted = trusted(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    // Host/scheme forwarding and client metadata require the SAME explicit
    // authentication as the existing first-party proxy. Never trust the Internet.
    const proto =
      isTrusted && req.headers["x-forwarded-proto"] === "https"
        ? "https"
        : "http";
    const host = process.env.PUBLIC_URL
      ? new URL(process.env.PUBLIC_URL).host
      : (req.headers.host ?? "localhost");
    const origin = process.env.PUBLIC_URL ?? `${proto}://${host}`;
    const incomingURL = new URL(req.url ?? "/", "http://request.invalid");
    const url = new URL(origin);
    url.pathname = incomingURL.pathname;
    url.search = incomingURL.search;
    if (!isTrusted) {
      headers.delete("cf-connecting-ip");
      for (const key of [...headers.keys()])
        if (key.startsWith("x-pv-") || key.startsWith("x-forwarded-"))
          headers.delete(key);
      headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "");
    } else {
      headers.delete("cf-connecting-ip");
      headers.set(
        "cf-connecting-ip",
        headers.get("x-pv-ip") ?? req.socket.remoteAddress ?? "",
      );
    }
    // Consume bounded bodies BEFORE constructing a Web Request. This also
    // protects console APIs, which were previously bounded by the edge.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "GET")
        ? undefined
        : Buffer.concat(chunks),
    });
    if (isTrusted) {
      const metadata = headers.get("x-pv-cf");
      if (metadata) {
        if (metadata.length > 8192)
          throw new Error("Client metadata too large");
        Object.defineProperty(request, "cf", { value: JSON.parse(metadata) });
      }
    }
    let response: Response;
    if (url.pathname === "/livez") {
      response = Response.json({ ok: true });
    } else if (url.pathname === "/healthz") {
      await db.all("SELECT 1");
      response = Response.json({ ok: true });
    } else if (url.pathname === "/in" || url.pathname === "/v")
      response = await ingestWorker.fetch(
        request as never,
        env as never,
        {} as ExecutionContext,
      );
    else if (url.pathname.startsWith("/v1/"))
      response = await apiWorker.fetch(request as never, env as never);
    else response = await consoleWorker.fetch(request as never, env as never);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    if (!response.body || req.method === "HEAD") res.end();
    else
      Readable.fromWeb(response.body as never)
        .on("error", () => res.destroy())
        .pipe(res);
  } catch (error) {
    console.error("request failed", error);
    if (!res.headersSent)
      res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"internal error"}');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
const stopJobs = startJobs(db);
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(
    `pvuv server listening on ${(server.address() as { port: number }).port}`,
  ),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 30000).unref();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      stopJobs(),
    ]);
    await db.close();
    clearTimeout(timeout);
  });
