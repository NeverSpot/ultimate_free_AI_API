const counters: Record<string, number> = {};
const latencies: number[] = [];

/**
 * Block 26: in-process Prometheus metrics for the gateway.
 *
 * Counters are keyed by label sets (e.g. `provider=mock,status=200`) and the
 * latency ring buffer caps memory at 10,000 observations. All state lives in
 * memory: process restarts reset the metrics, which is acceptable for Phase I.
 */
export function inc(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

export function observeLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > 10_000) latencies.shift();
}

export function getMetrics(): string {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  let out = '# HELP gateway_requests_total Total requests\n# TYPE gateway_requests_total counter\n';
  for (const [k, v] of Object.entries(counters)) {
    out += `gateway_requests_total{${k}} ${v}\n`;
  }
  out +=
    '# HELP gateway_latency_p95_ms P95 latency in ms\n# TYPE gateway_latency_p95_ms gauge\ngateway_latency_p95_ms ' +
    p95 +
    '\n';
  return out;
}

export function reset(): void {
  Object.keys(counters).forEach((k) => delete counters[k]);
  latencies.length = 0;
}
