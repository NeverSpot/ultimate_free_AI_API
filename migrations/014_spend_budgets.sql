-- Block 14: User Spend Budget
-- Pre-dispatch atomic reserve of worst-case cost via Lua; reconcile against actual usage; release delta.
-- Reject with 429 before dispatch if cap would be exceeded. Zero upstream cost incurred on rejection.

create table if not exists spend_budgets (
  user_id uuid primary key,
  cap_usd numeric(12,6) not null,
  period text not null default 'monthly',
  reserved_usd numeric(12,6) not null default 0,
  spent_usd numeric(12,6) not null default 0,
  reset_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_spend_budgets_reset_at on spend_budgets (reset_at);
