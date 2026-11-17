-- Store the gateway API key reversibly (AES-256-GCM) so login can re-issue it.
--
-- `gateway_api_key_hash` (sha256) stays the O(1) auth lookup. The ciphertext is
-- what lets the server hand the SAME key back on every login, so a user does not
-- lose their key by signing out, switching devices, or clearing localStorage.
--
-- Rows created before this migration have NULL here. They keep their current key
-- (the hash is untouched) and login simply omits it; only an explicit "Get New"
-- backfills these three columns with a freshly rotated key.
alter table users
  add column if not exists gateway_api_key_enc bytea,
  add column if not exists gateway_api_key_iv bytea,
  add column if not exists gateway_api_key_auth_tag bytea;