import type { DbExecutor } from '../db/client';
import * as crypto from '../lib/crypto';

export interface OAuthAccount {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string;
  access_token_encrypted: string;
  raw_profile: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface NewOAuthAccount {
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string;
  access_token: string; // plaintext; encrypted at rest
  raw_profile: Record<string, unknown>;
}

function serializeEncryptedToken(token: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}): string {
  return JSON.stringify({
    ciphertext: token.ciphertext.toString('base64'),
    iv: token.iv.toString('base64'),
    authTag: token.authTag.toString('base64'),
  });
}

function deserializeEncryptedToken(value: string): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const parsed = JSON.parse(value);
  return {
    ciphertext: Buffer.from(parsed.ciphertext, 'base64'),
    iv: Buffer.from(parsed.iv, 'base64'),
    authTag: Buffer.from(parsed.authTag, 'base64'),
  };
}

function normalizeRawProfile(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapRow(row: Record<string, unknown>): OAuthAccount {
  return {
    id: String(row.id ?? ''),
    user_id: String(row.user_id ?? ''),
    provider: String(row.provider ?? ''),
    provider_user_id: String(row.provider_user_id ?? ''),
    provider_email: String(row.provider_email ?? ''),
    access_token_encrypted: String(row.access_token_encrypted ?? ''),
    raw_profile: normalizeRawProfile(row.raw_profile),
    created_at: new Date(String(row.created_at ?? '')),
    updated_at: new Date(String(row.updated_at ?? '')),
  };
}

export function createOAuthAccountModel(db: DbExecutor, masterKey: string) {
  async function createAccount(input: NewOAuthAccount): Promise<OAuthAccount> {
    const encrypted = crypto.encryptAes256Gcm(input.access_token, masterKey);
    const result = await db.query<Record<string, unknown>>(
      `insert into oauth_accounts (user_id, provider, provider_user_id, provider_email, access_token_encrypted, raw_profile)
       values ($1, $2, $3, $4, $5, $6)
       returning id, user_id, provider, provider_user_id, provider_email, access_token_encrypted, raw_profile, created_at, updated_at`,
      [
        input.user_id,
        input.provider,
        input.provider_user_id,
        input.provider_email,
        serializeEncryptedToken(encrypted),
        JSON.stringify(input.raw_profile),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('createAccount: no row returned');
    }
    return mapRow(row);
  }

  async function findByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<OAuthAccount | null> {
    const result = await db.query<Record<string, unknown>>(
      `select id, user_id, provider, provider_user_id, provider_email, access_token_encrypted, raw_profile, created_at, updated_at
       from oauth_accounts
       where provider = $1 and provider_user_id = $2`,
      [provider, providerUserId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapRow(row);
  }

  async function findById(id: string): Promise<OAuthAccount | null> {
    const result = await db.query<Record<string, unknown>>(
      `select id, user_id, provider, provider_user_id, provider_email, access_token_encrypted, raw_profile, created_at, updated_at
       from oauth_accounts
       where id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapRow(row);
  }

  async function getAccessToken(accountId: string): Promise<string | null> {
    const account = await findById(accountId);
    if (!account) {
      return null;
    }
    const token = deserializeEncryptedToken(account.access_token_encrypted);
    return crypto.decryptAes256Gcm(token.ciphertext, token.iv, token.authTag, masterKey);
  }

  async function linkAccount(input: NewOAuthAccount): Promise<OAuthAccount> {
    const existing = await findByProviderUserId(input.provider, input.provider_user_id);
    if (existing) {
      const encrypted = crypto.encryptAes256Gcm(input.access_token, masterKey);
      await db.query(
        `update oauth_accounts
         set access_token_encrypted = $1, raw_profile = $2, updated_at = now()
         where id = $3`,
        [serializeEncryptedToken(encrypted), JSON.stringify(input.raw_profile), existing.id],
      );
      return {
        ...existing,
        access_token_encrypted: serializeEncryptedToken(encrypted),
        raw_profile: input.raw_profile,
        updated_at: new Date(),
      };
    }
    return createAccount(input);
  }

  return {
    createAccount,
    findByProviderUserId,
    findById,
    linkAccount,
    getAccessToken,
  };
}

export type OAuthAccountModel = ReturnType<typeof createOAuthAccountModel>;
