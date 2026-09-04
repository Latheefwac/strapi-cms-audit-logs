/** Small JSON helpers shared by the diff engine and the audit service. */

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * Structural equality for values that came out of the database or off a request
 * body — i.e. JSON-shaped, plus `Date`, which Strapi hands back for datetime
 * columns while the incoming payload for the same field is an ISO string.
 * Comparing those two with `===` would report a change on every single write.
 */
export const isEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;

  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const right = b instanceof Date ? b.getTime() : Date.parse(String(b));
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }

  // `null` and `undefined` both mean "no value" once a document round-trips
  // through the database, so an absent key must not read as a change.
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => isEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && isEqual(a[key], b[key]));
  }

  return false;
};

/**
 * Approximate byte size of a value once serialised.
 *
 * Approximate on purpose: this only ever feeds a "is this snapshot absurdly
 * large" check, and stringifying a 50MB document twice to get an exact number
 * would cost more than the check saves.
 */
export const approximateJsonBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    // Circular or non-serialisable: treat as oversized so the caller drops it.
    return Number.POSITIVE_INFINITY;
  }
};
