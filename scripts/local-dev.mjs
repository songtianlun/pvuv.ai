/** Local development tooling only; never loaded by the application server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const command = process.argv[2];
const envFile = '.env.local';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

async function init() {
  const port = Number(process.env.PVUV_DEV_PORT ?? 3000);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, 'Invalid PVUV_DEV_PORT');
  const contents = [
    '# Local development only. Generated once; existing values are preserved.',
    `HMAC_KEY=${randomBytes(32).toString('hex')}`,
    `PUBLIC_URL=http://localhost:${port}`,
    `PORT=${port}`,
    `INGEST_HOST=localhost:${port}`,
    'SQLITE_PATH=data/dev.sqlite',
    'ADMIN_EMAILS=dev@example.test',
    'DEFAULT_LANG=en',
    '',
  ].join('\n');
  try {
    await writeFile(envFile, contents, { flag: 'wx', mode: 0o600 });
    console.log(`Created ${envFile} with a random development key.`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function config() {
  const values = parseEnv(await readFile(envFile, 'utf8'));
  const url = new URL(values.PUBLIC_URL);
  assert.ok(loopback.has(url.hostname) && url.protocol === 'http:',
    '.env.local PUBLIC_URL must be a local HTTP loopback URL');
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'PUBLIC_URL must contain only a local origin');
  assert.ok(Number(values.PORT) === Number(url.port || 80), 'PORT must match PUBLIC_URL');
  assert.ok(values.HMAC_KEY?.length >= 32, '.env.local HMAC_KEY must be at least 32 characters');
  return { values, origin: url.origin };
}

function session(key) {
  const payload = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 3600e3 })).toString('base64url');
  const signature = createHmac('sha256', key).update(`session|${payload}`).digest('base64url');
  return `_pvc_s=${payload}.${signature}`;
}

async function run(executable, args, values, input = 'inherit') {
  const child = spawn(executable, args, { stdio: [input, 'inherit', 'inherit'], env: { ...process.env, ...values } });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve();
        else reject(new Error(`${executable} exited ${code ?? signal}`));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function smoke(values, origin) {
  const cookie = session(values.HMAC_KEY);
  async function request(path, { auth = false, ...options } = {}) {
    return fetch(new URL(path, origin), {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { ...(auth ? { cookie } : {}), ...options.headers },
    });
  }
  for (const path of ['/healthz', '/livez', '/', '/login.html', '/sites.html', '/f.js']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, `${path}: empty response`);
  }
  for (const path of ['/api/me', '/v1/sites']) {
    assert.equal((await request(path)).status, 401, `${path}: anonymous auth`);
  }
  console.log('PASS health, pages, SDK and anonymous auth rejection');

  const siteResponse = await request('/api/diagnostics/selftest-site', {
    auth: true,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: new URL(origin).hostname }),
  });
  assert.equal(siteResponse.status, 200, 'create self-test site');
  const { site_id: site } = await siteResponse.json();
  assert.ok(site, 'self-test site id');
  const marker = `make-smoke-${randomUUID()}`;
  const ingestResponse = await request('/in', {
    method: 'POST',
    headers: { origin, 'content-type': 'text/plain' },
    body: JSON.stringify({
      s: site, e: 'pageview', u: `${origin}/__pvuv_make_smoke`,
      vid: marker, sid: marker, ts: Date.now(),
    }),
  });
  assert.equal(ingestResponse.status, 204, 'event accepted');
  const deadline = Date.now() + 15000;
  let found = false;
  while (Date.now() < deadline) {
    const response = await request(`/api/diagnostics/probe?site=${site}&vid=${encodeURIComponent(marker)}`, { auth: true });
    assert.equal(response.status, 200, 'probe event');
    const probe = await response.json();
    if (probe.found) {
      assert.equal(probe.row.path, '/__pvuv_make_smoke');
      assert.equal(probe.row.event, 'pageview');
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(found, 'event did not reach SQLite within 15 seconds');
  const overviewResponse = await request(`/v1/sites/${site}/overview?period=today`, { auth: true });
  assert.equal(overviewResponse.status, 200, 'authenticated statistics query');
  assert.ok((await overviewResponse.json()).pv >= 1, 'pageview missing from statistics');
  console.log('PASS signed auth, event ingest, durable queue, SQLite persistence and statistics query');
  console.log(`Development environment verified: ${origin}`);
}

try {
  if (command === 'init') {
    await init();
    await config();
  } else {
    const { values, origin } = await config();
    if (command === 'compose') {
      await run('docker', ['compose', '-p', 'pvuv-dev', '--env-file', envFile, '-f', 'compose.dev.yaml', ...process.argv.slice(3)], values);
    } else if (command === 'import-sites') {
      const path = process.env.PVUV_IMPORT_FILE;
      if (!path) throw new Error('Usage: make import-sites FILE=/path/to/pvuv-sites.sql');
      const input = await open(path, 'r');
      try {
        assert.ok((await input.stat()).isFile(), 'FILE must refer to a SQL file');
        const script = await readFile(new URL('./import-sites.mjs', import.meta.url), 'utf8');
        await run('docker', [
          'compose', '-p', 'pvuv-dev', '--env-file', envFile, '-f', 'compose.dev.yaml',
          'exec', '-T', 'app', 'node', '--input-type=module', '-e', script, 'import-sites.mjs', '-',
        ], values, input.fd);
      } finally {
        await input.close();
      }
    } else if (command === 'native') {
      await run(process.execPath, ['dist/server/index.mjs'], values);
    } else if (command === 'url') {
      console.log(`Development environment: ${origin}\nRun make smoke to verify it; make dev-session to sign in locally.`);
    } else if (command === 'session') {
      console.log(`Open ${origin}, then run this in the browser console (valid for one hour):`);
      console.log(`document.cookie = ${JSON.stringify(`${session(values.HMAC_KEY)}; Path=/; SameSite=Lax`)}; location.href = '/sites.html';`);
    } else if (command === 'smoke') {
      await smoke(values, origin);
    } else throw new Error('Unknown local development command');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
