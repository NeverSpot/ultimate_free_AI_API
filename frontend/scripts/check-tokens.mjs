#!/usr/bin/env node
// Asserts the palette-A tokens exist in src/app/globals.css and that every
// critical text/background pairing meets WCAG AA. Run: npm run check:tokens
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');

const tok = {};
for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
  tok[m[1]] = m[2];
}

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (h) => {
  const [r, g, b] = rgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const cr = (a, b) => {
  const A = lum(a),
    B = lum(b),
    hi = Math.max(A, B),
    lo = Math.min(A, B);
  return (hi + 0.05) / (lo + 0.05);
};

const required = ['950', '900', '800', '700', '500', '400', '300', '200', '100'];
const missing = required.filter((n) => !tok['slate-' + n]).map((n) => '--color-slate-' + n);
for (const n of ['copper', 'copper-lift', 'copper-deep', 'ink']) {
  if (!tok[n]) missing.push('--color-' + n);
}
if (missing.length) {
  console.error('FAIL — missing tokens in src/app/globals.css @theme:');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

const ground = tok['slate-950'];
const raised = tok['slate-800'];

const checks = [
  ['primary ink  slate-100 on ground', tok['slate-100'], ground, 7.0],
  ['secondary    slate-200 on ground', tok['slate-200'], ground, 7.0],
  ['labels       slate-300 on ground', tok['slate-300'], ground, 4.5],
  ['muted body   slate-400 on ground', tok['slate-400'], ground, 4.5],
  ['faint        slate-500 on ground', tok['slate-500'], ground, 4.5],
  ['button label ink on copper', tok.ink, tok.copper, 4.5],
  ['copper accent on ground', tok.copper, ground, 4.5],
  ['copper accent on raised', tok.copper, raised, 3.0],
  ['copper hover on ground', tok['copper-lift'], ground, 4.5],
  ['copper ink on panel (copper-lift)', tok['copper-lift'], tok['slate-900'], 4.5],
  ['copper accent on panel (large/UI)', tok.copper, tok['slate-900'], 3.0],
];

let failed = 0;
for (const [label, fg, bg, min] of checks) {
  const r = cr(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} ${r.toFixed(2)}:1  (need ${min})`);
}

if (/prefers-color-scheme/.test(css)) {
  console.error(
    'FAIL — globals.css still contains a prefers-color-scheme block; it must be deleted.',
  );
  failed++;
}
if (css.includes('--color-background') || css.includes('--color-foreground')) {
  console.error('FAIL — dead --background/--foreground tokens still present.');
  failed++;
}

console.log(failed === 0 ? '\nAll palette checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
