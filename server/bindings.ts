import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Database } from "./database";
export class SQLiteKV {
  constructor(
    private db: Database,
    private namespace: string,
  ) {}
  async get<T = string>(
    key: string,
    type?: "json" | { type?: string },
  ): Promise<T | null> {
    const row = await this.db
      .prepare(
        "SELECT value FROM pvuv_kv WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",
      )
      .bind(this.namespace, key, Date.now())
      .first<{ value: string }>();
    if (!row) return null;
    return (
      type === "json" || (typeof type === "object" && type.type === "json")
        ? JSON.parse(row.value)
        : row.value
    ) as T;
  }
  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number },
  ) {
    const expires = options?.expiration
      ? options.expiration * 1000
      : options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : null;
    await this.db.run(
      "INSERT INTO pvuv_kv(namespace,key,value,expires_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      [this.namespace, key, value, expires],
    );
  }
  async delete(key: string) {
    await this.db.run("DELETE FROM pvuv_kv WHERE namespace=? AND key=?", [
      this.namespace,
      key,
    ]);
  }
  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
export class SQLiteQueue {
  constructor(private db: Database) {}
  async sendBatch(messages: { body: unknown }[]) {
    await this.db.transaction(async () => {
      for (const m of messages)
        await this.db.run(
          "INSERT INTO pvuv_queue(body,available_at,created_at) VALUES(?,?,?)",
          [JSON.stringify(m.body), Date.now(), Date.now()],
        );
    });
  }
}
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
};
export function assets(root = resolve("workers/console/public")): Fetcher {
  root = resolve(root);
  return {
    async fetch(request: Request) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      let name: string;
      try {
        name = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response(null, { status: 400 });
      }
      const base = resolve(root, `.${name}`);
      if (base !== root && !base.startsWith(root + sep))
        return new Response(null, { status: 404 });
      // Workers assets resolve /home and /home.zh to their HTML files.
      for (const file of [base, `${base}.html`, resolve(base, "index.html")]) {
        if (!file.startsWith(root + sep)) continue;
        try {
          const info = await stat(file);
          if (!info.isFile()) continue;
          return new Response(
            request.method === "HEAD" ? null : await readFile(file),
            {
              headers: {
                "content-type":
                  mime[file.split(".").pop()!] ?? "application/octet-stream",
              },
            },
          );
        } catch {
          // Try the HTML / directory-index fallback.
        }
      }
      return new Response(null, { status: 404 });
    },
  } as unknown as Fetcher;
}
