import contextService from '../server/src/services/context';

const withContext = (ctx: Record<string, any> | undefined) =>
  contextService({ strapi: { requestContext: { get: () => ctx } } as never });

describe('user context', () => {
  it('snapshots the admin user rather than only their id', () => {
    // Stored as a snapshot so the record stays readable after the user is
    // renamed or deleted.
    const context = withContext({
      state: {
        route: { info: { type: 'admin' } },
        user: { id: 7, email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      },
      request: { ip: '203.0.113.10', headers: {} },
    }).resolve();

    expect(context).toMatchObject({
      source: 'admin',
      userId: '7',
      userEmail: 'ada@example.com',
      userName: 'Ada Lovelace',
    });
  });

  it('falls back through username and email for a display name', () => {
    expect(
      withContext({
        state: { route: { info: { type: 'content-api' } }, user: { id: 3, username: 'grace' } },
        request: { headers: {} },
      }).resolve().userName
    ).toBe('grace');

    expect(
      withContext({
        state: { route: { info: { type: 'content-api' } }, user: { id: 3, email: 'g@example.com' } },
        request: { headers: {} },
      }).resolve().userName
    ).toBe('g@example.com');
  });

  it('records no user for an unauthenticated request', () => {
    const context = withContext({
      state: { route: { info: { type: 'content-api' } } },
      request: { headers: {} },
    }).resolve();

    expect(context.userId).toBeNull();
    expect(context.userEmail).toBeNull();
    expect(context.source).toBe('api');
  });
});

describe('source classification', () => {
  it.each([
    [{ state: { route: { info: { type: 'admin' } } }, request: { headers: {} } }, 'admin'],
    [{ state: { route: { info: { type: 'content-api' } } }, request: { headers: {} } }, 'api'],
    [
      { state: { auth: { strategy: { name: 'api-token' } } }, request: { headers: {} } },
      'api',
    ],
    [
      { state: { auth: { strategy: { name: 'users-permissions' } } }, request: { headers: {} } },
      'api',
    ],
    [{ state: {}, request: { headers: {} } }, 'unknown'],
  ])('classifies %#', (ctx, expected) => {
    expect(withContext(ctx as Record<string, any>).resolve().source).toBe(expected);
  });

  it('falls back to "system" with no request context at all', () => {
    expect(withContext(undefined).resolve()).toEqual({
      source: 'system',
      userId: null,
      userEmail: null,
      userName: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });
  });

  it("honours Strapi's own state.auditSource", () => {
    // Strapi's EE audit log uses this key for out-of-band sources, so both logs
    // tell the same story about where an operation came from.
    const context = withContext({
      state: { auditSource: 'mcp', route: { info: { type: 'admin' } } },
      request: { headers: {} },
    }).resolve();

    expect(context.source).toBe('mcp');
  });
});

describe('runAs', () => {
  it('labels writes made outside a request', async () => {
    const service = withContext(undefined);

    const inside = await service.runAs({ source: 'migration', userEmail: 'ops@example.com' }, () =>
      Promise.resolve(service.resolve())
    );

    expect(inside).toMatchObject({ source: 'migration', userEmail: 'ops@example.com' });
    // The label is scoped to the callback and does not leak.
    expect(service.resolve().source).toBe('system');
  });

  it('survives asynchronous boundaries inside the callback', async () => {
    const service = withContext(undefined);

    const result = await service.runAs({ source: 'cron' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return service.resolve();
    });

    expect(result.source).toBe('cron');
  });

  it('overrides the source even inside a request', () => {
    const service = withContext({
      state: { route: { info: { type: 'admin' } }, user: { id: 1, email: 'a@b.c' } },
      request: { headers: {} },
    });

    const labelled = service.runAs({ source: 'migration' }, () => service.resolve());
    expect(labelled.source).toBe('migration');
  });
});

describe('request metadata', () => {
  it('captures ip, user agent and correlation id when present', () => {
    const context = withContext({
      state: { route: { info: { type: 'admin' } } },
      request: {
        ip: '198.51.100.4',
        headers: { 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-42' },
      },
    }).resolve();

    expect(context).toMatchObject({
      ipAddress: '198.51.100.4',
      userAgent: 'Mozilla/5.0',
      requestId: 'req-42',
    });
  });

  it('falls back through the other correlation headers', () => {
    const context = withContext({
      state: { route: { info: { type: 'admin' } } },
      request: { headers: { 'x-correlation-id': 'corr-9' } },
    }).resolve();

    expect(context.requestId).toBe('corr-9');
  });

  it('records nulls rather than failing when metadata is absent', () => {
    const context = withContext({ state: { route: { info: { type: 'admin' } } } }).resolve();

    expect(context.ipAddress).toBeNull();
    expect(context.userAgent).toBeNull();
    expect(context.requestId).toBeNull();
    expect(context.source).toBe('admin');
  });
});
