import type { CanonicalRequest, CanonicalResponse } from '../core/types';

/** Opaque provider identifier. Never a closed union: adding a provider must not edit this. */
export type ProviderId = string;

export interface Credential {
  id: string;
  provider: ProviderId;
  secret: string;
  label?: string;
}

export interface ModelInfo {
  id: string;
  provider?: ProviderId;
  owned_by?: string;
  context_window?: number | null;
  is_free?: boolean | null;
}

/**
 * The one interface every provider implements.
 *
 * `chat` takes a credential rather than reading a global key: that parameter is
 * what makes a pool of keys possible later.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly supportsStreaming: boolean;
  chat(req: CanonicalRequest, cred: Credential, signal?: AbortSignal): Promise<CanonicalResponse>;
  listModels(cred: Credential): Promise<ModelInfo[]>;
}
