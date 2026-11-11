/**
 * The error taxonomy every provider adapter classifies into.
 *
 * `ErrorKind` is deliberately small: it names what the gateway can *do* about a
 * failure, not every status code an upstream might return.
 */
export type ErrorKind =
  | 'client'
  | 'auth'
  | 'model_gone'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'too_long'
  | 'blocked'
  | 'unsupported'
  | 'exhausted';

export interface ProviderErrorOptions {
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  cause?: unknown;
}

/**
 * An upstream failure already classified into the gateway taxonomy.
 *
 * Adapters throw this; the HTTP layer maps it to a status code and an OpenAI
 * error envelope. Keeping classification here means routes never inspect
 * provider-specific payloads.
 */
export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly provider?: string;

  constructor(kind: ErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.provider = options.provider;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        writable: true,
      });
    }
  }
}
