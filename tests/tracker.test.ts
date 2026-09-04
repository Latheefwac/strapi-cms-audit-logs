import {
  adminRequestContext,
  allSchemas,
  internalLogSchema,
  pageRow,
  WIDGET_COUNT,
} from './helpers/fixtures';
import { createFakeStrapi, type FakeStrapi } from './helpers/strapi';

const PAGE = 'api::page.page';

const setup = (pluginConfig: Record<string, unknown> = {}, rows = [pageRow()]): FakeStrapi => {
  const harness = createFakeStrapi({
    schemas: allSchemas,
    data: { [PAGE]: rows },
    pluginConfig,
    requestContext: adminRequestContext(),
  });

  harness.services.immutability.register();
  harness.services.tracker.register();

  return harness;
};

/** Stands in for the Document Service repository, which the middleware wraps. */
const documentHandlers = (harness: FakeStrapi) => ({
  update: (documentId: string, locale: string, data: Record<string, any>) => async () => {
    const row = harness.table(PAGE).find((r) => r.documentId === documentId && r.locale === locale);
    Object.assign(row!, data, { updatedAt: new Date().toISOString() });
    return { ...row };
  },

  create: (data: Record<string, any>) => async () => {
    const row = {
      id: 99,
      documentId: 'page-doc-new',
      locale: data.locale ?? 'en',
      publishedAt: null,
      ...data,
    };
    harness.table(PAGE).push(row);
    return { ...row };
  },

  remove: (documentId: string) => async () => {
    const rows = harness.table(PAGE);
    const removed = rows.filter((r) => r.documentId === documentId);
    harness.tables[PAGE] = rows.filter((r) => r.documentId !== documentId);
    return { documentId, entries: removed };
  },

  publish: (documentId: string) => async () => {
    const drafts = harness.table(PAGE).filter((r) => r.documentId === documentId && r.publishedAt == null);
    const published = drafts.map((draft) => ({
      ...draft,
      id: draft.id + 1000,
      publishedAt: '2026-09-02T13:10:00.000Z',
    }));
    harness.table(PAGE).push(...published);
    return { documentId, entries: published };
  },

  unpublish: (documentId: string) => async () => {
    const rows = harness.table(PAGE);
    const removed = rows.filter((r) => r.documentId === documentId && r.publishedAt != null);
    harness.tables[PAGE] = rows.filter((r) => !removed.includes(r));
    return { documentId, entries: removed };
  },
});

describe('automatic change tracking', () => {
  it('records a create without any per-content-type wiring', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'create',
      { data: { title: 'Brand new page', locale: 'en' }, locale: 'en' },
      handlers.create({ title: 'Brand new page' })
    );

    const logs = harness.auditRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'create',
      contentType: PAGE,
      contentTypeDisplayName: 'Page',
      contentDocumentId: 'page-doc-new',
      locale: 'en',
      source: 'admin',
    });
    expect(logs[0]!.before).toBeNull();
    expect(logs[0]!.after).toMatchObject({ title: 'Brand new page' });
  });

  it('captures before, after and a field-level diff on update', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { title: 'New Homepage' } },
      handlers.update('page-doc-1', 'en', { title: 'New Homepage' })
    );

    const [log] = harness.auditRows();
    expect(log).toMatchObject({ action: 'update', locale: 'en' });
    expect(log!.before).toEqual({ title: 'Old Homepage' });
    expect(log!.after).toEqual({ title: 'New Homepage' });
    expect(log!.changes).toEqual({ title: { from: 'Old Homepage', to: 'New Homepage' } });
  });

  it('produces dotted paths for nested component fields', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      {
        documentId: 'page-doc-1',
        locale: 'en',
        data: { seo: { metaTitle: 'New title', metaDescription: 'New description' } },
      },
      handlers.update('page-doc-1', 'en', {
        seo: { id: 10, metaTitle: 'New title', metaDescription: 'New description' },
      })
    );

    const [log] = harness.auditRows();
    expect(log!.changes).toMatchObject({
      'seo.metaTitle': { from: 'Old title', to: 'New title' },
      'seo.metaDescription': { from: 'Old description', to: 'New description' },
    });
  });

  it('records a delete with the state that was removed', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'delete',
      { documentId: 'page-doc-1', locale: 'en' },
      handlers.remove('page-doc-1')
    );

    const [log] = harness.auditRows();
    expect(log).toMatchObject({ action: 'delete', contentDocumentId: 'page-doc-1' });
    expect(log!.before).toMatchObject({ title: 'Old Homepage' });
    expect(log!.after).toBeNull();
  });

  it('emits one delete record per locale, not one per database row', async () => {
    // Draft & published rows for the same locale are both deleted; a second
    // audit record for the same editor action would double-count it.
    const harness = setup({}, [
      pageRow(),
      pageRow({ id: 2, publishedAt: '2026-09-01T12:00:00.000Z' }),
      pageRow({ id: 3, locale: 'fr', title: 'Ancienne page' }),
    ]);
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'delete',
      { documentId: 'page-doc-1', locale: '*' },
      handlers.remove('page-doc-1')
    );

    const logs = harness.auditRows();
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.locale).sort()).toEqual(['en', 'fr']);
  });

  it('records a publish', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'publish',
      { documentId: 'page-doc-1', locale: 'en' },
      handlers.publish('page-doc-1')
    );

    const [log] = harness.auditRows();
    expect(log).toMatchObject({ action: 'publish', contentDocumentId: 'page-doc-1', locale: 'en' });
    expect(log!.after).toMatchObject({ title: 'Old Homepage' });
  });

  it('records an unpublish and keeps the state that went away', async () => {
    const harness = setup({}, [pageRow({ id: 2, publishedAt: '2026-09-01T12:00:00.000Z' })]);
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'unpublish',
      { documentId: 'page-doc-1', locale: 'en' },
      handlers.unpublish('page-doc-1')
    );

    const [log] = harness.auditRows();
    expect(log).toMatchObject({ action: 'unpublish', locale: 'en' });
    expect(log!.before).toMatchObject({ title: 'Old Homepage' });
    expect(log!.after).toBeNull();
  });

  it('also records a publish when a create asks for status: published', async () => {
    // The repository publishes internally, calling its own `publish()` rather
    // than the middleware-wrapped facade, so no publish action reaches us.
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'create',
      { data: { title: 'Live on arrival' }, locale: 'en', status: 'published' },
      handlers.create({ title: 'Live on arrival' })
    );

    expect(harness.auditRows().map((log) => log.action)).toEqual(['create', 'publish']);
  });
});

