/**
 * Dotted-path matching for the ignore lists.
 *
 * A path is written the way the diff engine writes it — `seo.metaTitle`,
 * `blocks[2].heading` — and a pattern may be:
 *
 *   `password`          leaf name; matches at any depth
 *   `seo.metaTitle`     exact path, anchored at the document root
 *   `*token*`           substring match within one segment
 *   `seo.*.token`       `*` on its own matches exactly one whole segment
 *   `blocks.**.secret`  `**` matches zero or more segments
 *
 * Array indices are stripped before matching, so `blocks[2].secret` is matched
 * by `blocks.secret` — someone writing an ignore list should never have to think
 * about which element of a repeatable component they are excluding.
 *
 * Matching is case-insensitive. Attribute names in Strapi are camelCase while
 * the words worth redacting (`token`, `secret`, `password`) are written
 * lowercase, so a case-sensitive `*token*` would sail straight past
 * `internalToken`. For a redaction list, matching too widely costs a field in an
 * audit record; matching too narrowly costs a secret stored forever.
 */

/** `blocks[2].seo.title` -> `['blocks', 'seo', 'title']`, lowercased. */
export const toSegments = (path: string): string[] =>
  path
    .replace(/\[\d+\]/g, '')
    .split('.')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turns one pattern segment into a matcher. `*` inside a segment is a substring wildcard. */
const compileSegment = (segment: string): ((value: string) => boolean) => {
  if (segment === '*') return () => true;

  if (!segment.includes('*')) {
    return (value: string) => value === segment;
  }

  const source = `^${segment.split('*').map(escapeRegExp).join('.*')}$`;
  const regex = new RegExp(source);
  return (value: string) => regex.test(value);
};

const matchSegments = (
  pattern: Array<'**' | ((value: string) => boolean)>,
  segments: string[]
): boolean => {
  if (pattern.length === 0) return segments.length === 0;

  const [head, ...restPattern] = pattern;

  if (head === '**') {
    // Zero or more segments: try consuming nothing, then one, then two...
    for (let skip = 0; skip <= segments.length; skip += 1) {
      if (matchSegments(restPattern, segments.slice(skip))) return true;
    }
    return false;
  }

  if (segments.length === 0) return false;
  if (!head!(segments[0] as string)) return false;

  return matchSegments(restPattern, segments.slice(1));
};

/**
 * Compiles an ignore list into a predicate.
 *
 * Built once per operation rather than per field: a document with a large
 * dynamic zone produces thousands of path tests, and re-parsing the patterns for
 * each one is the difference between negligible and measurable.
 */
export const createPathMatcher = (patterns: string[]): ((path: string) => boolean) => {
  /** Bare leaf names — the overwhelmingly common case, and a Set lookup. */
  const exactLeaves = new Set<string>();
  /** Leaf names with a wildcard, e.g. `*token*`. */
  const leafMatchers: Array<(value: string) => boolean> = [];
  /** Multi-segment patterns, anchored at the document root. */
  const compiled: Array<Array<'**' | ((value: string) => boolean)>> = [];

  for (const raw of patterns) {
    const pattern = String(raw).trim().toLowerCase();
    if (pattern.length === 0) continue;

    if (!pattern.includes('.')) {
      if (!pattern.includes('*')) exactLeaves.add(pattern);
      else leafMatchers.push(compileSegment(pattern));
      continue;
    }

    compiled.push(
      toSegments(pattern).map((segment) => (segment === '**' ? '**' : compileSegment(segment)))
    );
  }

  if (exactLeaves.size === 0 && leafMatchers.length === 0 && compiled.length === 0) {
    return () => false;
  }

  return (path: string): boolean => {
    const segments = toSegments(path);
    if (segments.length === 0) return false;

    const leaf = segments[segments.length - 1] as string;
    if (exactLeaves.has(leaf)) return true;
    if (leafMatchers.some((matches) => matches(leaf))) return true;

    return compiled.some((pattern) => matchSegments(pattern, segments));
  };
};

/** Appends a key to a dotted path, using `[i]` notation for array members. */
export const joinPath = (base: string, key: string | number): string => {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base.length === 0 ? key : `${base}.${key}`;
};
