-- Block 41: OAuth sign-in (Google, GitHub) + email OTP verification.

-- OAuth-only accounts never set a password: `null` means "no password login".
-- Password login must treat null as a mismatch, not crash.
alter table users alter column password_hash drop not null;

-- Proof the address was verified. Email/password signup sets it when the OTP is
-- accepted; OAuth signup sets it from the provider's verified email claim.
alter table users add column if not exists email_verified_at timestamptz;

-- Accounts created before this migration have no OTP record but have been in
-- use; treat them as verified so nobody is locked out on deploy.
update users set email_verified_at = now() where email_verified_at is null;

-- Case-insensitive uniqueness: `Alice@x.com` and `alice@x.com` are one person.
-- If this fails, duplicate rows exist and must be merged before re-running.
create unique index if not exists idx_users_email_lower on users (lower(email));

-- Pending email signups. The account row is created only after the code is
-- accepted, so unverified addresses never occupy `users.username` / `users.email`.
-- The password is stored as a scrypt hash here, never in plaintext.
create table if not exists email_verifications (
  email text primary key,                    -- lowercased at the edge
  username text not null,
  password_hash text not null,               -- scrypt saltHex:keyHex
  code_hash text not null,                   -- HMAC-SHA256(pepper, email:code)
  attempts integer not null default 0,
  expires_at timestamptz not null,
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_email_verifications_expires_at on email_verifications (expires_at);
