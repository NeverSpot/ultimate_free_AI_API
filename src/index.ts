import { loadConfig } from './config/env';
import { createDbClient } from './db/client';
import { createGatewayKeyAuth } from './http/middleware/gateway-key-auth';
import { buildServer } from './http/server';
import { createUserModel } from './models/user';
import { createUserProviderKeyModel } from './models/user-provider-key';
import { createEmailVerificationModel } from './models/email-verification';
import { createOAuthAccountModel } from './models/oauth-account';
import { createMailer } from './lib/mailer';
import { createUsageModel } from './models/usage';
import { AccountingStore } from './telemetry/store';
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
  // Reversible storage of the gateway key: lets login re-issue the same key
  // instead of forcing a "Get New" + password re-entry.
  const userStore = createUserModel(db, config.encryptionKey);
  const providerKeyStore = createUserProviderKeyModel(db, config.encryptionKey);
  const emailVerificationStore = createEmailVerificationModel(db);
  const oauthAccounts = createOAuthAccountModel(db, config.encryptionKey);
  // Request accounting feeds the keys dashboard's usage strip. Batched so a
  // chat response never waits on an insert; flushed and closed on shutdown.
  const usageStore = createUsageModel(db);
  const accountingStore = new AccountingStore(db, {
    batchSize: 25,
    flushIntervalMs: 2_000,
  });
  const mailer = createMailer({
    transport: config.mailTransport ?? 'console',
    from: config.mailFrom ?? 'Ultimate Free AI <no-reply@localhost>',
    ...(config.smtpHost !== undefined
      ? {
          smtp: {
            host: config.smtpHost,
            port: config.smtpPort ?? 587,
            secure: config.smtpSecure ?? false,
            ...(config.smtpUser !== undefined && config.smtpPass !== undefined
              ? { user: config.smtpUser, pass: config.smtpPass }
              : {}),
          },
        }
      : {}),
    ...(config.resendApiKey !== undefined ? { resendApiKey: config.resendApiKey } : {}),
  });
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
    usageStore,
    accountingStore,
    providerKeyStore,
    emailVerificationStore,
    oauthAccounts,
    mailer,
    gatewayKeyAuth,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await accountingStore.close();
    await db.close();
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