describe('localization', () => {
  it('stamps the operation locale on the record', async () => {
    const harness = setup({}, [pageRow(), pageRow({ id: 2, locale: 'fr', title: 'Ancienne page' })]);
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'fr', data: { title: 'Nouvelle page' } },
      handlers.update('page-doc-1', 'fr', { title: 'Nouvelle page' })
    );

    const [log] = harness.auditRows();
    expect(log!.locale).toBe('fr');
    expect(log!.changes).toEqual({ title: { from: 'Ancienne page', to: 'Nouvelle page' } });
  });
});

describe('content-type and field exclusions', () => {
  it('records nothing for an ignored content type', async () => {
    const harness = createFakeStrapi({
      schemas: allSchemas,
      data: { [internalLogSchema.uid]: [{ id: 1, documentId: 'log-1', message: 'before' }] },
      pluginConfig: { ignoredContentTypes: [internalLogSchema.uid] },
      requestContext: adminRequestContext(),
    });
    harness.services.tracker.register();

    await harness.runDocumentAction(
      internalLogSchema.uid,
      'update',
      { documentId: 'log-1', data: { message: 'after' } },
      async () => ({ id: 1, documentId: 'log-1', message: 'after' })
    );

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('records nothing when the content type is outside an explicit allow-list', async () => {
    const harness = setup({ contentTypes: ['api::author.author'] });
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { title: 'Nope' } },
      handlers.update('page-doc-1', 'en', { title: 'Nope' })
    );

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('records nothing for an action that is not enabled', async () => {
    const harness = setup({ actions: ['create', 'delete'] });
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { title: 'Nope' } },
      handlers.update('page-doc-1', 'en', { title: 'Nope' })
    );

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('never stores a sensitive field, at any depth', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      {
        documentId: 'page-doc-1',
        locale: 'en',
        data: {
          seo: { metaTitle: 'New title', internalToken: 'tok_new_secret' },
          author: { id: 3, password: 'newpassword' },
        },
      },
      handlers.update('page-doc-1', 'en', {
        seo: { id: 10, metaTitle: 'New title', internalToken: 'tok_new_secret' },
        author: { id: 3, documentId: 'author-doc-3', name: 'Ada', password: 'newpassword' },
      })
    );

    const [log] = harness.auditRows();
    const serialised = JSON.stringify(log);

    expect(serialised).not.toContain('tok_new_secret');
    expect(serialised).not.toContain('tok_should_never_be_stored');
    expect(serialised).not.toContain('newpassword');
    expect(serialised).not.toContain('hunter2');

    // The non-sensitive sibling in the same component still comes through.
    expect(log!.changes).toMatchObject({ 'seo.metaTitle': { from: 'Old title', to: 'New title' } });
  });

  it('honours a nested ignore path without hiding its siblings', async () => {
    const harness = setup({ ignoredFields: ['seo.metaDescription'] });
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      {
        documentId: 'page-doc-1',
        locale: 'en',
        data: { seo: { metaTitle: 'New title', metaDescription: 'Secret description' } },
      },
      handlers.update('page-doc-1', 'en', {
        seo: { id: 10, metaTitle: 'New title', metaDescription: 'Secret description' },
      })
    );

    const [log] = harness.auditRows();
    expect(JSON.stringify(log)).not.toContain('Secret description');
    expect(log!.changes).toHaveProperty(['seo.metaTitle']);
    expect(log!.changes).not.toHaveProperty(['seo.metaDescription']);
  });
});

