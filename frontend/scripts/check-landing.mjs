#!/usr/bin/env node
// Contract for the landing page: one h1, no self-animation, the quickstart
// snippet present, visible copy under budget. Run: npm run check:landing
// Reads the prerendered HTML, so `npm run build` must have run first.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, '.next/server/app/index.html');

let html;
try {
  html = readFileSync(file, 'utf8');
} catch {
  console.error(`FAIL — ${file} is missing. Run "npm run build" first.`);
  process.exit(1);
}

// Strip the RSC flight payload and inline styles so only rendered copy counts.
// React escapes quotes in text nodes as &quot;, so decode them before the
// generic entity strip or every quoted string in the snippet reads as broken.
const body = html
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'");
const text = body
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const words = text.split(' ').filter(Boolean);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check((html.match(/<h1[\s>]/g) || []).length === 1, 'page must render exactly one <h1>');
check(!/animate-/.test(html), 'no animate-* utilities — the page must not move on its own');
check(text.includes('chat.completions.create'), 'the quickstart snippet is missing');
check(text.includes('model="free"'), 'the snippet must advertise model="free"');
check(/<footer[\s>]/.test(html), 'the page shell must render a <footer>');
check(/How a request moves/.test(text), 'the "How a request moves" section is missing');
check(words.length >= 90, `only ${words.length} visible words — the page looks empty`);
check(words.length <= 230, `${words.length} visible words — over the 230-word clutter budget`);

for (const failure of failures) console.error(`FAIL — ${failure}`);
if (failures.length) {
  console.error(`\n${failures.length} landing check(s) failed.`);
  process.exit(1);
}
console.log(`PASS — landing contract holds (${words.length} visible words).`);
