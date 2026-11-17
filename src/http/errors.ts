import { ProviderError, type ErrorKind } from '../core/errors';

export interface ErrorBody {
  message: string;
  type: string;
  code: string;
  param: string | null;
}

export interface ErrorEnvelopeBody {
  error: ErrorBody;
}

/** An HTTP-boundary failure with a known taxonomy kind. */
export class ApiError extends Error {
  readonly kind: ErrorKind;
  readonly param: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    kind: ErrorKind,
    message: string,
    options: {
      param?: string | null;
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.kind = kind;
    this.param = options.param ?? null;
    this.headers = options.headers ?? {};
  }

  get status(): number {
    return statusFor(this.kind);
  }

  get type(): string {
    return typeFor(this.kind);
  }

  get code(): string {
    return codeFor(this.kind);
  }
}

export function statusFor(kind: ErrorKind): number {
  switch (kind) {
    case 'client':
      return 400;
    case 'conflict':
      return 409;
    case 'auth':
      return 401;
    case 'not_found':
      return 404;
    case 'model_gone':
      return 404;
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'upstream':
      return 502;
    case 'too_long':
      return 400;
    case 'blocked':
      return 400;
    case 'unsupported':
      return 501;
    case 'exhausted':
      return 503;
  }
}

export function typeFor(kind: ErrorKind): string {
  switch (kind) {
    case 'client':
    case 'conflict':
    case 'not_found':
    case 'model_gone':
    case 'too_long':
    case 'blocked':
    case 'unsupported':
      return 'invalid_request_error';
    case 'auth':
      return 'authentication_error';
    case 'rate_limited':
      return 'rate_limit_error';
    case 'exhausted':
      return 'service_unavailable';
    case 'timeout':
    case 'upstream':
      return 'api_error';
  }
}

export function codeFor(kind: ErrorKind): string {
  switch (kind) {
    case 'client':
      return 'invalid_request';
    case 'conflict':
      return 'key_already_registered';
    case 'not_found':
      return 'not_found';
    case 'auth':
      return 'invalid_api_key';
    case 'model_gone':
      return 'model_not_found';
    case 'rate_limited':
      return 'rate_limited';
    case 'timeout':
      return 'timeout';
    case 'upstream':
      return 'upstream_error';
    case 'too_long':
      return 'context_length_exceeded';
    case 'blocked':
      return 'content_filter';
    case 'unsupported':
      return 'unsupported';
    case 'exhausted':
      return 'exhausted';
  }
}

export function envelopeOf(
  message: string,
  type: string,
  code: string,
  param: string | null = null,
): ErrorEnvelopeBody {
  return { error: { message, type, code, param } };
}

/** Convert any thrown value into the one error shape this API ever returns. */
export function toEnvelope(error: unknown): ErrorEnvelopeBody {
  if (error instanceof ApiError) {
    return envelopeOf(error.message, error.type, error.code, error.param);
  }

  if (error instanceof ProviderError) {
    return envelopeOf(error.message, typeFor(error.kind), codeFor(error.kind), null);
  }

  if (isFastifyError(error)) {
    if (error.validation !== undefined || statusForError(error) < 500) {
      return envelopeOf(error.message, typeFor('client'), codeFor('client'), null);
    }
  }

  return envelopeOf('internal server error', 'api_error', 'internal_error', null);
}

export function statusForError(error: unknown): number {
  if (error instanceof ApiError) {
    return error.status;
  }

  if (error instanceof ProviderError) {
    return statusFor(error.kind);
  }

  if (isFastifyError(error)) {
    if (error.validation !== undefined) {
      return 400;
    }
    if (
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode <= 599
    ) {
      return error.statusCode;
    }
  }

  return 500;
}

export function headersForError(error: unknown): Record<string, string> {
  if (error instanceof ApiError) {
    return { ...error.headers };
  }

  if (error instanceof ProviderError && error.retryAfterMs !== undefined) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
    return { 'retry-after': String(seconds) };
  }

  return {};
}

interface FastifyLikeError {
  message: string;
  statusCode?: number;
  validation?: unknown;
}

function isFastifyError(error: unknown): error is FastifyLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}
