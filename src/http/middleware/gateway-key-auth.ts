import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import { sha256Hex } from '../../lib/crypto';

export interface AuthenticatedUser {
  id: string;
  username: string;
}

export type AuthResult = { kind: 'user'; user: AuthenticatedUser } | { kind: 'admin' } | null;

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function createGatewayKeyAuth({
  adminToken,
  findUserByGatewayKey,
}: {
  adminToken: string;
  findUserByGatewayKey: (keyHash: string) => Promise<{ id: string; username: string } | null>;
}) {
  async function authenticate(req: FastifyRequest): Promise<AuthResult> {
    const header = req.headers.authorization;
    const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();

    if (token === undefined || token.length === 0) {
      throw new ApiError('auth', 'missing bearer token');
    }

    if (token.startsWith('gk_')) {
      const keyHash = sha256Hex(token);
      const user = await findUserByGatewayKey(keyHash);
      if (user === null) {
        throw new ApiError('auth', 'invalid gateway key');
      }
      req.user = { id: user.id, username: user.username };
      return { kind: 'user', user: { id: user.id, username: user.username } };
    }

    const tokenBuf = Buffer.from(token, 'utf8');
    const adminBuf = Buffer.from(adminToken, 'utf8');
    if (tokenBuf.length !== adminBuf.length || !timingSafeEqual(tokenBuf, adminBuf)) {
      throw new ApiError('auth', 'invalid gateway key');
    }
    return { kind: 'admin' };
  }

  return { authenticate };
}
