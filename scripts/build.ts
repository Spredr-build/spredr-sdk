// Builds what npm gets: dist/index.js (one ESM file for Node 20+, no dependencies) and its .d.ts types. The sources
// stay TypeScript; nothing in dist is written by hand.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const DIST = `${HERE}dist`;
rmSync(DIST, { recursive: true, force: true });

await build({ entryPoints: [`${HERE}src/index.ts`], outfile: `${DIST}/index.js`, bundle: true, format: 'esm', platform: 'node', target: 'node22', legalComments: 'none' });

const config = `${HERE}tsconfig.types.json`;
writeFileSync(config, JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: ['node'],
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true, declaration: true, emitDeclarationOnly: true, rootDir: 'src', outDir: 'dist',
  },
  include: ['src'],
}));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const types = spawnSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' });
rmSync(config);
if (types.status !== 0) process.exit(types.status ?? 1);
// the types point at each other as .js, the way a project that installs the package resolves them
for (const file of readdirSync(DIST).filter((name) => name.endsWith('.d.ts'))) {
  writeFileSync(`${DIST}/${file}`, readFileSync(`${DIST}/${file}`, 'utf8').replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.js'"));
}
console.log('sdk: dist/index.js and its types');
