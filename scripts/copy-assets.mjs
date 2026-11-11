// Copy non-TypeScript assets into dist/ after `tsc`. Cross-platform: pure Node.
//
// tsc only emits .js — a .lua script next to its TypeScript source silently vanishes from
// the build, and `require('./dist/limits/ledger')` then throws ENOENT at load time. That is
// invisible to `npm run verify` (which runs from src via tsx) and only bites `npm start`
// from a built artifact, so it must be fixed in the build script, not by a test.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SRC = 'src';
const OUT = 'dist';
const ASSET_EXTENSIONS = ['.lua', '.sql', '.json', '.txt'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(OUT)) {
  console.error('copy-assets: dist/ does not exist — run tsc first');
  process.exit(1);
}

let copied = 0;
for (const file of walk(SRC)) {
  if (!ASSET_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
  const target = join(OUT, relative(SRC, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
  copied += 1;
  console.log(`copy-assets: ${relative(SRC, file)} -> ${relative('.', target)}`);
}

console.log(`copy-assets: ${copied} asset(s) copied`);
