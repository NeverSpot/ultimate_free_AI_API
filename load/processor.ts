import type { Config, Scenario } from 'artillery';

export interface Events {
  on?(event: string, listener: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): void;
}

export interface Context {
  vars?: Record<string, any>;
  funcs?: Record<string, (...args: any[]) => any>;
  [key: string]: any;
}

export const MOCK_LATENCY_MS = 60;
export const overheads: number[] = [];

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export function resetOverheads(): void {
  overheads.length = 0;
}

export function calculatePercentiles(samples: number[] = overheads): Percentiles {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
  return { p50, p95, p99, count: sorted.length };
}

export function printOverheadStats(samples: number[] = overheads): Percentiles {
  const { p50, p95, p99, count } = calculatePercentiles(samples);
  console.log(`\n=== PROXY OVERHEAD (mock latency=${MOCK_LATENCY_MS}ms subtracted) ===`);
  console.log(`p50: ${p50.toFixed(2)}ms`);
  console.log(`p95: ${p95.toFixed(2)}ms`);
  console.log(`p99: ${p99.toFixed(2)}ms`);
  console.log(`Samples: ${count}`);
  return { p50, p95, p99, count };
}

/**
 * Samples a prompt length from a log-normal distribution bounded between min and max.
 * For range [100, 2000], mu = 6.103 and sigma = 0.749, giving a median around 447 chars
 * with a realistic long tail up to 2000 chars.
 */
export function sampleLogNormalLength(min: number = 100, max: number = 2000): number {
  const safeMin = Math.max(1, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  if (safeMin === safeMax) return safeMin;
  const lnMin = Math.log(safeMin);
  const lnMax = Math.log(safeMax);
  const mu = (lnMin + lnMax) / 2;
  const sigma = (lnMax - lnMin) / 4;
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const len = Math.round(Math.exp(mu + sigma * z));
  return Math.max(safeMin, Math.min(safeMax, len));
}

export function generateLogNormalString(min: number = 100, max: number = 2000): string {
  const length = sampleLogNormalLength(min, max);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return result;
}

/** Artillery beforeRequest hook to inject log-normal prompt */
export function setLogNormalPrompt(
  requestParams: any,
  context: any,
  ee: any,
  next?: (err?: any) => void,
): void {
  const prompt = generateLogNormalString(100, 2000);
  if (
    requestParams?.json &&
    Array.isArray(requestParams.json.messages) &&
    requestParams.json.messages.length > 0
  ) {
    requestParams.json.messages[0].content = prompt;
  }
  if (context?.vars) {
    context.vars.prompt = prompt;
  }
  if (typeof next === 'function') {
    return next();
  }
}

/** Artillery afterResponse hook to record response time and calculate overhead */
export function recordOverhead(
  requestParams: any,
  response: any,
  context: any,
  ee: any,
  next?: (err?: any) => void,
): void {
  const elapsed =
    response?.timings?.phases?.total ?? response?.elapsedTime ?? requestParams?.responseTime;

  if (typeof elapsed === 'number' && Number.isFinite(elapsed)) {
    const overhead = Math.max(0, elapsed - MOCK_LATENCY_MS);
    overheads.push(overhead);
  }
  if (typeof next === 'function') {
    return next();
  }
}

/**
 * Main processor export as specified in docs/phase-d-plan.md
 */
export default function processor(events: any, context?: any, ee?: any): void {
  const emitter = events || ee;
  if (emitter && typeof emitter.on === 'function') {
    emitter.on('request', (request: any) => {
      if (request && typeof request.responseTime === 'number') {
        const overhead = Math.max(0, request.responseTime - MOCK_LATENCY_MS);
        overheads.push(overhead);
      }
    });

    emitter.on('done', () => {
      printOverheadStats();
    });
  }
}

Object.assign(processor, {
  setLogNormalPrompt,
  recordOverhead,
  calculatePercentiles,
  printOverheadStats,
  resetOverheads,
  overheads,
  MOCK_LATENCY_MS,
  sampleLogNormalLength,
  generateLogNormalString,
});

if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('beforeExit', () => {
    if (overheads.length > 0) {
      printOverheadStats();
    }
  });
}
