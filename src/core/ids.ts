import { randomUUID } from 'node:crypto';

const ULID_LENGTH = 26;

/**
 * Gateway request id, shaped like a ULID and prefixed like an OpenAI completion id.
 *
 * `crypto.randomUUID()` supplies the entropy; the hyphens are removed and the hex is
 * uppercased so the result matches the 26-character Crockford-style id clients expect.
 */
export function newRequestId(): string {
  const body = randomUUID().replace(/-/g, '').toUpperCase().slice(0, ULID_LENGTH);
  return `chatcmpl-${body}`;
}
