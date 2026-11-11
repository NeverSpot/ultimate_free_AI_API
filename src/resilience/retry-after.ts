/**
 * Parse a `Retry-After` header value into milliseconds from an injected clock.
 *
 * The header has two RFC 9110 forms: delta-seconds (`"30"`) and an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Anything else is ignored. Fractional seconds
 * are deliberately rejected rather than rounded: providers do not send them, and
 * guessing would hide a malformed header.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      return undefined;
    }
    const milliseconds = seconds <= 0 ? 0 : seconds * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  // A numeric-looking value that is not an integer (fraction, sign, exponent) is
  // garbage for this header. Do not let `Date.parse` reinterpret it as a year.
  if (/^[+-]?[\d.]+$/.test(trimmed)) {
    return undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  const delta = timestamp - now;
  return delta > 0 ? delta : 0;
}
