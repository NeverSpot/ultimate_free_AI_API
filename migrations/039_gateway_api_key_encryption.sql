-- Store the gateway API key reversibly (AES-256-GCM) so login can re-issue it.
--
-- `gateway_api_key_hash` (sha256) stays the O(1) auth lookup. The ciphertext is
-- what lets the server hand the SAME key back on every login, so a user never
-- loses their key by signing out, switching devices, or clearing localStorage —
-- and nobody has to click "Get New" + re-enter a password to recover it.
--
-- Rows created before this migration have NULL here; the first login after
-- upgrading issues a fresh key and backfills all three columns.
alter table users
  add column if not exists gateway_api_key_enc bytea,
  add column if not exists gateway_api_key_iv bytea,
  add column if not exists gateway_api_key_auth_tag bytea;