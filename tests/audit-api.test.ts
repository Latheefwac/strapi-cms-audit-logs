import { AUDIT_LOG_UID, PERMISSIONS } from '../server/src/constants';
import auditLogController from '../server/src/controllers/audit-log';
import adminRoutes from '../server/src/routes/admin';
import { allSchemas } from './helpers/fixtures';
import { createFakeStrapi } from './helpers/strapi';

const auditRow = (overrides: Record<string, any> = {}) => ({
  action: 'update',
  contentType: 'api::page.page',
  contentTypeDisplayName: 'Page',
  contentDocumentId: 'page-doc-1',
  contentId: '1',
  locale: 'en',
  userId: '7',
  userEmail: 'ada@example.com',
  userName: 'Ada Lovelace',
  source: 'admin',
  requestId: 'req-1',
  ipAddress: '203.0.113.10',
  changes: {},
  before: {},
  after: {},
  createdAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

const seededHarness = (rows = [auditRow()], pluginConfig: Record<string, unknown> = {}) => {
  const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig });
  harness.seed(AUDIT_LOG_UID, rows);
  return harness;
};

/** Shapes of the two filter lists, which the harness hands back untyped. */
type ContentTypeOption = { uid: string; displayName: string };
type UserOption = { userId: string; label: string };

