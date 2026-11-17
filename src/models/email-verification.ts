import type { DbExecutor } from '../db/client';

export interface PendingVerification {
  email: string;
  username: string;
  password_hash: string;
  code_hash: string;
  attempts: number;
  expires_at: Date;
  last_sent_at: Date;
}

export interface StartVerificationInput {
  email: string;
  username: string;
  passwordHash: string;
  codeHash: string;
  ttlSeconds: number;
  /** A second request inside this window is rejected at the database, not in a race. */
  cooldownSeconds: number;
}

/**
 * Pending email signups, one row per address.
 *
 * The row is the *whole* pending registration: no `users` row exists until the
 * code is accepted, so an attacker cannot squat a username by submitting an
 * address they do not control.
 */
export function createEmailVerificationModel(db: DbExecutor) {
  /**
   * Insert or replace the pending row. Returns null when the previous code was
   * sent inside the cooldown window — the conditional `where` makes the check
   * atomic, so two parallel requests cannot both send mail.
   */
  async function start(input: StartVerificationInput): Promise<{ expiresAt: Date } | null> {
    const result = await db.query<{ expires_at: Date }>(
      `insert into email_verifications as ev
         (email, username, password_hash, code_hash, attempts, expires_at, last_sent_at)
       values ($1, $2, $3, $4, 0, now() + make_interval(secs => $5), now())
       on conflict (email) do update
         set username = excluded.username,
             password_hash = excluded.password_hash,
             code_hash = excluded.code_hash,
             attempts = 0,
             expires_at = excluded.expires_at,
             last_sent_at = now()
         where ev.last_sent_at <= now() - make_interval(secs => $6)
       returning expires_at`,
      [
        input.email,
        input.username,
        input.passwordHash,
        input.codeHash,
        input.ttlSeconds,
        input.cooldownSeconds,
      ],
    );
    const row = result.rows[0];
    return row ? { expiresAt: row.expires_at } : null;
  }

  /**
   * Replace the code on an existing pending row without touching the stored
   * username or password hash. Same atomic cooldown as `start`.
   */
  async function resend(input: {
    email: string;
    codeHash: string;
    ttlSeconds: number;
    cooldownSeconds: number;
  }): Promise<{ expiresAt: Date } | null> {
    const result = await db.query<{ expires_at: Date }>(
      `update email_verifications
       set code_hash = $2,
           attempts = 0,
           expires_at = now() + make_interval(secs => $3),
           last_sent_at = now()
       where email = $1
         and last_sent_at <= now() - make_interval(secs => $4)
       returning expires_at`,
      [input.email, input.codeHash, input.ttlSeconds, input.cooldownSeconds],
    );
    const row = result.rows[0];
    return row ? { expiresAt: row.expires_at } : null;
  }

  async function find(email: string): Promise<PendingVerification | null> {
    const result = await db.query<PendingVerification>(
      `select email, username, password_hash, code_hash, attempts, expires_at, last_sent_at
       from email_verifications
       where email = $1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  /** Count a wrong guess, so the code cannot be brute-forced. */
  async function recordFailure(email: string): Promise<number> {
    const result = await db.query<{ attempts: number }>(
      `update email_verifications
       set attempts = attempts + 1
       where email = $1
       returning attempts`,
      [email],
    );
    return result.rows[0]?.attempts ?? 0;
  }

  async function remove(email: string): Promise<void> {
    await db.query(`delete from email_verifications where email = $1`, [email]);
  }

  /** Housekeeping: expired rows hold a password hash and must not linger. */
  async function purgeExpired(): Promise<number> {
    const result = await db.query(
      `delete from email_verifications where expires_at < now() - interval '1 day'`,
    );
    return result.rowCount ?? 0;
  }

  return { start, resend, find, recordFailure, remove, purgeExpired };
}

export type EmailVerificationModel = ReturnType<typeof createEmailVerificationModel>;
