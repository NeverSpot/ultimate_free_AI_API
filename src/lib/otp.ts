import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Digits in the emailed code. Six is the shortest length that survives UX review. */
export const OTP_LENGTH = 6;

/** Per-attempt compaction so a 6-digit code is never stored in plaintext. */
export function generateOtp(): string {
  // randomInt is CSPRNG-backed and unbiased; Math.random would be guessable.
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');
}

/**
 * HMAC rather than a plain hash: without the pepper, a leaked table of 6-digit
 * codes is brute-forced in microseconds. The email is bound in so a code issued
 * for one address cannot be replayed against another.
 */
export function hashOtp(code: string, email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${email}:${code}`).digest('hex');
}

/** Constant-time comparison of a submitted code against the stored HMAC. */
export function otpMatches(
  code: string,
  email: string,
  pepper: string,
  storedHash: string,
): boolean {
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashOtp(code, email, pepper), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface OtpPolicy {
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
}

export const DEFAULT_OTP_POLICY: OtpPolicy = {
  ttlSeconds: 600,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
};

/** Trim + lowercase so `Alice@Example.com ` and `alice@example.com` are one inbox. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deliberately permissive: full RFC 5322 validation rejects addresses that
 * actually deliver. The OTP is the real verifier.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
