-- Block 34: Organizations & team key pools
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists org_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
