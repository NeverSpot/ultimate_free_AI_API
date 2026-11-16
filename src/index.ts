import { loadConfig } from './config/env';
import { createDbClient } from './db/client';
import { createGatewayKeyAuth } from './http/middleware/gateway-key-auth';
import { buildServer } from './http/server';
import { createUserModel } from './models/user';
import { createUserProviderKeyModel } from './models/user-provider-key';
import { MockProviderAdapter } from './providers/mock';
import { defaultAdapters } from './providers/defaults';
import type { Credential } from './providers/types';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // Phase A wiring: one deterministic mock credential until Block 3 lands the pool.
  const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
  const credential: Credential = {
    id: 'mock-credential',
    provider: provider.id,
    secret: 'mock-secret',
  };

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const db = createDbClient(databaseUrl);
  const userStore = createUserModel(db);
  const providerKeyStore = createUserProviderKeyModel(db, config.encryptionKey);
  const gatewayKeyAuth = createGatewayKeyAuth({
    adminToken: config.adminToken,
    findUserByGatewayKey: (hash) => userStore.findByGatewayApiKeyHash(hash),
  });

  const app = buildServer({
    config,
    provider,
    credential,
    // Real provider adapters so BYOK credentials (openrouter/nvidia/tokenharbor)
    // resolve in the router. Without these, every real provider is silently
    // skipped and chat fails with "All routing attempts failed".
    adapters: defaultAdapters(),
    logger: true,
    userStore,
    providerKeyStore,
    gatewayKeyAuth,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void main();
