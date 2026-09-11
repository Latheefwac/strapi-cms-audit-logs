import { createHash } from 'node:crypto';

import type { Core } from '@strapi/strapi';

import { AUDIT_LOG_UID } from '../constants';
import type { IntegrityReport } from '../types';

type Row = Record<string, any>;

/**
 * The fields a record's hash covers.
 *
 * Everything that carries meaning, and nothing that the database owns. `id` is
 * left out because it is not known until after the insert and the hash has to
 * be computed before; `updatedAt` because the row is never updated; `hash`
 * itself for the obvious reason. `createdAt` *is* included — the plugin sets it
 * explicitly for exactly this purpose — so that back-dating a record is as
 * detectable as changing its content.
 */
export const HASHED_FIELDS = [
  'action',
  'contentType',
  'contentTypeDisplayName',
  'contentDocumentId',
  'contentId',
  'locale',
  'userId',
  'userEmail',
  'userName',
  'source',
  'outcome',
  'ipAddress',
  'userAgent',
  'requestId',
  'metadata',
  'changes',
  'before',
  'after',
  'createdAt',
  'prevHash',
] as const;

/** Rows per page when walking the chain. Keeps memory flat on a table that only grows. */
const PAGE_SIZE = 500;

/**
 * JSON with keys sorted at every depth.
 *
 * A JSON column does not promise to hand back keys in the order they were
 * written — PostgreSQL's `jsonb` reorders them — so hashing `JSON.stringify` of
 * a snapshot would produce a digest that changes between the write and the
 * read-back with nothing having changed. Sorting makes the serialisation a
 * function of the value alone. `Date` becomes its ISO string for the same
 * reason: the driver returns one on read, the plugin holds the other on write.
 * `undefined` and `null` collapse together, since a JSON round-trip cannot tell
 * them apart either.
 */
export const canonicalize = (value: unknown): string => {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

const toIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

/**
 * Tamper-evidence for the audit table, as a hash chain.
 *
 * ## What it proves
 *
 * Each record stores `hash = sha256(canonical(fields) + prevHash)` where
 * `prevHash` is the hash of the record before it. Three things follow:
 *
 *  - **Edit** any hashed field of any record and its own digest no longer
 *    matches: caught at that row.
 *  - **Delete** a record from the middle and the next record's `prevHash` points
 *    at a hash that no longer exists: caught at the row after the gap.
 *  - **Insert** a record into the middle and the same thing happens, from the
 *    other direction.
 *
 * What it does not prove is that the *latest* record was not removed — a chain
 * has no way to know its own intended length. That is what forwarding to an
 * external collector is for; the two controls cover each other's blind spot.
 *
 * ## The one deletion that is allowed
 *
 * Retention removes rows from the *start* of the chain, which leaves the oldest
 * surviving row pointing at a predecessor that is legitimately gone. The walk
 * treats that row as the chain's start and does not attempt to check its
 * `prevHash`; the purge itself writes a `retention.purge` record, so the trail
 * says when and how much was removed.
 *
 * ## Rows from before the chain
 *
 * Records written before 1.2.0 have `hash: null`. They are counted, reported as
 * `legacy`, and never linked — not backfilled, because a hash computed today
 * over a row written last week vouches for nothing about last week.
 */
const integrityService = ({ strapi }: { strapi: Core.Strapi }) => {
  /** Digest of one record, given everything the hash covers. */
  const computeHash = (record: Row): string => {
    const material: Record<string, unknown> = {};

    for (const field of HASHED_FIELDS) {
      const value = record[field];
      material[field] = field === 'createdAt' ? toIso(value) : (value ?? null);
    }

    return createHash('sha256').update(canonicalize(material)).digest('hex');
  };

  /**
   * Walks every row in insertion order and checks each link.
   *
   * Paged, never a single `findMany`: the audit table is the one table in the
   * project guaranteed to grow without bound, and the verifier must work on the
   * day it is most needed, which is after a long time.
   */
  const verify = async (): Promise<IntegrityReport> => {
    const report: IntegrityReport = {
      ok: true,
      checked: 0,
      hashed: 0,
      legacy: 0,
      head: null,
      start: null,
      verifiedAt: new Date().toISOString(),
    };

    let previous: { id: number; hash: string } | null = null;
    let afterId = 0;

    for (;;) {
      const rows = (await strapi.db.query(AUDIT_LOG_UID).findMany({
        where: { id: { $gt: afterId } },
        orderBy: { id: 'asc' },
        limit: PAGE_SIZE,
      })) as Row[];

      if (rows.length === 0) break;

      for (const row of rows) {
        report.checked += 1;
        afterId = row.id;

        if (!row.hash) {
          // Pre-chain. A hashed row must never follow a legacy row *and* claim a
          // predecessor, but a legacy row itself asserts nothing.
          report.legacy += 1;
          continue;
        }

        report.hashed += 1;

        const expected = computeHash(row);
        if (expected !== row.hash) {
          report.ok = false;
          report.brokenAt = {
            id: row.id,
            reason: 'stored hash does not match the record content — a hashed field was modified',
          };
          return report;
        }

        if (previous === null) {
          // First hashed row. Whatever it points at was either never hashed or
          // has since been retained away; either way there is nothing to check.
          report.start = { id: row.id };
        } else if (row.prevHash !== previous.hash) {
          report.ok = false;
          report.brokenAt = {
            id: row.id,
            reason:
              `prevHash does not match the hash of record #${previous.id} — ` +
              'a record between them was removed or inserted',
          };
          return report;
        }

        previous = { id: row.id, hash: row.hash };
      }

      if (rows.length < PAGE_SIZE) break;
    }

    report.head = previous;
    return report;
  };

  return { computeHash, canonicalize, verify, HASHED_FIELDS };
};

export default integrityService;
