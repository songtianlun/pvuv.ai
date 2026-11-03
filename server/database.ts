import { Worker } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
/** A dedicated worker keeps SQLite scans off the HTTP event loop. Business SQL
 * is sent unchanged; transactions serialize through an async, reentrant gate. */
export class Database {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private context = new AsyncLocalStorage<boolean>();
  private failure?: Error;
  constructor(readonly path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.worker = new Worker(new URL("./sqlite-worker.mjs", import.meta.url), {
      workerData: { path },
    });
    this.worker.on("message", ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      error ? request.reject(new Error(error)) : request.resolve(result);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) =>
      fail(new Error(`SQLite worker exited (${code})`)),
    );
  }
  private request(
    operation: string,
    sql?: string,
    values?: unknown[],
    path?: string,
  ): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, sql, values, path });
    });
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    const result = this.tail.then(() => this.context.run(true, fn));
    this.tail = result.catch(() => {});
    return result;
  }
  async result<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{
    success: true;
    results: T[];
    meta: { changes: number; last_row_id: number };
  }> {
    return this.exclusive(() => this.request("all", sql, values));
  }
  async all<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.result<T>(sql, values)).results;
  }
  async run(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ changes: number; last_row_id: number }> {
    return this.exclusive(() => this.request("run", sql, values));
  }
  async exec(sql: string): Promise<void> {
    await this.exclusive(() => this.request("exec", sql));
  }
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const name = `tx_${++this.sequence}`;
      await this.request("exec", `SAVEPOINT ${name}`);
      try {
        const result = await fn(this);
        await this.request("exec", `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await this.request(
          "exec",
          `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`,
        );
        throw error;
      }
    });
  }
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  async batch(statements: Statement[]) {
    return this.transaction(async () => {
      const result = [];
      for (const s of statements) result.push(await s.all());
      return result;
    });
  }
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
  async backup(path: string) {
    await this.exclusive(() =>
      this.request("backup", undefined, undefined, path),
    );
  }
  async close() {
    await this.exclusive(() => this.request("close"));
    await this.worker.terminate();
  }
}
export class Statement {
  constructor(
    readonly db: Database,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }
  async all<T = Record<string, unknown>>() {
    return this.db.result<T>(this.sql, this.values);
  }
  async run() {
    const meta = await this.db.run(this.sql, this.values);
    return { success: true, meta };
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.db.all(this.sql, this.values))[0];
    return (row ? (column ? row[column] : row) : null) as T | null;
  }
}
export function connect(path = process.env.SQLITE_PATH ?? "data/pvuv.sqlite") {
  return new Database(path);
}
