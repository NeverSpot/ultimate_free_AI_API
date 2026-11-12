import { readFileSync } from 'node:fs';
import type { RoutingStore } from './store';

export type JsonStoreInput =
  string | Record<string, number | Record<string, number>> | Map<string, number>;

/**
 * Built-in default static JSON routing scores.
 * Used when no configuration is passed.
 */
const DEFAULT_STATIC_SCORES: Record<string, number> = {
  'mock-model': 0.8,
  'openrouter/anthropic/claude-3.5-sonnet': 0.95,
  'openrouter/openai/gpt-4o': 0.92,
  'nvidia/meta/llama-3.1-70b-instruct': 0.88,
  'tokenharbor/mistral-large': 0.85,
};

/**
 * Static JSON routing store.
 * Reads hand-written static routing tables from JSON files or in-memory objects.
 */
export class JsonRoutingStore implements RoutingStore {
  private readonly flatScores = new Map<string, number>();
  private readonly bucketScores = new Map<string, Map<string, number>>();

  constructor(input?: JsonStoreInput) {
    if (input === undefined) {
      this.loadFlat(DEFAULT_STATIC_SCORES);
      return;
    }

    if (input instanceof Map) {
      for (const [k, v] of input.entries()) {
        this.flatScores.set(k, v);
      }
      return;
    }

    let parsed: Record<string, unknown>;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } else {
        const fileContent = readFileSync(input, 'utf8');
        parsed = JSON.parse(fileContent) as Record<string, unknown>;
      }
    } else {
      parsed = input as Record<string, unknown>;
    }

    this.loadObject(parsed);
  }

  private loadFlat(scores: Record<string, number>): void {
    for (const [k, v] of Object.entries(scores)) {
      if (typeof v === 'number') {
        this.flatScores.set(k, v);
      }
    }
  }

  private loadObject(obj: Record<string, unknown>): void {
    let hasBuckets = false;

    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'number') {
        this.flatScores.set(key, val);
      } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        hasBuckets = true;
        const bucketMap = new Map<string, number>();
        for (const [modelKey, scoreVal] of Object.entries(val as Record<string, unknown>)) {
          if (typeof scoreVal === 'number') {
            bucketMap.set(modelKey, scoreVal);
          }
        }
        this.bucketScores.set(key, bucketMap);
      }
    }

    // If bucket 'general' exists and flat is empty, populate flat from general
    if (hasBuckets && this.flatScores.size === 0) {
      const general = this.bucketScores.get('general');
      if (general) {
        for (const [k, v] of general.entries()) {
          this.flatScores.set(k, v);
        }
      }
    }
  }

  getScoresSync(bucket?: string): Map<string, number> {
    if (bucket && this.bucketScores.has(bucket)) {
      // Merge flatScores as fallback with bucketScores
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
