import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: string;
  username: string;
  exp?: number;
  iat?: number;
}

/**
 * Sign the session payload (HS256).
 *
 * `expiresIn` is only applied when the caller set no expiry and the payload has
 * no `exp` — otherwise jsonwebtoken throws "Bad options.expiresIn option the
 * payload already has an exp property".
 */
export function signJwt(
  payload: JwtPayload,
  secret: string,
  options: { expiresIn?: jwt.SignOptions['expiresIn'] } = {},
): string {
  const opts: jwt.SignOptions = { algorithm: 'HS256' };
  if (options.expiresIn !== undefined) {
    opts.expiresIn = options.expiresIn;
  } else if (payload.exp === undefined) {
    opts.expiresIn = '7d';
  }
  return jwt.sign(payload, secret, opts);
}

/** Verify and decode an HS256 session token. Any failure yields null. */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    return null;
  }
}
