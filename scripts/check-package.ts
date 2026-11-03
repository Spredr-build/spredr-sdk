// The package as npm will ship it, installed into a throwaway project the way a user installs it: TypeScript must find
// its types under both resolutions people use (nodenext, bundler), and Node must import it. Like any Node project in
// TypeScript, the throwaway one has @types/node: the agent's listen() gives back a node:http Server. What a broken exports map
// or a .d.ts pointing at a .ts file would break, this catches before a publish.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const work = mkdtempSync(join(tmpdir(), 'spredr-sdk-'));
try {
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').at(-1) ?? '';
  const installed = join(work, 'node_modules', '@spredr', 'sdk');
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['xzf', join(work, tarball), '-C', installed, '--strip-components=1']);
  mkdirSync(join(work, 'node_modules', '@types'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(work, 'node_modules', '@types', 'node'));

  writeFileSync(join(work, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(work, 'use.ts'), [
    "import { Agent, Caller, SpredrError, TaskError, type KindsOf } from '@spredr/sdk';",
    "const shop = new Agent({ id: 'a', key: 'k', ai: 'https://x', aiKey: 'k' }).on('reply', (input: { text: string }) => ({ reply: input.text }));",
    'export const typed = (backend: Caller<KindsOf<typeof shop>>): Promise<{ reply: string }> => backend.result(\'reply\', { text: \'hola\' });',
    'export const errors = [SpredrError, TaskError];',
  ].join('\n'));
  for (const resolution of [{ module: 'nodenext', moduleResolution: 'nodenext' }, { module: 'esnext', moduleResolution: 'bundler' }]) {
    writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...resolution, target: 'es2022', strict: true, noEmit: true, types: ['node'], skipLibCheck: false, lib: ['es2022'] }, files: ['use.ts'] }));
    execFileSync(process.execPath, [tsc, '-p', work], { stdio: 'inherit' });
  }
  writeFileSync(join(work, 'run.mjs'), "const sdk = await import('@spredr/sdk'); for (const name of ['Agent', 'Caller', 'Spredr', 'SpredrError', 'TaskError', 'newKeys']) if (typeof sdk[name] !== 'function') throw new Error(`${name} is missing`);");
  execFileSync(process.execPath, [join(work, 'run.mjs')], { cwd: work, stdio: 'inherit' });
  console.log('package: types resolve under nodenext and bundler, and Node imports it');
} finally {
  rmSync(work, { recursive: true, force: true });
}
