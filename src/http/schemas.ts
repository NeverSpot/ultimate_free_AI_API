import { Type, type Static } from '@sinclair/typebox';

/**
 * HTTP schemas. These are both validators and serialisation whitelists:
 * `fast-json-stringify` drops any field not declared here, which is how provider
 * payloads stop leaking to clients.
 *
 * Objects are intentionally permissive (no `additionalProperties: false`): a stock
 * OpenAI client sends `seed`, `presence_penalty`, `store`, and friends. The route's
 * `assertSupported()` decides which of those must be rejected loudly.
 */

export const ChatMessageSchema = Type.Object({
  role: Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('assistant')]),
  content: Type.Union([Type.String(), Type.Null()]),
});

export const ChatRequest = Type.Object({
  model: Type.Optional(Type.String()),
  messages: Type.Array(ChatMessageSchema, { minItems: 1 }),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  top_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  stop: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1, maxItems: 4 })]),
  ),
  response_format: Type.Optional(
    Type.Union([
      Type.Object({ type: Type.Literal('text') }),
      Type.Object({ type: Type.Literal('json_object') }),
    ]),
  ),
  stream: Type.Optional(Type.Boolean()),
  user: Type.Optional(Type.String()),
});

export const ChatResponseMessage = Type.Object({
  role: Type.Literal('assistant'),
  content: Type.Union([Type.String(), Type.Null()]),
});

export const ChatChoice = Type.Object({
  index: Type.Integer(),
  message: ChatResponseMessage,
  finish_reason: Type.Union([
    Type.Literal('stop'),
    Type.Literal('length'),
    Type.Literal('content_filter'),
    Type.Literal('error'),
  ]),
});

export const UsageSchema = Type.Object({
  prompt_tokens: Type.Integer(),
  completion_tokens: Type.Integer(),
  total_tokens: Type.Integer(),
});

export const ChatResponse = Type.Object({
  id: Type.String(),
  object: Type.Literal('chat.completion'),
  created: Type.Integer(),
  model: Type.String(),
  choices: Type.Array(ChatChoice),
  usage: UsageSchema,
});

export const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('down')]),
  checks: Type.Object({
    // 'unknown' means the probe is not wired yet. It must never default to 'ok':
    // a health check that asserts an unchecked dependency is a fabricated signal.
    redis: Type.Union([
      Type.Literal('ok'),
      Type.Literal('degraded'),
      Type.Literal('down'),
      Type.Literal('unknown'),
    ]),
    postgres: Type.Union([
      Type.Literal('ok'),
      Type.Literal('degraded'),
      Type.Literal('down'),
      Type.Literal('unknown'),
    ]),
  }),
  version: Type.String(),
  uptime_s: Type.Number(),
});

export const RegisterRequest = Type.Object({
  username: Type.String(),
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 8 }),
});

export const RegisterResponse = Type.Object({
  user: Type.Object({
    id: Type.String(),
    username: Type.String(),
    email: Type.String(),
  }),
  gateway_api_key: Type.String(),
});

export const LoginRequest = Type.Object({
  username: Type.String(),
  password: Type.String(),
});

export const LoginResponse = Type.Object({
  userId: Type.String(),
  username: Type.String(),
});

export const RegenerateKeyRequest = Type.Object({
  username: Type.String(),
  password: Type.String(),
});

export const RegenerateKeyResponse = Type.Object({
  gateway_api_key: Type.String(),
});

export const ProviderKeyRequest = Type.Object({
  provider: Type.String(),
  label: Type.String(),
  provider_key: Type.String(),
});

export const ProviderKeyResponse = Type.Object({
  id: Type.String(),
  user_id: Type.String(),
  provider: Type.String(),
  label: Type.String(),
  fingerprint: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export const ProviderKeyListItem = Type.Omit(ProviderKeyResponse, ['fingerprint']);
export const ProviderKeyList = Type.Array(ProviderKeyListItem);

export const ErrorEnvelope = Type.Object({
  error: Type.Object({
    message: Type.String(),
    type: Type.String(),
    code: Type.String(),
    param: Type.Union([Type.String(), Type.Null()]),
  }),
});

export type ChatRequestType = Static<typeof ChatRequest>;
export type ChatResponseType = Static<typeof ChatResponse>;
export type HealthResponseType = Static<typeof HealthResponse>;
export type ErrorEnvelopeType = Static<typeof ErrorEnvelope>;

export type RegisterRequestType = Static<typeof RegisterRequest>;
export type RegisterResponseType = Static<typeof RegisterResponse>;
export type LoginRequestType = Static<typeof LoginRequest>;
export type LoginResponseType = Static<typeof LoginResponse>;
export type RegenerateKeyRequestType = Static<typeof RegenerateKeyRequest>;
export type RegenerateKeyResponseType = Static<typeof RegenerateKeyResponse>;
export type ProviderKeyRequestType = Static<typeof ProviderKeyRequest>;
export type ProviderKeyResponseType = Static<typeof ProviderKeyResponse>;
export type ProviderKeyListItemType = Static<typeof ProviderKeyListItem>;
export type ProviderKeyListType = Static<typeof ProviderKeyList>;
