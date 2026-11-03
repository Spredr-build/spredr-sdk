// The SDK has no dependencies, and says so on npm: its code imports node: built-ins and its own files, nothing else.
// Fails on the first import that would make a project install something more.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const problems: string[] = [];
for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
  for (const match of readFileSync(SRC + file, 'utf8').matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? '';
    const own = specifier.startsWith('./') && !specifier.slice(2).includes('/');
    if (!own && !specifier.startsWith('node:')) problems.push(`src/${file} imports ${specifier}: the SDK stands alone (node: and its own files only).`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('alone: the SDK imports node: and its own files only');
