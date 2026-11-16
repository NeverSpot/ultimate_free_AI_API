import type { DbExecutor } from '../db/client';
import * as crypto from '../lib/crypto';
import { randomBytes } from 'node:crypto';

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  gateway_api_key_hash: string;
  created_at: Date;
}

export interface NewUser {
  username: string;
  email: string;
  password: string;
}

export function createUserModel(db: DbExecutor) {
  async function createUser({
    username,
    email,
    password,
  }: NewUser): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    const passwordHash = await crypto.hashPassword(password);
    const gatewayApiKeyPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const gatewayApiKeyHash = crypto.sha256Hex(gatewayApiKeyPlaintext);

    const result = await db.query<User>(
      `insert into users (username, email, password_hash, gateway_api_key_hash)
       values ($1, $2, $3, $4)
       returning id, username, email, password_hash, gateway_api_key_hash, created_at`,
      [username, email, passwordHash, gatewayApiKeyHash],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('createUser: no row returned');
    }
    return { user: row, gatewayApiKeyPlaintext };
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

  async function findByEmail(email: string): Promise<User | null> {
    const result = await db.query<User>(
      `select id, username, email, password_hash, gateway_api_key_hash, created_at
       from users
       where email = $1`,
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
    if (!user) {
      return null;
    }
    const ok = await crypto.verifyPassword(password, user.password_hash);
    return ok ? { id: user.id, username: user.username, email: user.email } : null;
  }

  async function setGatewayApiKeyHash(userId: string): Promise<string> {
    const newPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const newHash = crypto.sha256Hex(newPlaintext);
    const result = await db.query(
      `update users
       set gateway_api_key_hash = $1
       where id = $2
       returning id`,
      [newHash, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error('setGatewayApiKeyHash: user not found');
    }
    return newPlaintext;
  }

  return {
    createUser,
    findByUsername,
    findByEmail,
    findById,
    findByGatewayApiKeyHash,
    verifyPassword,
    setGatewayApiKeyHash,
  };
}

export type UserModel = ReturnType<typeof createUserModel>;
