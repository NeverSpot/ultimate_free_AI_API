// Idempotent bootstrap. Cross-platform: pure Node, no shell features.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env') && existsSync('.env.example')) {
  copyFileSync('.env.example', '.env');
  console.log('created .env from .env.example');
} else {
  console.log('.env already present, left untouched');
}

console.log('next: npm run db:up && npm run verify');
