-- Block 36: OAuth Infrastructure — OAuth account linking
create table if not exists oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  provider_email text not null,
  access_token_encrypted text not null,
  raw_profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);

create index if not exists idx_oauth_accounts_user_id on oauth_accounts (user_id);
