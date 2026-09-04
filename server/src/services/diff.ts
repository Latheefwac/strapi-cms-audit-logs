import type { Core } from '@strapi/strapi';

import { isEqual, isPlainObject } from '../utils/json';
import { joinPath } from '../utils/paths';
import type { PathMatcher } from '../utils/sanitize';
import type { AuditChangeSet } from '../types';

export interface DiffOptions {
  /** Paths excluded from the result. Already applied to `before`/`after` for the sensitive list; this one also carries `ignoredChangeFields`. */
  isIgnored?: PathMatcher;
  /**
   * Restricts the diff to these top-level keys.
   *
   * For an update this is the set of attributes the caller actually sent, which
   * is what makes the diff both meaningful and cheap: comparing keys the write
   * never touched can only produce noise, and `before`/`after` were only
   * populated for these keys in the first place.
   */
  keys?: string[] | null;
  /**
   * Longest path, in segments, before a whole subtree is recorded as one change.
   *
   * `maxDepth: 2` produces `seo.metaTitle` but collapses `a.b.c.d` into a single
   * `a.b` entry holding both subtrees. A dynamic zone nested three components
   * deep is still legible as `blocks[2].rows[0].label`; past that, a reader is
   * better served by the raw JSON of the subtree than by a hundred leaf paths.
   */
  maxDepth?: number;
  /** Ceiling on entries, so one pathological write cannot produce a megabyte of diff. */
  maxChanges?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_CHANGES = 500;

/**
 * Field-level diff between two snapshots.
 *
 * Entirely generic: it knows nothing about content types, components or dynamic
 * zones, and works purely off the shape of the two values. That is deliberate —
 * anything schema-aware would have to walk every component definition a type
 * *could* hold, which for a page with 173 registered widgets is exactly the
 * work this plugin exists to avoid.
 *
 * Arrays — repeatable components, dynamic zones, multi-relations, media lists —
 * are compared by index and addressed as `blocks[2].heading`. Index comparison
 * reports a reorder as a change to every moved element, which is honest: the
 * stored order *is* the content, and a reader looking at "why did this page
 * change" wants to see that the blocks moved.
 */
const diffService = ({ strapi }: { strapi: Core.Strapi }) => {
  void strapi;

  const buildDiff = (
    before: unknown,
    after: unknown,
    options: DiffOptions = {}
  ): AuditChangeSet => {
    const {
      isIgnored = () => false,
      keys = null,
      maxDepth = DEFAULT_MAX_DEPTH,
      maxChanges = DEFAULT_MAX_CHANGES,
    } = options;

    const changes: AuditChangeSet = {};
    let count = 0;
    let truncated = false;

    const record = (path: string, from: unknown, to: unknown): void => {
      if (count >= maxChanges) {
        truncated = true;
        return;
      }
      changes[path] = { from: normalise(from), to: normalise(to) };
      count += 1;
    };

    const walk = (from: unknown, to: unknown, path: string, depth: number): void => {
      if (count >= maxChanges) {
        truncated = true;
        return;
      }
      if (path.length > 0 && isIgnored(path)) return;
      if (isEqual(from, to)) return;

      // Past the depth budget, or the two sides are not the same kind of thing
      // (object replaced by a string, say) — record the subtree wholesale.
      const bothObjects = isPlainObject(from) && isPlainObject(to);
      const bothArrays = Array.isArray(from) && Array.isArray(to);

      if (depth >= maxDepth || (!bothObjects && !bothArrays)) {
        record(path, from, to);
        return;
      }

      if (bothArrays) {
        const length = Math.max(from.length, to.length);
        for (let index = 0; index < length; index += 1) {
          walk(from[index], to[index], joinPath(path, index), depth + 1);
        }
        return;
      }

      // Both plain objects: union of keys, so additions and removals both show up.
      const objectKeys = new Set([...Object.keys(from as object), ...Object.keys(to as object)]);
      for (const key of objectKeys) {
        walk(
          (from as Record<string, unknown>)[key],
          (to as Record<string, unknown>)[key],
          joinPath(path, key),
          depth + 1
        );
      }
    };

    const beforeObject = isPlainObject(before) ? before : {};
    const afterObject = isPlainObject(after) ? after : {};

    const topLevelKeys =
      keys && keys.length > 0
        ? keys
        : [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])];

    // Depth is counted in path segments, so a top-level key starts at 1 and
    // `maxDepth` reads as "at most this many segments".
    for (const key of topLevelKeys) {
      walk(beforeObject[key], afterObject[key], key, 1);
    }

    if (truncated) {
      changes.__truncated__ = {
        from: null,
        to: `Diff truncated at ${maxChanges} changes. See the before/after snapshots for the full state.`,
      };
    }

    return changes;
  };

  /**
   * `Date` instances survive `JSON.stringify` as ISO strings anyway, but the
   * value is also compared and logged before it reaches the database driver, so
   * normalising here keeps `changes` consistent regardless of which side of the
   * write a value came from.
   */
  const normalise = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (value === undefined) return null;
    return value;
  };

  return { buildDiff };
};

export default diffService;
