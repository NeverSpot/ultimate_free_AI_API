import type { DbExecutor } from '../db/client';
import * as crypto from '../lib/crypto';
import { randomBytes } from 'node:crypto';

export interface User {
  id: string;
  username: string;
  email: string;
  /** `null` for OAuth-only accounts, which must not authenticate by password. */
  password_hash: string | null;
  gateway_api_key_hash: string;
  gateway_api_key_enc?: Buffer | null;
  gateway_api_key_iv?: Buffer | null;
  gateway_api_key_auth_tag?: Buffer | null;
  created_at: Date;
}

export interface NewUser {
  username: string;
  email: string;
  password: string;
  /** True once the address has been proven (OTP accepted, or provider-verified). */
  emailVerified?: boolean;
}

export interface NewUserFromHash {
  username: string;
  email: string;
  /** scrypt `saltHex:keyHex`, already computed by the OTP flow. */
  passwordHash: string;
  emailVerified?: boolean;
}

export interface NewOAuthUser {
  username: string;
  email: string;
}

/**
 * `masterKey` enables reversible storage of the gateway API key so login can
 * re-issue the same key. Omit it (tests, admin paths) and the key is stored as a
 * hash only — auth still works, but it cannot be handed back.
 */
export function createUserModel(db: DbExecutor, masterKey?: string) {
  async function insertUser(input: {
    username: string;
    email: string;
    passwordHash: string | null;
    emailVerified: boolean;
  }): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    const gatewayApiKeyPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const gatewayApiKeyHash = crypto.sha256Hex(gatewayApiKeyPlaintext);
    const enc = masterKey ? crypto.encryptAes256Gcm(gatewayApiKeyPlaintext, masterKey) : null;

    const result = await db.query<User>(
      `insert into users
         (username, email, password_hash, gateway_api_key_hash,
          gateway_api_key_enc, gateway_api_key_iv, gateway_api_key_auth_tag, email_verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, case when $8 then now() else null end)
       returning id, username, email, password_hash, gateway_api_key_hash, created_at`,
      [
        input.username,
        input.email,
        input.passwordHash,
        gatewayApiKeyHash,
        enc?.ciphertext ?? null,
        enc?.iv ?? null,
        enc?.authTag ?? null,
        input.emailVerified,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('createUser: no row returned');
    }
    return { user: row, gatewayApiKeyPlaintext };
  }

  async function createUser({
    username,
    email,
    password,
    emailVerified = false,
  }: NewUser): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    const passwordHash = await crypto.hashPassword(password);
    return insertUser({ username, email, passwordHash, emailVerified });
  }

  /**
   * Same as `createUser`, but takes the hash the OTP flow already computed for
   * the pending row. Re-hashing would burn another scrypt round for no gain.
   */
  async function createUserWithHash({
    username,
    email,
    passwordHash,
    emailVerified = false,
  }: NewUserFromHash): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    return insertUser({ username, email, passwordHash, emailVerified });
  }

  /**
   * OAuth signup: no password at all. `password_hash` stays null, and
   * `verifyPassword` refuses it, so an OAuth account can never be password-guessed.
   */
  async function createOAuthUser({
    username,
    email,
  }: NewOAuthUser): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    return insertUser({ username, email, passwordHash: null, emailVerified: true });
  }

  async function findByUsername(username: string): Promise<User | null> {
    const result = await db.query<User>(
      `select id, username, email, password_hash, gateway_api_key_hash, created_at
       from users
       where username = $1`,
      [username],
    );
    return result.rows[0] ?? null;
  }

  /** Case-insensitive: the edge lowercases, but legacy rows may not be. */
  async function findByEmail(email: string): Promise<User | null> {
    const result = await db.query<User>(
      `select id, username, email, password_hash, gateway_api_key_hash, created_at
       from users
       where lower(email) = lower($1)`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  async function findById(
    userId: string,
  ): Promise<{ id: string; username: string; email: string } | null> {
    const result = await db.query<{ id: string; username: string; email: string }>(
      `select id, username, email from users where id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async function findByGatewayApiKeyHash(
    gatewayApiKeyHash: string,
  ): Promise<{ id: string; username: string } | null> {
    const result = await db.query<{ id: string; username: string }>(
      `select id, username
       from users
       where gateway_api_key_hash = $1`,
      [gatewayApiKeyHash],
    );
    return result.rows[0] ?? null;
  }

  async function verifyPassword(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; email: string } | null> {
    const user = await findByUsername(username);
    if (!user || user.password_hash === null) {
      // OAuth-only accounts have no hash: treat exactly like a wrong password.
      return null;
    }
    const ok = await crypto.verifyPassword(password, user.password_hash);
    return ok ? { id: user.id, username: user.username, email: user.email } : null;
  }

  /** Set when an email is proven by another route (OAuth link to an existing account). */
  async function markEmailVerified(userId: string): Promise<void> {
    await db.query(
      `update users set email_verified_at = now()
       where id = $1 and email_verified_at is null`,
      [userId],
    );
  }

  async function setGatewayApiKeyHash(userId: string): Promise<string> {
    const newPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const newHash = crypto.sha256Hex(newPlaintext);
    const enc = masterKey ? crypto.encryptAes256Gcm(newPlaintext, masterKey) : null;
    const result = await db.query(
      `update users
       set gateway_api_key_hash = $1,
           gateway_api_key_enc = $2,
           gateway_api_key_iv = $3,
           gateway_api_key_auth_tag = $4
       where id = $5
       returning id`,
      [newHash, enc?.ciphertext ?? null, enc?.iv ?? null, enc?.authTag ?? null, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error('setGatewayApiKeyHash: user not found');
    }
    return newPlaintext;
  }

  /**
   * Return the user's gateway API key, decrypting the stored copy.
   *
   * Returns null when no recoverable key exists (legacy row from before
   * encryption). It NEVER reissues: rotating here would silently break a key the
   * user already has configured in their agents. Legacy accounts keep working on
   * their current key and recover persistence via an explicit "Get New".
   */
  async function getGatewayApiKey(userId: string): Promise<string | null> {
    if (masterKey === undefined) {
      return null;
    }

    const result = await db.query<{
      gateway_api_key_enc: Buffer | null;
      gateway_api_key_iv: Buffer | null;
      gateway_api_key_auth_tag: Buffer | null;
    }>(
      `select gateway_api_key_enc, gateway_api_key_iv, gateway_api_key_auth_tag
       from users where id = $1`,
      [userId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    const ciphertext = row.gateway_api_key_enc;
    const iv = row.gateway_api_key_iv;
    const authTag = row.gateway_api_key_auth_tag;

    if (!ciphertext || !iv || !authTag) {
      return null;
    }

    return crypto.decryptAes256Gcm(ciphertext, iv, authTag, masterKey);
  }

  return {
    createUser,
    createUserWithHash,
    createOAuthUser,
    findByUsername,
    findByEmail,
    findById,
    findByGatewayApiKeyHash,
    verifyPassword,
    markEmailVerified,
    setGatewayApiKeyHash,
    getGatewayApiKey,
  };
}

export type UserModel = ReturnType<typeof createUserModel>;