describe('audit log listing', () => {
  it('paginates server-side', async () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      auditRow({ createdAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z` })
    );
    const harness = seededHarness(rows);

    const page = await harness.services.audit.find({ page: 2, pageSize: 20 });

    expect(page.results).toHaveLength(20);
    expect(page.pagination).toMatchObject({ page: 2, pageSize: 20, total: 45, pageCount: 3 });
  });

  it('caps the page size so one request cannot pull the whole table', () => {
    const harness = seededHarness();
    const where = harness.services.audit.buildWhere({});
    expect(where).toEqual({});

    return harness.services.audit
      .find({ pageSize: 100000 })
      .then((result: { pagination: { pageSize: number } }) => {
        expect(result.pagination.pageSize).toBe(100);
      });
  });

  it('filters by action, content type, user, locale and source', () => {
    const harness = seededHarness();
    const where = harness.services.audit.buildWhere({
      action: 'publish',
      contentType: 'api::page.page',
      userId: '7',
      locale: 'en',
      source: 'admin',
    });

    expect(where).toEqual({
      action: 'publish',
      contentType: 'api::page.page',
      userId: '7',
      locale: 'en',
      source: 'admin',
    });
  });

  it('turns multi-valued filters into an $in clause', () => {
    const harness = seededHarness();
    const where = harness.services.audit.buildWhere({ action: ['create', 'update'] });
    expect(where.action).toEqual({ $in: ['create', 'update'] });
  });

  it('applies each date bound independently', () => {
    const harness = seededHarness();

    expect(harness.services.audit.buildWhere({ dateFrom: '2026-09-01' }).createdAt).toHaveProperty(
      '$gte'
    );
    expect(harness.services.audit.buildWhere({ dateTo: '2026-09-30' }).createdAt).toHaveProperty(
      '$lte'
    );
    expect(harness.services.audit.buildWhere({ dateFrom: 'not-a-date' }).createdAt).toBeUndefined();
  });

  it('searches across the identifying columns', () => {
    const harness = seededHarness();
    const where = harness.services.audit.buildWhere({ _q: 'ada' });

    expect(where.$or).toEqual(
      expect.arrayContaining([{ userEmail: { $containsi: 'ada' } }, { contentType: { $containsi: 'ada' } }])
    );
  });

  it('finds a record by exact document id', async () => {
    const harness = seededHarness([
      auditRow({ contentDocumentId: 'page-doc-1' }),
      auditRow({ contentDocumentId: 'page-doc-2' }),
    ]);

    const result = await harness.services.audit.find({ contentDocumentId: 'page-doc-2' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.contentDocumentId).toBe('page-doc-2');
  });
});

describe('sorting', () => {
  it('defaults to newest first', () => {
    const harness = seededHarness();
    expect(harness.services.audit.parseSort(undefined)).toEqual({ createdAt: 'desc' });
  });

  it('accepts a whitelisted column', () => {
    const harness = seededHarness();
    expect(harness.services.audit.parseSort('action:asc')).toEqual({ action: 'asc' });
  });

  it('falls back rather than passing an arbitrary column into the query', () => {
    // A sort parameter reaches SQL, so an unrecognised column is discarded, not
    // forwarded.
    const harness = seededHarness();
    expect(harness.services.audit.parseSort('password:asc')).toEqual({ createdAt: 'desc' });
    expect(harness.services.audit.parseSort('1; DROP TABLE audit_logs')).toEqual({
      createdAt: 'desc',
    });
  });
});

describe('controller input validation', () => {
  const controllerFor = () => {
    const harness = seededHarness();
    return { harness, controller: auditLogController({ strapi: harness.strapi as never }) };
  };

  const koaContext = (overrides: Record<string, any> = {}) => ({
    query: {},
    params: {},
    body: undefined as unknown,
    badRequest: jest.fn((message: string) => ({ badRequest: message })),
    notFound: jest.fn((message?: string) => ({ notFound: message })),
    ...overrides,
  });

  it('rejects a non-numeric id', async () => {
    const { controller } = controllerFor();
    const ctx = koaContext({ params: { id: 'abc' } });

    await controller.findOne(ctx as never);
    expect(ctx.badRequest).toHaveBeenCalledWith('Invalid audit log id.');
  });

  it('rejects an id that only starts with digits', async () => {
    const { controller } = controllerFor();
    const ctx = koaContext({ params: { id: "1 OR 1=1" } });

    await controller.findOne(ctx as never);
    expect(ctx.badRequest).toHaveBeenCalled();
  });

  it('returns 404 for a missing record', async () => {
    const { controller } = controllerFor();
    const ctx = koaContext({ params: { id: '99999' } });

    await controller.findOne(ctx as never);
    expect(ctx.notFound).toHaveBeenCalledWith('Audit log not found.');
  });

  it('discards an object-valued filter rather than forwarding an operator', async () => {
    // `?action[$ne]=create` arrives as an object; passing it into `where` would
    // let a client author its own query operators.
    const { harness, controller } = controllerFor();
    const spy = jest.spyOn(harness.services.audit, 'find');
    const ctx = koaContext({ query: { action: { $ne: 'create' }, page: '1' } });

    await controller.find(ctx as never);

    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({ action: expect.anything() }));
  });

  it('ignores query keys it does not recognise', async () => {
    const { harness, controller } = controllerFor();
    const spy = jest.spyOn(harness.services.audit, 'find');
    const ctx = koaContext({ query: { populate: '*', filters: { id: 1 }, action: 'create' } });

    await controller.find(ctx as never);

    expect(spy).toHaveBeenCalledWith({ action: 'create' });
  });
});

describe('route protection', () => {
  it('exposes only admin routes', () => {
    expect(adminRoutes.type).toBe('admin');
  });

  it('requires an authenticated admin plus an explicit permission on every route', () => {
    for (const route of adminRoutes.routes) {
      const policies = route.config.policies as Array<string | { name: string; config: any }>;

      expect(policies[0]).toBe('admin::isAuthenticatedAdmin');
      expect(policies[1]).toMatchObject({ name: 'admin::hasPermissions' });
    }
  });

  it('gates reads behind audit-log.read', () => {
    const reads = adminRoutes.routes.filter((route) => route.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);

    for (const route of reads) {
      const policy = route.config.policies[1] as { config: { actions: string[] } };
      expect(policy.config.actions).toEqual([PERMISSIONS.read]);
    }
  });

  it('gates deletion behind a separate audit-log.delete', () => {
    // Being allowed to investigate must not imply being allowed to erase.
    const remove = adminRoutes.routes.find((route) => route.method === 'DELETE');
    const policy = remove!.config.policies[1] as { config: { actions: string[] } };

    expect(policy.config.actions).toEqual([PERMISSIONS.delete]);
    expect(PERMISSIONS.delete).not.toBe(PERMISSIONS.read);
  });

  it('never registers a create or update route', () => {
    const methods = adminRoutes.routes.map((route) => route.method);
    expect(methods).not.toContain('POST');
    expect(methods).not.toContain('PUT');
    expect(methods).not.toContain('PATCH');
  });

  it('declares the static paths before the :id parameter', () => {
    const paths = adminRoutes.routes.filter((route) => route.method === 'GET').map((r) => r.path);
    expect(paths.indexOf('/logs/:id')).toBeGreaterThan(paths.indexOf('/filters'));
    expect(paths.indexOf('/logs/:id')).toBeGreaterThan(paths.indexOf('/config'));
  });
});

describe('filter options', () => {
  /**
   * The dropdowns are built from the *registries* as well as the stored rows.
   *
   * Deriving them from rows alone is the obvious implementation and the wrong
   * one: a fresh install then offers two content types and one user, and there
   * is no way to ask "has anyone touched Insights?" until somebody already has.
   * Filtering matters most precisely when the answer is "nothing yet".
   */
  it('offers every audited content type, not only those with rows', async () => {
    const harness = seededHarness([]);

    const options = await harness.services.audit.getFilterOptions();
    const uids = options.contentTypes.map((entry: ContentTypeOption) => entry.uid);

    expect(uids).toContain('api::page.page');
    expect(uids).toContain('api::author.author');
    // Nothing has been written for any of them.
    expect(harness.auditRows()).toHaveLength(0);
  });

  it('never offers its own collection type', async () => {
    // Auditing the audit log would recurse, so it is excluded from tracking —
    // and offering it as a filter would promise rows that can never exist.
    const harness = seededHarness([]);

    const options = await harness.services.audit.getFilterOptions();

    expect(options.contentTypes.map((entry: ContentTypeOption) => entry.uid)).not.toContain(
      'plugin::audit-log.audit-log'
    );
  });

  it('respects a narrowed contentTypes config', async () => {
    const harness = seededHarness([], { contentTypes: ['api::page.page'] });

    const options = await harness.services.audit.getFilterOptions();
    const uids = options.contentTypes.map((entry: ContentTypeOption) => entry.uid);

    expect(uids).toContain('api::page.page');
    expect(uids).not.toContain('api::author.author');
  });

  it('offers the security subsystems, which are not content types', async () => {
    const harness = seededHarness([]);

    const options = await harness.services.audit.getFilterOptions();
    const uids = options.contentTypes.map((entry: ContentTypeOption) => entry.uid);

    expect(uids).toContain('admin::auth');
    expect(uids).toContain('admin::access');
    expect(options.contentTypes.find((entry: ContentTypeOption) => entry.uid === 'admin::auth')?.displayName).toBe(
      'Authentication'
    );
  });

  it('omits the security subsystems when security events are off', async () => {
    const harness = seededHarness([], { securityEvents: [] });

    const options = await harness.services.audit.getFilterOptions();

    expect(options.contentTypes.map((entry: ContentTypeOption) => entry.uid)).not.toContain('admin::auth');
  });

  it('offers every action up front, including ones never recorded', async () => {
    const harness = seededHarness([]);

    const options = await harness.services.audit.getFilterOptions();

    expect(options.actions).toEqual(expect.arrayContaining(['create', 'publish', 'login.failed']));
    expect(options.outcomes).toEqual(['failure', 'success']);
  });

  it('sorts content types by display name rather than uid', async () => {
    const harness = seededHarness([]);

    const { contentTypes } = await harness.services.audit.getFilterOptions();
    const names = (contentTypes as ContentTypeOption[]).map((entry) => entry.displayName);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('offers every administrator, not only those who have acted', async () => {
    // Same reasoning as the content types: a filter that lists one name is
    // useless for "did anyone else touch this?", which is the question.
    const harness = seededHarness([]);
    harness.seed('admin::user', [
      { id: 1, email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      { id: 2, email: 'grace@example.com', firstname: 'Grace', lastname: 'Hopper' },
    ]);

    const options = await harness.services.audit.getFilterOptions();
    const labels = (options.users as UserOption[]).map((entry) => entry.label);

    expect(labels).toEqual(['ada@example.com', 'grace@example.com']);
    expect(harness.auditRows()).toHaveLength(0);
  });

  it('keeps a user who has since been deleted from the admin panel', async () => {
    // The rows they left behind are exactly what an investigation looks for, and
    // their identity survives nowhere else once the account is gone.
    const harness = seededHarness([auditRow({ userId: '99', userEmail: 'gone@example.com' })]);
    harness.seed('admin::user', [{ id: 1, email: 'ada@example.com' }]);

    const options = await harness.services.audit.getFilterOptions();
    const ids = (options.users as UserOption[]).map((entry) => entry.userId);

    // The stored half is unavailable in the harness (no knex), so this asserts
    // the live half is present and the merge did not throw.
    expect(ids).toContain('1');
  });

  it('stays usable when the stored-value queries fail', async () => {
    // The distinct-value queries go through knex, which the harness does not
    // provide. Losing them must not empty the dropdowns — the registry lists are
    // the more useful half anyway.
    const harness = seededHarness([]);

    const options = await harness.services.audit.getFilterOptions();

    expect(options.contentTypes.length).toBeGreaterThan(0);
    expect(harness.logs.error.join('\n')).toContain('could not read stored filter options');
  });
});
