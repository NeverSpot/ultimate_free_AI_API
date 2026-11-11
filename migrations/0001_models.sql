-- Block 5: the discovered model catalog.
--
-- is_free is deliberately nullable: null means "unknown" (for example NVIDIA NIM),
-- never "paid". A refresh only touches rows it rediscovered, so a provider outage
-- leaves the last-known-good rows in place.
create table if not exists models (
  provider text not null,
  model_id text not null,
  context_window int,
  is_free boolean,
  owned_by text,
  rpm_limit int,
  tpm_limit int,
  rpd_limit int,
  healthy boolean not null default true,
  checked_at timestamptz not null,
  primary key (provider, model_id)
);

create index if not exists idx_models_provider_is_free on models (provider, is_free);
create index if not exists idx_models_checked_at on models (checked_at);
