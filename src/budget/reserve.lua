-- Block 14: User Spend Budget
-- Atomic reserve, reconcile, release, set, and get against Redis budget ledger.

local action = ARGV[1]
local worstCaseUsd = 0
local reservationId = ''
local ttlSec = 300
local defaultCap = -1

-- Support direct numeric invocation: if ARGV[1] is a number, action is reserve
if tonumber(action) ~= nil then
  worstCaseUsd = tonumber(action)
  action = 'reserve'
  reservationId = ARGV[2] or ''
  ttlSec = tonumber(ARGV[3]) or 300
  defaultCap = tonumber(ARGV[4]) or -1
elseif action == 'reserve' then
  worstCaseUsd = tonumber(ARGV[2]) or 0
  reservationId = ARGV[3] or ''
  ttlSec = tonumber(ARGV[4]) or 300
  defaultCap = tonumber(ARGV[5]) or -1
end

if action == 'reserve' then
  local rawCap = redis.call('HGET', KEYS[1], 'cap_usd')
  if rawCap == false then
    if defaultCap >= 0 then
      redis.call('HSET', KEYS[1], 'cap_usd', tostring(defaultCap), 'spent_usd', '0', 'reserved_usd', '0')
      rawCap = tostring(defaultCap)
    else
      return { 0, '0', '0', '0', 'no_budget' }
    end
  end

  local cap = tonumber(rawCap) or 0
  local spent = tonumber(redis.call('HGET', KEYS[1], 'spent_usd') or '0') or 0
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved_usd') or '0') or 0

  local remaining = cap - (spent + reserved)

  -- Check if cap would be exceeded (with small epsilon for float precision)
  if (spent + reserved + worstCaseUsd) - cap > 1e-9 then
    return { 0, tostring(remaining), tostring(cap), tostring(reserved), 'budget_exceeded' }
  end

  local newReserved = reserved + worstCaseUsd
  redis.call('HSET', KEYS[1], 'reserved_usd', tostring(newReserved))

  if #KEYS >= 2 and KEYS[2] ~= '' and reservationId ~= '' then
    redis.call('SETEX', KEYS[2], ttlSec, tostring(worstCaseUsd))
  end

  local newRemaining = cap - (spent + newReserved)
  return { 1, tostring(newRemaining), tostring(cap), tostring(newReserved), reservationId }

elseif action == 'reconcile' then
  local resId = ARGV[2] or ''
  local actualUsd = tonumber(ARGV[3]) or 0

  local reservedAmount = 0
  if #KEYS >= 2 and KEYS[2] ~= '' then
    local rawReserved = redis.call('GET', KEYS[2])
    if rawReserved ~= false then
      reservedAmount = tonumber(rawReserved) or 0
      redis.call('DEL', KEYS[2])
    end
  end

  local cap = tonumber(redis.call('HGET', KEYS[1], 'cap_usd') or '0') or 0
  local spent = tonumber(redis.call('HGET', KEYS[1], 'spent_usd') or '0') or 0
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved_usd') or '0') or 0

  local newSpent = spent + actualUsd
  local newReserved = math.max(0, reserved - reservedAmount)

  redis.call('HSET', KEYS[1], 'spent_usd', tostring(newSpent), 'reserved_usd', tostring(newReserved))

  local newRemaining = cap - (newSpent + newReserved)
  return { 1, tostring(newRemaining), tostring(newSpent), tostring(newReserved), tostring(reservedAmount) }

elseif action == 'release' then
  local resId = ARGV[2] or ''

  local reservedAmount = 0
  if #KEYS >= 2 and KEYS[2] ~= '' then
    local rawReserved = redis.call('GET', KEYS[2])
    if rawReserved ~= false then
      reservedAmount = tonumber(rawReserved) or 0
      redis.call('DEL', KEYS[2])
    end
  end

  local cap = tonumber(redis.call('HGET', KEYS[1], 'cap_usd') or '0') or 0
  local spent = tonumber(redis.call('HGET', KEYS[1], 'spent_usd') or '0') or 0
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved_usd') or '0') or 0

  local newReserved = math.max(0, reserved - reservedAmount)
  redis.call('HSET', KEYS[1], 'reserved_usd', tostring(newReserved))

  local newRemaining = cap - (spent + newReserved)
  return { 1, tostring(newRemaining), tostring(spent), tostring(newReserved), tostring(reservedAmount) }

elseif action == 'set' then
  local cap = tostring(ARGV[2] or '0')
  local spent = tostring(ARGV[3] or '0')
  local reserved = tostring(ARGV[4] or '0')

  redis.call('HSET', KEYS[1], 'cap_usd', cap, 'spent_usd', spent, 'reserved_usd', reserved)
  return { 1, cap, spent, reserved }

elseif action == 'get' then
  local cap = redis.call('HGET', KEYS[1], 'cap_usd')
  if cap == false then
    return { 0, '0', '0', '0', 'not_found' }
  end
  local spent = redis.call('HGET', KEYS[1], 'spent_usd') or '0'
  local reserved = redis.call('HGET', KEYS[1], 'reserved_usd') or '0'
  local remaining = tonumber(cap) - (tonumber(spent) + tonumber(reserved))
  return { 1, tostring(remaining), tostring(cap), tostring(spent), tostring(reserved) }

elseif action == 'reset' then
  redis.call('HSET', KEYS[1], 'spent_usd', '0', 'reserved_usd', '0')
  return { 1 }

else
  return { 0, '0', '0', '0', 'unknown_action' }
end
