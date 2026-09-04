import { createPathMatcher, joinPath } from './paths';
import { isPlainObject } from './json';

export type PathMatcher = (path: string) => boolean;

/**
 * Recursively strips every ignored path from a snapshot.
 *
 * Runs on `before` and `after` *before* they are handed to the diff engine, so a
 * redacted field cannot leak into `changes` either. Values are dropped
 * entirely rather than masked with a placeholder: a placeholder still tells a
 * reader of the audit log that the field exists and changed, and for a password
 * hash or an API key even that is more than an audit trail needs to say.
 *
 * Returns a new object; the input — which is a live row handed to us by the
 * Document Service — is never mutated.
 */
export const sanitizeValue = <T>(value: T, isIgnored: PathMatcher, basePath = ''): T => {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, isIgnored, joinPath(basePath, index))) as unknown as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = joinPath(basePath, key);
      if (isIgnored(path)) continue;
      result[key] = sanitizeValue(child, isIgnored, path);
    }
    return result as unknown as T;
  }

  return value;
};

export { createPathMatcher };
