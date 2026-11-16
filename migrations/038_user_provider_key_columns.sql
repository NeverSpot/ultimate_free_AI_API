-- Block 19 follow-up: align user_provider_keys with the documented schema.
-- `017_users.sql` omitted `label` and `active`, but the provider-key model and
-- the live database expect them. Both statements are idempotent so databases
-- created before this migration are repaired in place.
alter table user_provider_keys
  add column if not exists label text not null default '';

alter table user_provider_keys
  add column if not exists active boolean not null default true;

create index if not exists idx_user_provider_keys_active
  on user_provider_keys (user_id, active);
