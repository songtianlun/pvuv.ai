/**
 * Builds sdk/src/f.ts → sdk/dist/f.js (deployed to js.pvuv.ai).
 *
 * dist/ is gitignored build output, and so is the copy in the console's assets
 * that actually serves /f.js. `npm run deploy:console` rebuilds both first.
 * Target: small, fast, ES2019-compatible IIFE — no dependencies.
 */

import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/f.ts')],
  outfile: path.join(here, 'dist/f.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2019',
  legalComments: 'none',
});

copyFileSync(path.join(here, 'dist/f.js'), path.join(here, '../workers/console/public/f.js'));

console.log('built sdk/dist/f.js and copied it into the console assets');
