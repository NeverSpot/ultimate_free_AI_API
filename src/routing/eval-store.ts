import { existsSync, readFileSync } from 'node:fs';
import type { RoutingStore } from './store';

export type EvalStoreInput = string | Record<string, unknown> | Map<string, number>;

/**
 * Built-in default eval scores when no eval output is supplied.
 */
const DEFAULT_EVAL_SCORES: Record<string, number> = {
  'mock-model': 0.8,
  'openrouter/anthropic/claude-3.5-sonnet': 0.95,
  'openrouter/openai/gpt-4o': 0.92,
  'nvidia/meta/llama-3.1-70b-instruct': 0.88,
  'tokenharbor/mistral-large': 0.85,
};

/**
 * Routing store backed by Eval Harness output scores.
 * Parses either JSON eval reports or markdown summary tables (with n stated per cell).
 */
export class EvalRoutingStore implements RoutingStore {
  private readonly flatScores = new Map<string, number>();
  private readonly bucketScores = new Map<string, Map<string, number>>();

  constructor(input?: EvalStoreInput) {
    if (input === undefined) {
      // Check if eval results file exists on disk
      const candidatePaths = ['src/eval/results.json', 'eval-results.json', 'eval-results.md'];
      let foundPath: string | undefined;
      for (const p of candidatePaths) {
        if (existsSync(p)) {
          foundPath = p;
          break;
        }
      }
      if (foundPath) {
        this.loadFromString(readFileSync(foundPath, 'utf8'));
      } else {
        this.loadFlat(DEFAULT_EVAL_SCORES);
      }
      return;
    }

    if (input instanceof Map) {
      for (const [k, v] of input.entries()) {
        this.flatScores.set(k, v);
      }
      return;
    }

    if (typeof input === 'string') {
      const trimmed = input.trim();
      // If it looks like JSON or markdown table
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('|')) {
        this.loadFromString(trimmed);
      } else if (existsSync(input)) {
        this.loadFromString(readFileSync(input, 'utf8'));
      } else {
        // Try parsing string directly
        this.loadFromString(trimmed);
      }
      return;
    }

    this.loadObject(input);
  }

  private loadFlat(scores: Record<string, number>): void {
    for (const [k, v] of Object.entries(scores)) {
      if (typeof v === 'number') {
        this.flatScores.set(k, v);
      }
    }
  }

  private loadFromString(text: string): void {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        this.loadObject(parsed);
        return;
      } catch {
        // fallback to markdown or line parsing
      }
    }

    if (trimmed.includes('|')) {
      this.loadMarkdownTable(trimmed);
      return;
    }

    // Attempt JSON parse fallback
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      this.loadObject(parsed);
    } catch {
      // If unparseable, leave empty or default
    }
  }

  /**
   * Parse markdown table output from eval harness.
   * Example:
   * | Model | JSON Extraction | Math | Code Generation | Pass@1 |
   * | --- | --- | --- | --- | --- |
   * | gpt-4o | 0.95 (n=3) | 0.90 (n=3) | 0.92 (n=3) | 0.92 |
   */
  private loadMarkdownTable(markdown: string): void {
    const lines = markdown
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && l.endsWith('|'));

    if (lines.length < 2) return;

    // Header row
    const headerLine = lines[0]!;
    const headers = headerLine
      .split('|')
      .slice(1, -1)
      .map((h) => h.trim().toLowerCase());

    // Skip delimiter row (index 1 if it contains dashes)
    const startRow = lines[1]?.includes('---') ? 2 : 1;

    for (let r = startRow; r < lines.length; r++) {
      const rowLine = lines[r]!;
      const cells = rowLine
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());

      if (cells.length === 0) continue;
      const modelId = cells[0];
      if (!modelId) continue;

      let overallScore: number | undefined;
      const modelBucketScores = new Map<string, number>();

      for (let c = 1; c < cells.length; c++) {
        const header = headers[c] ?? `col_${c}`;
        const cellValue = cells[c] ?? '';
        // Extract first float number like 0.95 from "0.95 (n=3)"
        const match = cellValue.match(/(\d+(?:\.\d+)?)/);
        if (match && match[1]) {
          const num = parseFloat(match[1]);
          if (!isNaN(num)) {
            if (
              header === 'overall' ||
              header === 'pass@1' ||
              header === 'average' ||
              header === 'score'
            ) {
              overallScore = num;
            } else {
              modelBucketScores.set(header, num);
              if (!this.bucketScores.has(header)) {
                this.bucketScores.set(header, new Map<string, number>());
              }
              this.bucketScores.get(header)!.set(modelId, num);
            }
          }
        }
      }

      // If no explicit overall score, average bucket scores
      if (overallScore === undefined && modelBucketScores.size > 0) {
        let sum = 0;
        for (const s of modelBucketScores.values()) {
          sum += s;
        }
        overallScore = sum / modelBucketScores.size;
      }

      if (overallScore !== undefined) {
        this.flatScores.set(modelId, overallScore);
      }
    }
  }

  private loadObject(obj: Record<string, unknown>): void {
    if (Array.isArray(obj)) {
      // Array of results: [{ model, score }, ...]
      for (const item of obj) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const model = String(rec['model'] ?? rec['modelId'] ?? rec['id'] ?? '');
          const score = Number(rec['score'] ?? rec['passRate'] ?? rec['pass_at_1'] ?? 0);
          if (model && !isNaN(score)) {
            this.flatScores.set(model, score);
          }
        }
      }
      return;
    }

    // Check if it has a 'models' or 'results' key
    if (obj['models'] && typeof obj['models'] === 'object' && !Array.isArray(obj['models'])) {
      this.loadObject(obj['models'] as Record<string, unknown>);
      return;
    }
    if (obj['results'] && Array.isArray(obj['results'])) {
      this.loadObject(obj['results'] as unknown as Record<string, unknown>);
      return;
    }

    // Direct mapping
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'number') {
        this.flatScores.set(key, val);
      } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const bucketOrModel = val as Record<string, unknown>;
        // Could be model -> { bucket: score } or bucket -> { model: score }
        // If it has overall/pass@1/score, key is model
        if (typeof bucketOrModel['overall'] === 'number') {
          this.flatScores.set(key, bucketOrModel['overall']);
        } else if (typeof bucketOrModel['score'] === 'number') {
          this.flatScores.set(key, bucketOrModel['score']);
        } else {
          // Check if bucket -> { model: score }
          const innerMap = new Map<string, number>();
          for (const [innerK, innerV] of Object.entries(bucketOrModel)) {
            if (typeof innerV === 'number') {
              innerMap.set(innerK, innerV);
            }
          }
          this.bucketScores.set(key, innerMap);
        }
      }
    }

    // Populate flat scores from bucketScores if flat is empty
    if (this.flatScores.size === 0 && this.bucketScores.size > 0) {
      const general = this.bucketScores.get('general') ?? this.bucketScores.values().next().value;
      if (general) {
        for (const [k, v] of general.entries()) {
          this.flatScores.set(k, v);
        }
      }
    }
  }

  getScoresSync(bucket?: string): Map<string, number> {
    if (bucket && this.bucketScores.has(bucket)) {
      const result = new Map<string, number>(this.flatScores);
      const bucketMap = this.bucketScores.get(bucket)!;
      for (const [k, v] of bucketMap.entries()) {
        result.set(k, v);
      }
      return result;
    }
    return new Map<string, number>(this.flatScores);
  }

  async getScores(bucket?: string): Promise<Map<string, number>> {
    return this.getScoresSync(bucket);
  }
}
