/** Build twice with synthetic scoring Secrets and verify the runtime images. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pvuv-scoring-cache-'));
const prefix = `pvuv-scoring-check:${randomUUID().slice(0, 8)}`;
const images = [];
function docker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker check failed (${result.status})`);
}
try {
  const example = readFileSync('config.example.toml', 'utf8');
  for (const value of [17, 11]) {
    const config = example.replace(/^clean_max\s*=\s*\d+/m, `clean_max = ${value}`);
    const source = join(dir, `scoring-${value}.toml`);
    writeFileSync(source, config);
    const version = createHash('sha256').update(config).digest('hex');
    const tag = `${prefix}-${value}`;
    images.push(tag);
    docker(['buildx', 'build', '--load', '--secret', `id=scoring_config,src=${source}`,
      '--build-arg', `SCORING_CONFIG_VERSION=${version}`, '-t', tag, '.']);
    docker(['run', '--rm', '--entrypoint', 'node', tag, '-e', `
      const code = require('fs').readFileSync('dist/server/index.mjs', 'utf8');
      const value = Number(code.match(/"clean_max":\\s*(\\d+)/)?.[1]);
      if (value !== Number(process.argv[1])) throw new Error('Stale scoring configuration: ' + value);
      console.log('PASS runtime scoring threshold: ' + value);
    `, String(value)]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (images.length) spawnSync('docker', ['image', 'rm', ...images], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
