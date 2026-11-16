import type { FastifyRequest } from 'fastify';
import { verifyJwt } from '../../lib/jwt';

export interface JwtCookieUser {
  userId: string;
  username: string;
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) {
    return null;
  }
  const hit = raw
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

/**
 * Read and verify the httpOnly session cookie, then re-check the user still exists.
 * Never throws: any failure is simply "no JWT session", so the next authenticator
 * (gateway key / admin token) can still run.
 */
export function createJwtAuth({
  jwtSecret,
  findUserById,
}: {
  jwtSecret: string;
  findUserById: (userId: string) => Promise<{ id: string; username: string } | null>;
}) {
  async function tryAuthenticate(req: FastifyRequest): Promise<JwtCookieUser | null> {
    const token = readCookie(req, 'jwt');
    if (!token) {
      return null;
    }
    const payload = verifyJwt(token, jwtSecret);
    if (!payload?.userId) {
      return null;
    }
    const user = await findUserById(payload.userId);
    return user ? { userId: user.id, username: user.username } : null;
  }

  return { tryAuthenticate };
}
