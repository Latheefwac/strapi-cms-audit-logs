/**
 * The hash chain: every record links to the one before it, so an edited,
 * removed or inserted row is provable.
 *
 * These drive the real write path — `audit.record()` through the harness's
 * `db.query` — rather than calling `computeHash` in isolation, because what
 * matters is that the chain the writer builds is the chain the verifier reads.
 */

import { AUDIT_LOG_UID } from '../server/src/constants';
import { canonicalize } from '../server/src/services/integrity';
import { allSchemas } from './helpers/fixtures';
import { createFakeStrapi } from './helpers/strapi';

const entry = (overrides: Record<string, unknown> = {}) => ({
  action: 'update',
  contentType: 'api::page.page',
  contentTypeDisplayName: 'Page',
  contentDocumentId: 'doc-1',
  contentId: '1',
  locale: 'en',
  userId: '7',
  userEmail: 'ada@example.com',
  userName: 'Ada Lovelace',
  source: 'admin',
  ipAddress: '203.0.113.10',
  userAgent: 'curl',
  requestId: 'req-1',
  changes: { title: { from: 'a', to: 'b' } },
  before: { title: 'a' },
  after: { title: 'b' },
  ...overrides,
});

const chainOf = async (count: number) => {
  const harness = createFakeStrapi({ schemas: allSchemas });
  for (let i = 0; i < count; i += 1) {
    await harness.services.audit.record(entry({ contentId: String(i + 1) }));
  }
  return harness;
};

describe('writing the chain', () => {
  it('gives every record a hash and links it to the previous one', async () => {
    const harness = await chainOf(3);
    const [first, second, third] = harness.auditRows();

    expect(first!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first!.prevHash).toBeNull();
    expect(second!.prevHash).toBe(first!.hash);
    expect(third!.prevHash).toBe(second!.hash);
  });

  it('sets createdAt itself so the timestamp is inside the hash', async () => {
    const harness = await chainOf(1);
    const [row] = harness.auditRows();

    // The harness JSON-clones rows, so a Date comes back as its ISO string —
    // which is also what a real driver returns for a timestamp column.
    const written = new Date(row!.createdAt as string).getTime();
    expect(Math.abs(Date.now() - written)).toBeLessThan(5_000);
  });

  it('starts a fresh chain after rows that predate it', async () => {
    // Pre-1.2.0 rows have no hash. The first hashed row must not pretend to link
    // to something that was never hashed.
    const harness = createFakeStrapi({ schemas: allSchemas });
    harness.seed(AUDIT_LOG_UID, [{ action: 'create', contentType: 'api::page.page', hash: null }]);

    await harness.services.audit.record(entry());

    const [, hashed] = harness.auditRows();
    expect(hashed!.prevHash).toBeNull();
    expect(hashed!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialises concurrent writes so the chain never forks', async () => {
    const harness = createFakeStrapi({ schemas: allSchemas });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        harness.services.audit.record(entry({ contentId: String(i) }))
      )
    );

    const rows = harness.auditRows();
    expect(rows).toHaveLength(12);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    }
    // Every predecessor is claimed exactly once — no two rows share one.
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(rows.length);
  });
});

describe('verifying the chain', () => {
  it('passes an intact chain and reports the head', async () => {
    const harness = await chainOf(5);

    const report = await harness.services.integrity.verify();

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(5);
    expect(report.hashed).toBe(5);
    expect(report.legacy).toBe(0);
    expect(report.start).toEqual({ id: harness.auditRows()[0]!.id });
    expect(report.head).toEqual({ id: harness.auditRows()[4]!.id, hash: harness.auditRows()[4]!.hash });
  });

  it('passes an empty table', async () => {
    const harness = createFakeStrapi({ schemas: allSchemas });
    const report = await harness.services.integrity.verify();
    expect(report).toMatchObject({ ok: true, checked: 0, head: null, start: null });
  });

  it('detects an edited field', async () => {
    const harness = await chainOf(4);
    const rows = harness.auditRows();

    // Tamper with the third record in place, the way a direct SQL UPDATE would.
    rows[2]!.userEmail = 'someone-else@example.com';

    const report = await harness.services.integrity.verify();

    expect(report.ok).toBe(false);
    expect(report.brokenAt).toMatchObject({ id: rows[2]!.id });
    expect(report.brokenAt!.reason).toMatch(/modified/);
  });

  it('detects a back-dated record', async () => {
    const harness = await chainOf(2);
    const rows = harness.auditRows();

    rows[1]!.createdAt = new Date('2020-01-01T00:00:00.000Z');

    const report = await harness.services.integrity.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt!.id).toBe(rows[1]!.id);
  });

  it('detects a record removed from the middle', async () => {
    const harness = await chainOf(4);
    const rows = harness.auditRows();
    const removed = rows[1]!;

    rows.splice(1, 1);

    const report = await harness.services.integrity.verify();

    expect(report.ok).toBe(false);
    // The break is reported at the row that *claims* the missing predecessor.
    expect(report.brokenAt!.id).toBe(rows[1]!.id);
    expect(report.brokenAt!.reason).toMatch(/removed or inserted/);
    expect(report.brokenAt!.id).not.toBe(removed.id);
  });

  it('detects a record inserted into the middle', async () => {
    const harness = await chainOf(3);
    const rows = harness.auditRows();

    // A forged row with a plausible-looking hash, spliced in after the first.
    rows.splice(1, 0, { ...rows[0], id: 999, hash: 'f'.repeat(64), prevHash: rows[0]!.hash });

    const report = await harness.services.integrity.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt!.id).toBe(999);
  });

  it('treats retention trimming the start as the chain start, not a break', async () => {
    // Retention removes the oldest rows. The survivor's prevHash then points at
    // a hash that is legitimately gone; that is the start, not evidence.
    const harness = await chainOf(5);
    const rows = harness.auditRows();

    rows.splice(0, 2);

    const report = await harness.services.integrity.verify();

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(3);
    expect(report.start).toEqual({ id: rows[0]!.id });
  });

  it('counts pre-chain rows as legacy without linking them', async () => {
    const harness = createFakeStrapi({ schemas: allSchemas });
    harness.seed(AUDIT_LOG_UID, [
      { action: 'create', contentType: 'api::page.page', hash: null },
      { action: 'update', contentType: 'api::page.page', hash: null },
    ]);
    await harness.services.audit.record(entry());
    await harness.services.audit.record(entry());

    const report = await harness.services.integrity.verify();

    expect(report.ok).toBe(true);
    expect(report.legacy).toBe(2);
    expect(report.hashed).toBe(2);
    expect(report.checked).toBe(4);
  });

  it('is not fooled by a JSON column reordering keys', async () => {
    // jsonb hands keys back in its own order. The hash must be a function of the
    // value, not of the order the writer happened to use.
    const harness = await chainOf(1);
    const [row] = harness.auditRows();

    row!.before = { title: 'a' };
    row!.changes = { title: { to: 'b', from: 'a' } }; // same content, keys swapped

    const report = await harness.services.integrity.verify();
    expect(report.ok).toBe(true);
  });

  it('walks a table larger than one page', async () => {
    const harness = await chainOf(1203);
    const report = await harness.services.integrity.verify();
    expect(report).toMatchObject({ ok: true, checked: 1203, hashed: 1203 });
  });
});

describe('canonicalize', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalize({ b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }] })).toBe(
      '{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}'
    );
  });

  it('collapses undefined into null and serialises dates as ISO strings', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"a":null,"b":null}');
    expect(canonicalize(new Date('2026-09-11T00:00:00.000Z'))).toBe('"2026-09-11T00:00:00.000Z"');
  });
});
