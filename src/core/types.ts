/** Canonical, provider-agnostic request/response shapes. */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string | null;
}

export interface CanonicalRequest {
  /** A hint, not a command. The router normally picks the model. */
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  response_format?: { type: 'text' | 'json_object' };
  stream?: boolean;
  user?: string;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'error';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Internal only. Never serialised into the OpenAI-shaped response body. */
  estimated?: boolean;
}

export interface CanonicalChoice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  created: number;
  choices: CanonicalChoice[];
  usage: Usage;
}

export interface CanonicalDelta {
  role?: Role;
  content?: string | null;
}

export interface CanonicalChunk {
  id: string;
  model: string;
  created: number;
  delta: CanonicalDelta;
  finish_reason: FinishReason | null;
  usage?: Usage;
}
