-- Block 19: User identity — users + per-user provider keys
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  password_hash text not null,     -- scrypt saltHex:keyHex from crypto.ts
  gateway_api_key_hash text not null unique,  -- sha256Hex of the gateway API key issued at registration
  created_at timestamptz not null default now()
);

create index if not exists idx_users_username on users (username);
create index if not exists idx_users_email on users (email);

create table if not exists user_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,          -- openai, anthropic, groq, gemini, etc.
  ciphertext bytea not null,       -- AES-256-GCM encrypted provider key
  iv bytea not null,
  auth_tag bytea not null,
  fingerprint text not null,       -- sha256Hex(user_id + ':' + provider) for lookup without decrypting
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_provider_keys_user_provider on user_provider_keys (user_id, provider);
create unique index if not exists idx_user_provider_keys_fingerprint on user_provider_keys (fingerprint);
