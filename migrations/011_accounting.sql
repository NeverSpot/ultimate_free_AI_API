-- Block 11: Accounting + Postgres
-- One row per terminal path (success, failure, timeout, aborted)
-- Two tables per PROJECT.md §255–288: requests + credentials

-- requests: one row per terminal path
create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,          -- gateway request id (x-request-id)
  gateway_key_id uuid,                      -- bare uuid; gateway_keys table deferred
  provider text not null,                   -- provider id (openrouter, nvidia, tokenharbor)
  model text not null,                      -- model id
  credential_id uuid,                       -- credential that was used
  task_bucket text,                         -- json_extraction | math | code_generation | structured_extraction
  status text not null,                     -- success | failed | timeout | aborted
  http_status int,                          -- upstream http status (null if no call made)
  prompt_tokens int,                        -- from usage
  completion_tokens int,                    -- from usage
  tokens_estimated boolean not null default false,
  cost_usd numeric(12,6) not null default 0, -- NUMERIC not FLOAT for money
  latency_ms int not null,                  -- total request latency
  ttft_ms int,                              -- time to first token (streaming)
  attempt_count int not null default 1,     -- how many candidates tried
  route_reason text,                        -- capacity | task_fit | spread | fallback
  error_kind text,                          -- from ProviderError.kind
  created_at timestamptz not null default now()
);

-- credentials: encrypted credential storage (Block 11 scope)
create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  label text not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  fingerprint text not null unique,  -- HMAC for lookup without decrypting
  status text not null default 'active',  -- active | quarantined | revoked
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- Indexes per PROJECT.md
create index if not exists idx_requests_created_at on requests (created_at);
create index if not exists idx_requests_provider_model_created on requests (provider, model, created_at);
create index if not exists idx_requests_gateway_key_created on requests (gateway_key_id, created_at);
create index if not exists idx_requests_credential_created on requests (credential_id, created_at);
create index if not exists idx_credentials_fingerprint on credentials (fingerprint);
create index if not exists idx_credentials_user_provider on credentials (user_id, provider);