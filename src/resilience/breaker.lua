-- Circuit-breaker scripts, one per transition path.
--
-- breaker.ts registers each body as a separate defineCommand, exactly the way the
-- ledger registers ledger.lua. A single asset carries all three so the build copies
-- one file.
--
-- Cooldown arithmetic reads Redis TIME inside the script on purpose: replicas with
-- skewed clocks must still agree on whether the cooldown has elapsed.

--@@script allow
--
-- KEYS[1] = br:{provider}:{model}
-- KEYS[2] = br:{provider}:{model}:f
-- ARGV    = windowMs, cooldownMs, probeLimit
--
-- Returns { allowed (0|1), stateCode (0 closed, 1 open, 2 half_open), retryAfterMs,
-- probesUsed }.

local windowMs = tonumber(ARGV[1])
local cooldownMs = tonumber(ARGV[2])
local probeLimit = tonumber(ARGV[3])

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = windowMs + cooldownMs

local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  -- No breaker has ever tripped for this target: the gate is open.
  return { 1, 0, 0, 0 }
end
if state ~= 'open' and state ~= 'half_open' then
  state = 'closed'
end

local openedAtMs = tonumber(redis.call('HGET', KEYS[1], 'openedAtMs') or '0') or 0
local probesUsed = tonumber(redis.call('HGET', KEYS[1], 'probesUsed') or '0') or 0
local probeStartedAtMs = tonumber(redis.call('HGET', KEYS[1], 'probeStartedAtMs') or '0') or 0

if state == 'open' then
  local elapsedMs = nowMs - openedAtMs
  if elapsedMs >= cooldownMs then
    -- Claim the first probe slot in the same atomic step that opens the gate, so a
    -- herd at cooldown expiry produces exactly one network call.
    redis.call('HSET', KEYS[1], 'state', 'half_open', 'probesUsed', 1, 'probeStartedAtMs', nowMs)
    redis.call('PEXPIRE', KEYS[1], ttl)
    redis.call('PEXPIRE', KEYS[2], ttl)
    return { 1, 2, 0, 1 }
  end

  local retryAfterMs = cooldownMs - elapsedMs
  if retryAfterMs < 1 then
    retryAfterMs = 1
  end
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { 0, 1, retryAfterMs, probesUsed }
end

if state == 'half_open' then
  -- The probe never reported back (a restart or a crash mid-probe). After a whole
  -- cooldown, reclaim the slot instead of denying this target forever.
  if nowMs - probeStartedAtMs >= cooldownMs then
    redis.call('HSET', KEYS[1], 'probesUsed', 1, 'probeStartedAtMs', nowMs)
    redis.call('PEXPIRE', KEYS[1], ttl)
    return { 1, 2, 0, 1 }
  end

  if probesUsed < probeLimit then
    probesUsed = probesUsed + 1
    redis.call('HSET', KEYS[1], 'probesUsed', probesUsed, 'probeStartedAtMs', nowMs)
    redis.call('PEXPIRE', KEYS[1], ttl)
    return { 1, 2, 0, probesUsed }
  end

  redis.call('PEXPIRE', KEYS[1], ttl)
  return { 0, 2, cooldownMs, probesUsed }
end

redis.call('PEXPIRE', KEYS[1], ttl)
return { 1, 0, 0, probesUsed }

--@@script recordFailure
--
-- KEYS[1] = br:{provider}:{model}
-- KEYS[2] = br:{provider}:{model}:f
-- ARGV    = windowMs, threshold, cooldownMs, nonce
--
-- Returns { tripped (0|1), openedAtMs }.
--
-- Sliding window: one ZSET member per failure, pruned by score on every write. A
-- success between failures never resets the count, which is why a provider failing a
-- steady 30% of requests still trips.

local windowMs = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local cooldownMs = tonumber(ARGV[3])
local nonce = ARGV[4]

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = windowMs + cooldownMs

local state = redis.call('HGET', KEYS[1], 'state')
local openedAtMs = tonumber(redis.call('HGET', KEYS[1], 'openedAtMs') or '0') or 0

if state == 'open' then
  -- A request that started before the trip failed after it. That says nothing about
  -- the probe, so the existing trip and its cooldown stand.
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { 0, openedAtMs }
end

if state == 'half_open' then
  -- The probe failed: a fresh cooldown starts now.
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'open',
    'openedAtMs',
    nowMs,
    'probesUsed',
    0,
    'probeStartedAtMs',
    0
  )
  redis.call('DEL', KEYS[2])
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { 1, nowMs }
end

redis.call('ZADD', KEYS[2], nowMs, nonce)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', nowMs - windowMs)
local failures = redis.call('ZCARD', KEYS[2])

if failures >= threshold then
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'open',
    'openedAtMs',
    nowMs,
    'probesUsed',
    0,
    'probeStartedAtMs',
    0
  )
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  return { 1, nowMs }
end

if not state then
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'closed',
    'openedAtMs',
    0,
    'probesUsed',
    0,
    'probeStartedAtMs',
    0
  )
end
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
return { 0, 0 }

--@@script recordSuccess
--
-- KEYS[1] = br:{provider}:{model}
-- KEYS[2] = br:{provider}:{model}:f
-- ARGV    = windowMs, cooldownMs
--
-- Returns { closedByProbe (0|1) }.
--
-- Only a half-open probe success closes the breaker. A success from a request that
-- started before the trip is a no-op even though it arrives while state is open; a
-- success while closed does not clear the sliding failure window.

local windowMs = tonumber(ARGV[1])
local cooldownMs = tonumber(ARGV[2])
local ttl = windowMs + cooldownMs

local state = redis.call('HGET', KEYS[1], 'state')
if not state then
  return { 0 }
end

if state == 'half_open' then
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'closed',
    'openedAtMs',
    0,
    'probesUsed',
    0,
    'probeStartedAtMs',
    0
  )
  redis.call('DEL', KEYS[2])
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { 1 }
end

redis.call('PEXPIRE', KEYS[1], ttl)
return { 0 }
