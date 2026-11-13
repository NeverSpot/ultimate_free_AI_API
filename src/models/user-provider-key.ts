import type { DbExecutor } from '../db/client';

export interface UserProviderKey {
  id: string;
  user_id: string;
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

export interface NewUserProviderKey {
  user_id: string;
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  fingerprint: string;
}

export function createUserProviderKeyModel(db: DbExecutor) {
  async function createUserProviderKey(key: NewUserProviderKey): Promise<UserProviderKey> {
    const result = await db.query<UserProviderKey>(
      `insert into user_provider_keys (user_id, provider, ciphertext, iv, auth_tag, fingerprint)
       values ($1, $2, $3, $4, $5, $6)
       returning id, user_id, provider, ciphertext, iv, auth_tag, fingerprint, created_at, updated_at`,
      [key.user_id, key.provider, key.ciphertext, key.iv, key.auth_tag, key.fingerprint],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('createUserProviderKey: no row returned');
    }
    return row;
  }

  async function findByUserIdAndProvider(
    userId: string,
    provider: string,
  ): Promise<UserProviderKey | null> {
    const result = await db.query<UserProviderKey>(
      `select id, user_id, provider, ciphertext, iv, auth_tag, fingerprint, created_at, updated_at
       from user_provider_keys
       where user_id = $1 and provider = $2`,
      [userId, provider],
    );
    return result.rows[0] ?? null;
  }

  async function findByFingerprint(fingerprint: string): Promise<UserProviderKey | null> {
    const result = await db.query<UserProviderKey>(
      `select id, user_id, provider, ciphertext, iv, auth_tag, fingerprint, created_at, updated_at
       from user_provider_keys
       where fingerprint = $1`,
      [fingerprint],
    );
    return result.rows[0] ?? null;
  }

  async function updateKey(
    keyId: string,
    updates: Partial<
      Pick<UserProviderKey, 'provider' | 'ciphertext' | 'iv' | 'auth_tag' | 'fingerprint'>
    >,
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.provider !== undefined) {
      sets.push(`provider = $${paramIndex++}`);
      params.push(updates.provider);
    }
    if (updates.ciphertext !== undefined) {
      sets.push(`ciphertext = $${paramIndex++}`);
      params.push(updates.ciphertext);
    }
    if (updates.iv !== undefined) {
      sets.push(`iv = $${paramIndex++}`);
      params.push(updates.iv);
    }
    if (updates.auth_tag !== undefined) {
      sets.push(`auth_tag = $${paramIndex++}`);
      params.push(updates.auth_tag);
    }
    if (updates.fingerprint !== undefined) {
      sets.push(`fingerprint = $${paramIndex++}`);
      params.push(updates.fingerprint);
    }
    if (sets.length === 0) {
      return false;
    }
    sets.push('updated_at = now()');
    params.push(keyId);

    const result = await db.query(
      `update user_provider_keys set ${sets.join(', ')} where id = $${paramIndex}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  return {
    createUserProviderKey,
    findByUserIdAndProvider,
    findByFingerprint,
    updateKey,
  };
}

export type UserProviderKeyModel = ReturnType<typeof createUserProviderKeyModel>;
