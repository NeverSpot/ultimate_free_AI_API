-- Atomic multi-window reservation.
--
-- KEYS = keys of the enforced windows only.
-- ARGV = cost, then one limit per key, then one ttlMs per key.
--
-- Loop over every window before deciding: the refusal that wins is the one with the
-- longest wait, not the first one encountered. Nothing is incremented unless every
-- window has room.

local cost = tonumber(ARGV[1])
local count = #KEYS
local maxWait = 0
local blockIndex = 0
local created = {}

for i = 1, count do
  local key = KEYS[i]
  local limit = tonumber(ARGV[1 + i])
  local ttlMs = tonumber(ARGV[1 + count + i])
  local raw = redis.call('GET', key)
  local used = tonumber(raw or '0') or 0
  created[i] = (raw == false)

  if limit ~= nil and used + cost > limit then
    local wait = redis.call('PTTL', key)
    if wait < 0 then
      -- No TTL (or no key): the full window is the only floor available.
      wait = ttlMs
    end
    wait = math.max(1, wait)
    if wait > maxWait then
      maxWait = wait
      blockIndex = i
    end
  end
end

if blockIndex > 0 then
  return { 0, blockIndex, maxWait }
end

for i = 1, count do
  redis.call('INCRBY', KEYS[i], cost)
  if created[i] then
    redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[1 + count + i]))
  end
end

return { 1, 0, 0 }