describe('population efficiency', () => {
  it('reads only the attributes an update touched', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { title: 'New Homepage' } },
      handlers.update('page-doc-1', 'en', { title: 'New Homepage' })
    );

    const reads = harness.queryLog.filter((entry) => entry.uid === PAGE && entry.method === 'findMany');
    expect(reads.length).toBeGreaterThan(0);

    for (const read of reads) {
      // Nothing relational at all: a title-only edit needs no joins.
      expect(read.populate).toBeUndefined();
      expect(read.select).toEqual(expect.arrayContaining(['title']));
      expect(read.select).not.toEqual(expect.arrayContaining(['body', 'slug']));
    }
  });

  it('populates a dynamic zone without enumerating its 173 declared components', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { blocks: [] } },
      handlers.update('page-doc-1', 'en', { blocks: [] })
    );

    const populates = harness.populatesFor(PAGE);
    expect(populates.length).toBeGreaterThan(0);

    // The first pass asks for the zone with `true`, which makes Strapi read the
    // join table and query only the component types actually present.
    expect(populates[0]).toEqual({ blocks: true });

    // The refinement pass may follow, but only over the five widgets in use.
    for (const populate of populates) {
      const blocks = populate.blocks as Record<string, any> | true;
      const on = blocks === true ? undefined : blocks?.on;
      if (!on) continue;

      const requested = Object.keys(on);
      expect(requested.length).toBeLessThanOrEqual(5);
      expect(requested.length).toBeLessThan(WIDGET_COUNT);
      expect(requested.sort()).toEqual([
        'widgets.w0',
        'widgets.w1',
        'widgets.w2',
        'widgets.w3',
        'widgets.w4',
      ]);
    }
  });

  it('detects a dynamic-zone change', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    const nextBlocks = [
      { id: 101, __component: 'widgets.w0', heading: 'First widget renamed' },
      { id: 102, __component: 'widgets.w1', heading: 'Second widget' },
      { id: 103, __component: 'widgets.w2', heading: 'Third widget' },
      { id: 104, __component: 'widgets.w3', heading: 'Fourth widget' },
      { id: 105, __component: 'widgets.w4', heading: 'Fifth widget' },
    ];

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { blocks: nextBlocks } },
      handlers.update('page-doc-1', 'en', { blocks: nextBlocks })
    );

    const [log] = harness.auditRows();
    expect(log!.changes).toEqual({
      'blocks[0].heading': { from: 'First widget', to: 'First widget renamed' },
    });
  });

  it('reduces a relation to identifying fields rather than the whole document', async () => {
    const harness = setup();
    const handlers = documentHandlers(harness);

    await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { author: { id: 4 } } },
      handlers.update('page-doc-1', 'en', { author: { id: 4, documentId: 'author-doc-4', name: 'Grace' } })
    );

    const [log] = harness.auditRows();
    // `name` was never requested, so the audit trail records which author, not
    // a copy of the author record.
    expect(log!.before).toEqual({ author: { id: 3, documentId: 'author-doc-3' } });
  });
});

describe('failure isolation', () => {
  it('never breaks the content operation when auditing fails', async () => {
    const harness = setup();
    harness.services.audit.record = jest.fn().mockRejectedValue(new Error('audit table is gone'));

    const result = await harness.runDocumentAction(
      PAGE,
      'update',
      { documentId: 'page-doc-1', locale: 'en', data: { title: 'Still saved' } },
      async () => ({ id: 1, documentId: 'page-doc-1', locale: 'en', title: 'Still saved' })
    );

    expect(result).toMatchObject({ title: 'Still saved' });
    expect(harness.logs.error.join('\n')).toContain('audit table is gone');
  });

  it('propagates the failure when failOnAuditError is enabled', async () => {
    const harness = setup({ failOnAuditError: true });
    harness.services.audit.record = jest.fn().mockRejectedValue(new Error('audit table is gone'));

    await expect(
      harness.runDocumentAction(
        PAGE,
        'update',
        { documentId: 'page-doc-1', locale: 'en', data: { title: 'Should throw' } },
        async () => ({ id: 1, documentId: 'page-doc-1', locale: 'en', title: 'Should throw' })
      )
    ).rejects.toThrow('audit table is gone');
  });
});
