-- Block 35: Team-Level Spend Caps
-- Per-organization spend ceiling.
-- Self-contained on master: org_id has NO foreign key to `organizations`
-- because that table (Block 34) is not merged yet.
create table if not exists org_spend_caps (
  org_id text not null,
  period text not null check (period in ('daily', 'monthly')),
  cap_usd numeric(12, 4) not null check (cap_usd >= 0),
  created_at timestamptz not null default now(),
  primary key (org_id, period)
);

create index if not exists idx_org_spend_caps_org_id on org_spend_caps (org_id);
