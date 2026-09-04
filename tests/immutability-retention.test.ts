import { AUDIT_LOG_UID } from '../server/src/constants';
import auditLogSchemaModule from '../server/src/content-types/audit-log/schema';
import { allSchemas } from './helpers/fixtures';
import { createFakeStrapi } from './helpers/strapi';

const schema = auditLogSchemaModule as Record<string, any>;

describe('audit records are not ordinary content', () => {
  it('is hidden from the Content Manager, which is what withholds write permissions', () => {
    // `@strapi/content-manager` only registers create/update/delete/publish RBAC
    // actions for content types it displays, so `visible: false` means no admin
    // role can be granted write access to this table through the content APIs.
    expect(schema.pluginOptions['content-manager'].visible).toBe(false);
    expect(schema.pluginOptions['content-type-builder'].visible).toBe(false);
  });

  it('does not declare a documentId attribute', () => {
    // Strapi v5 reserves the name and throws at boot; the audited document's id
    // lives in `contentDocumentId`.
    expect(schema.attributes).not.toHaveProperty('documentId');
    expect(schema.attributes).toHaveProperty('contentDocumentId');
  });

  it('indexes every column the admin list filters or sorts on', () => {
    const indexed = new Set(schema.indexes.flatMap((index: { columns: string[] }) => index.columns));

    for (const column of ['created_at', 'content_type', 'content_document_id', 'action', 'user_id', 'locale']) {
      expect(indexed).toContain(column);
    }
  });

  it('leads the composite index with the column the list filters by', () => {
    const composite = schema.indexes.find(
      (index: { name: string }) => index.name === 'audit_logs_ct_created_idx'
    );
    expect(composite.columns).toEqual(['content_type', 'created_at']);
  });
});

describe('immutability guard', () => {
  const guarded = () => {
    const harness = createFakeStrapi({ schemas: allSchemas });
    harness.services.immutability.register();
    return harness;
  };

  it.each(['update', 'publish', 'unpublish', 'discardDraft', 'clone'])(
    'rejects %s on the audit collection',
    async (action) => {
      const harness = guarded();

      await expect(
        harness.runDocumentAction(AUDIT_LOG_UID, action, {}, async () => ({ ok: true }))
      ).rejects.toThrow(/Audit records are immutable/);
    }
  );

  it('allows delete, which retention and the delete route both need', async () => {
    const harness = guarded();

    await expect(
      harness.runDocumentAction(AUDIT_LOG_UID, 'delete', {}, async () => ({ ok: true }))
    ).resolves.toEqual({ ok: true });
  });

  it('leaves every other content type alone', async () => {
    const harness = guarded();

    await expect(
      harness.runDocumentAction('api::page.page', 'update', {}, async () => ({ ok: true }))
    ).resolves.toEqual({ ok: true });
  });
});

describe('retention', () => {
  const daysAgo = (days: number): string =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const withRetention = (pluginConfig: Record<string, unknown>) => {
    const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig });
    harness.seed(AUDIT_LOG_UID, [
      { action: 'create', contentType: 'api::page.page', createdAt: daysAgo(400) },
      { action: 'update', contentType: 'api::page.page', createdAt: daysAgo(200) },
      { action: 'delete', contentType: 'api::page.page', createdAt: daysAgo(1) },
    ]);
    return harness;
  };

  it('deletes only records past the retention window', async () => {
    const harness = withRetention({ retentionDays: 365 });

    const deleted = await harness.services.retention.cleanup();

    expect(deleted).toBe(1);
    expect(harness.auditRows()).toHaveLength(2);
  });

  it('deletes nothing when retentionDays is 0', async () => {
    const harness = withRetention({ retentionDays: 0 });

    expect(await harness.services.retention.cleanup()).toBe(0);
    expect(harness.auditRows()).toHaveLength(3);
  });

  it('registers no cron job at all when retention is disabled', () => {
    const harness = withRetention({ retentionDays: 0 });
    harness.services.retention.register();
    expect(Object.keys(harness.cronJobs)).toHaveLength(0);
  });

  it('runs on a schedule rather than during a content operation', () => {
    // Cleaning up inline would put an unbounded DELETE over the largest table in
    // the project in front of every editor pressing Save.
    const harness = withRetention({ retentionDays: 365 });
    harness.services.retention.register();

    expect(harness.cronJobs.auditLogRetention).toBeDefined();
    expect(harness.cronJobs.auditLogRetention!.options).toBe('0 3 * * *');
  });

  it('honours a custom cron expression', () => {
    const harness = withRetention({ retentionDays: 30, retentionCron: '30 4 * * 0' });
    harness.services.retention.register();
    expect(harness.cronJobs.auditLogRetention!.options).toBe('30 4 * * 0');
  });

  it('logs rather than crashing the process when the cleanup query fails', async () => {
    const harness = withRetention({ retentionDays: 365 });
    harness.services.audit.deleteOlderThan = jest.fn().mockRejectedValue(new Error('db is down'));
    harness.services.retention.register();

    await expect(harness.cronJobs.auditLogRetention!.task()).resolves.toBeUndefined();
    expect(harness.logs.error.join('\n')).toContain('db is down');
  });

  it('computes the cutoff from the retention window', () => {
    const harness = withRetention({ retentionDays: 30 });
    const now = new Date('2026-09-02T00:00:00.000Z');

    expect(harness.services.retention.cutoffDate(30, now).toISOString()).toBe(
      '2026-08-03T00:00:00.000Z'
    );
  });
});

describe('write mode', () => {
  it('awaits the insert in sync mode, so a record exists before the response', async () => {
    const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig: { writeMode: 'sync' } });

    await harness.services.audit.record({
      action: 'create',
      contentType: 'api::page.page',
      contentTypeDisplayName: 'Page',
      contentDocumentId: 'doc-1',
      contentId: '1',
      locale: 'en',
      changes: null,
      before: null,
      after: null,
      source: 'admin',
      userId: null,
      userEmail: null,
      userName: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });

    expect(harness.auditRows()).toHaveLength(1);
  });

  it('drains pending writes on flush in async mode', async () => {
    const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig: { writeMode: 'async' } });

    await harness.services.audit.record({
      action: 'update',
      contentType: 'api::page.page',
      contentTypeDisplayName: 'Page',
      contentDocumentId: 'doc-1',
      contentId: '1',
      locale: 'en',
      changes: null,
      before: null,
      after: null,
      source: 'api',
      userId: null,
      userEmail: null,
      userName: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });

    // `destroy()` calls flush, which is what keeps an orderly shutdown from
    // dropping the last few records.
    await harness.services.audit.flush();
    expect(harness.auditRows()).toHaveLength(1);
  });

  it('drops an oversized snapshot but still writes the record', async () => {
    const harness = createFakeStrapi({
      schemas: allSchemas,
      pluginConfig: { maxSnapshotBytes: 64 },
    });

    await harness.services.audit.record({
      action: 'update',
      contentType: 'api::page.page',
      contentTypeDisplayName: 'Page',
      contentDocumentId: 'doc-1',
      contentId: '1',
      locale: 'en',
      changes: null,
      before: { body: 'x'.repeat(5000) },
      after: null,
      source: 'admin',
      userId: null,
      userEmail: null,
      userName: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });

    const [row] = harness.auditRows();
    expect(row!.before).toHaveProperty('__omitted__');
    expect(JSON.stringify(row)).not.toContain('xxxxxxxxxx');
    expect(harness.logs.warn.join('\n')).toContain('exceeds maxSnapshotBytes');
  });
});
