// npm shows the README on its own page, where images from this private repository cannot load: every image must be a
// full https address. GitHub can show the repo's own (assets/), so the README may point there while the address is not
// live yet; this stops a publish until it is.
//   assets/flow.webp → https://spredr.cloud/branding/sdk/flow.webp (app/public/branding/sdk/, live with the landing)

import { readFileSync } from 'node:fs';

const README = new URL('../README.md', import.meta.url);
const local = [...readFileSync(README, 'utf8').matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1] ?? '').filter((src) => !src.startsWith('https://'));
if (local.length) {
  console.error(`README images npm cannot show: ${local.join(', ')}. Point each at its https address on spredr.cloud first.`);
  process.exit(1);
}
console.log('readme: every image is a full https address');
