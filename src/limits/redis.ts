import Redis from 'ioredis';

/** A Lua script registered on the client; args are forwarded verbatim to EVALSHA. */
export interface LedgerCommand {
  (...args: Array<string | number>): Promise<unknown>;
}

export interface LedgerCommandDefinition {
  lua: string;
  numberOfKeys?: number;
}

/**
 * The subset of the Redis client the ledger depends on.
 *
 * Library code takes this interface, never a concrete `ioredis` instance, so the ledger
 * can be unit-tested with a fake that refuses to be called. `defineCommand` returns the
 * callable instead of mutating the client's static type, which keeps the seam narrow.
 */
export interface LedgerClient {
  defineCommand(name: string, definition: LedgerCommandDefinition): LedgerCommand;
  disconnect(): void;
}

/**
 * Build a real Redis client from an explicit URL.
 *
 * Deliberately does not read `process.env`: callers pass `REDIS_URL` in from the edge,
 * matching `createDbClient`.
 */
export function createLedgerClient(
  url: string,
  options: { connectTimeoutMs?: number } = {},
): LedgerClient {
  const connectionString = url.trim();
  if (connectionString.length === 0) {
    throw new Error('createLedgerClient: a non-empty connection string is required');
  }

  const redis = new Redis(connectionString, {
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    maxRetriesPerRequest: 1,
  });

  return {
    defineCommand(name, definition) {
      redis.defineCommand(name, definition);

      // ioredis installs the generated EVALSHA wrapper on the instance; bind it so the
      // caller can invoke it without depending on the concrete Redis type.
      const commands = redis as unknown as Record<string, LedgerCommand | undefined>;
      const command = commands[name];
      if (command === undefined) {
        throw new Error(`createLedgerClient: command "${name}" was not registered`);
      }
      return command.bind(redis);
    },
    disconnect() {
      redis.disconnect();
    },
  };
}
