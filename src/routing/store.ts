/**
 * RoutingStore interface.
 *
 * Source of truth: PROJECT.md §304-310 and docs/phase-c-plan.md Block 13.
 * Represents a persistent or static source of model quality / task-fit scores.
 */

export interface RoutingStore {
  /**
   * Return model scores mapping (modelId -> 0..1 score).
   * Optional bucket parameter allows task-specific score lookups ('code', 'math', 'general', etc.).
   */
  getScores(bucket?: string): Promise<Map<string, number>>;

  /**
   * Synchronous accessor for in-memory / pre-loaded scores.
   * Enables synchronous pure-function evaluation in route().
   */
  getScoresSync?(bucket?: string): Map<string, number>;
}
