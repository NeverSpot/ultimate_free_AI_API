-- Block 19: User registration, single gateway API key for life, per-user provider keys
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  gateway_api_key_hash text not null unique,
  gateway_api_key_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_username on users (username);
create index if not exists idx_users_email on users (email);
create index if not exists idx_users_gateway_api_key_hash on users (gateway_api_key_hash);

create table if not exists user_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  label text not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  fingerprint text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_provider_keys_user_id on user_provider_keys (user_id);
create index if not exists idx_user_provider_keys_user_provider on user_provider_keys (user_id, provider);
create index if not exists idx_user_provider_keys_fingerprint on user_provider_keys (fingerprint);
