/**
 * The security half of the audit trail: authentication, denied requests, and
 * changes to the admin users, roles, permissions and media.
 *
 * These records come from `strapi.eventHub` and from a Koa middleware rather
 * than from the Document Service, so none of the tracker's coverage applies to
 * them. What is asserted here is the behaviour a security review depends on: the
 * record exists, it names the actor (including on a *failed* login, where Strapi
 * itself supplies no identity), it never carries a credential, and it can never
 * take down the operation that produced it.
 */

import { allSchemas } from './helpers/fixtures';
import { createFakeStrapi } from './helpers/strapi';

const harnessWith = (pluginConfig: Record<string, unknown> = {}) => {
  const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig });
  harness.services.security.register();
  return harness;
};

/** A Koa context shaped the way the services read it. */
const requestContext = (overrides: Record<string, any> = {}) => ({
  request: {
    ip: '203.0.113.7',
    method: 'POST',
    path: '/admin/login',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-1' },
    body: {},
    ...(overrides.request ?? {}),
  },
  state: overrides.state ?? {},
  status: overrides.status ?? 200,
  body: overrides.body,
});

describe('authentication events', () => {
  it('records a successful login against the user who signed in', async () => {
    const harness = harnessWith();
    harness.setRequestContext(requestContext());

    await harness.emit('admin.auth.success', {
      user: { id: 4, email: 'editor@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      provider: 'local',
    });

    const [row] = harness.auditRows();
    expect(row).toMatchObject({
      action: 'login.success',
      contentType: 'admin::auth',
      contentTypeDisplayName: 'Authentication',
      outcome: 'success',
      userId: '4',
      userEmail: 'editor@example.com',
      userName: 'Ada Lovelace',
      contentId: '4',
      source: 'admin',
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      requestId: 'req-1',
    });
    expect(row.metadata).toEqual({ provider: 'local' });
  });

  it('records a failed login with the email that was attempted', async () => {
    // Strapi's `admin.auth.error` payload is only `{ error, provider }` — no
    // identity at all. Without pulling the attempted email off the live request
    // body, a brute-force run is twenty indistinguishable rows.
    const harness = harnessWith();
    harness.setRequestContext(
      requestContext({ request: { body: { email: 'victim@example.com', password: 'hunter2' } } })
    );

    await harness.emit('admin.auth.error', {
      error: new Error('Invalid credentials'),
      provider: 'local',
    });

    const [row] = harness.auditRows();
    expect(row).toMatchObject({
      action: 'login.failed',
      outcome: 'failure',
      userEmail: 'victim@example.com',
      ipAddress: '203.0.113.7',
    });
    expect(row.metadata).toMatchObject({
      attemptedEmail: 'victim@example.com',
      reason: 'Invalid credentials',
      provider: 'local',
    });
  });

  it('never writes the submitted password anywhere in the record', async () => {
    const harness = harnessWith();
    harness.setRequestContext(
      requestContext({ request: { body: { email: 'victim@example.com', password: 'hunter2' } } })
    );

    await harness.emit('admin.auth.error', { error: new Error('Invalid credentials') });

    expect(JSON.stringify(harness.auditRows())).not.toContain('hunter2');
  });

  it('records a failed login the way Strapi actually emits it — un-awaited, then a throw', async () => {
    // ASVS V7.2.1, and the assessment's F-1. Strapi's login controller calls
    // `strapi.eventHub.emit('admin.auth.error', ...)` WITHOUT awaiting it and
    // then throws synchronously; the response is already a 400 by the time the
    // listener's database write resolves. The existing tests await the emit,
    // which is a friendlier shape than production ever provides. This one does
    // not, and asserts the row still lands.
    const harness = harnessWith();
    harness.setRequestContext(
      requestContext({ request: { body: { email: 'victim@example.com', password: 'wrong' } } })
    );

    const controller = () => {
      void harness.emit('admin.auth.error', { error: new Error('Invalid credentials'), provider: 'local' });
      throw new Error('Invalid credentials');
    };

    expect(controller).toThrow('Invalid credentials');

    // The write is in flight but nobody is awaiting it. Yield until it settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));

    const [row] = harness.auditRows();
    expect(row).toMatchObject({
      action: 'login.failed',
      outcome: 'failure',
      userEmail: 'victim@example.com',
      ipAddress: '203.0.113.7',
    });
  });

  it('records a logout against the user who signed out', async () => {
    const harness = harnessWith();
    harness.setRequestContext(requestContext({ request: { path: '/admin/logout' } }));

    await harness.emit('admin.logout', { user: { id: 9, email: 'editor@example.com' } });

    expect(harness.auditRows()[0]).toMatchObject({
      action: 'logout',
      outcome: 'success',
      userId: '9',
      contentId: '9',
    });
  });
});

describe('admin user, role and media events', () => {
  it('records who changed an admin user, and the roles it now holds', async () => {
    const harness = harnessWith();
    harness.setRequestContext(
      requestContext({
        request: { path: '/admin/users/3' },
        state: { user: { id: 1, email: 'admin@example.com', firstname: 'Super', lastname: 'Admin' } },
      })
    );

    await harness.emit('user.update', {
      user: {
        id: 3,
        email: 'editor@example.com',
        firstname: 'Ada',
        roles: [{ id: 1, name: 'Super Admin' }],
      },
    });

    const [row] = harness.auditRows();
    // The actor is the signed-in admin; the subject is the account they changed.
    expect(row).toMatchObject({
      action: 'admin.user.update',
      contentType: 'admin::user',
      userId: '1',
      userEmail: 'admin@example.com',
      contentId: '3',
    });
    expect(row.after).toMatchObject({ email: 'editor@example.com', roles: ['Super Admin'] });
  });

  it('keeps credentials out of an admin user record', async () => {
    // The `user.*` payload is the whole admin user row. An allow-list is the only
    // thing standing between the audit table and a password hash.
    const harness = harnessWith();

    await harness.emit('user.create', {
      user: {
        id: 5,
        email: 'new@example.com',
        password: '$2a$10$abcdefghijklmnop',
        resetPasswordToken: 'reset-me',
        registrationToken: 'register-me',
      },
    });

    const serialised = JSON.stringify(harness.auditRows());
    expect(serialised).toContain('new@example.com');
    expect(serialised).not.toContain('$2a$10$abcdefghijklmnop');
    expect(serialised).not.toContain('reset-me');
    expect(serialised).not.toContain('register-me');
  });

  it('records a deletion as a before-state, not an after-state', async () => {
    const harness = harnessWith();

    await harness.emit('role.delete', { role: { id: 7, name: 'Author', code: 'strapi-author' } });

    const [row] = harness.auditRows();
    expect(row.action).toBe('admin.role.delete');
    expect(row.after).toBeNull();
    expect(row.before).toMatchObject({ name: 'Author', code: 'strapi-author' });
  });

  it('records a media upload', async () => {
    const harness = harnessWith();

    await harness.emit('media.create', {
      media: { id: 12, name: 'hero.png', url: '/uploads/hero.png', mime: 'image/png', size: 84 },
    });

    expect(harness.auditRows()[0]).toMatchObject({
      action: 'media.create',
      contentType: 'plugin::upload.file',
      contentId: '12',
    });
  });
});

describe('listener isolation', () => {
  it('never lets an audit failure fail the operation that emitted the event', async () => {
    // `eventHub.emit` awaits its listeners *inside* the login controller. A
    // listener that threw here would turn a correct password into a 500.
    const harness = harnessWith();
    harness.services.audit.record = async () => {
      throw new Error('audit table unreachable');
    };

    await expect(
      harness.emit('admin.auth.success', { user: { id: 1, email: 'a@example.com' } })
    ).resolves.toBeUndefined();

    expect(harness.logs.error.join('\n')).toContain('admin.auth.success');
  });

  it('does not double-record when register runs twice', async () => {
    const harness = harnessWith();
    harness.services.security.register();

    await harness.emit('admin.logout', { user: { id: 1 } });

    expect(harness.auditRows()).toHaveLength(1);
  });

  it('stops recording once unregistered', async () => {
    const harness = harnessWith();
    harness.services.security.unregister();

    await harness.emit('admin.logout', { user: { id: 1 } });

    expect(harness.auditRows()).toHaveLength(0);
  });
});

describe('operations with no request context', () => {
  it('labels a boot-time event as system, not admin', async () => {
    // Strapi reconciles its permission table during boot: `permission.create`
    // and `permission.delete` fire with no actor and no request. Calling those
    // `admin` would put rows in the log that read as though a person had edited
    // permissions — the exact row a security review is meant to stop on.
    const harness = harnessWith();
    harness.setRequestContext(null);

    await harness.emit('permission.create', { permission: { id: 1, action: 'plugin::x.read' } });

    expect(harness.auditRows()[0]).toMatchObject({
      action: 'admin.permission.create',
      source: 'system',
      userId: null,
    });
  });

  it('labels the same event as admin when a request is in flight', async () => {
    const harness = harnessWith();
    harness.setRequestContext(
      requestContext({ state: { user: { id: 1, email: 'admin@example.com' } } })
    );

    await harness.emit('permission.create', { permission: { id: 1, action: 'plugin::x.read' } });

    expect(harness.auditRows()[0]).toMatchObject({ source: 'admin', userId: '1' });
  });

  it('drops system-sourced events when auditSystemOperations is off', async () => {
    // What a project switches this off for: a handful of `admin.permission.*`
    // rows on every single restart, burying the one time a human changed a
    // permission for real.
    const harness = harnessWith({ auditSystemOperations: false });
    harness.setRequestContext(null);

    await harness.emit('permission.create', { permission: { id: 1 } });

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('still records request-borne events when auditSystemOperations is off', async () => {
    const harness = harnessWith({ auditSystemOperations: false });
    harness.setRequestContext(requestContext());

    await harness.emit('admin.auth.success', { user: { id: 2, email: 'a@example.com' } });

    expect(harness.auditRows()).toHaveLength(1);
  });
});

describe('securityEvents configuration', () => {
  it('registers no listeners at all when the list is empty', async () => {
    const harness = harnessWith({ securityEvents: [] });

    await harness.emit('admin.auth.success', { user: { id: 1 } });

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('records only the selected events', async () => {
    const harness = harnessWith({ securityEvents: ['login.failed'] });

    await harness.emit('admin.auth.success', { user: { id: 1 } });
    await harness.emit('admin.auth.error', { error: new Error('nope') });

    const rows = harness.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('login.failed');
  });
});

describe('denied requests', () => {
  const accessHarness = (pluginConfig: Record<string, unknown> = {}) => {
    const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig });
    harness.services.access.register();
    return harness;
  };

  it('records a 403 with the route, the reason and the user who was refused', async () => {
    const harness = accessHarness();

    const ctx = requestContext({
      request: { method: 'DELETE', path: '/admin/content-manager/collection-types/api::page.page/1' },
      state: { user: { id: 6, email: 'editor@example.com' }, route: { info: { type: 'admin' } } },
    });

    // The handler stands in for the router: `admin::hasPermissions` refused, and
    // `strapi::errors` has already turned that into a status and a body by the
    // time `next()` unwinds back to the middleware under test.
    await harness.runRequest(ctx, () => {
      ctx.status = 403;
      ctx.body = { error: { message: 'Forbidden' } };
    });

    const row = harness.auditRows().at(-1);
    expect(row).toMatchObject({
      action: 'access.denied',
      contentType: 'admin::access',
      outcome: 'failure',
      userId: '6',
      source: 'admin',
    });
    expect(row!.metadata).toMatchObject({
      method: 'DELETE',
      path: '/admin/content-manager/collection-types/api::page.page/1',
      statusCode: 403,
      reason: 'Forbidden',
    });
  });

  it('records a 401 even though nobody is signed in', async () => {
    const harness = accessHarness();
    const ctx = requestContext({ request: { method: 'GET', path: '/admin/users' } });

    await harness.runRequest(ctx, () => {
      ctx.status = 401;
    });

    expect(harness.auditRows()[0]).toMatchObject({
      action: 'access.denied',
      userId: null,
      ipAddress: '203.0.113.7',
    });
  });

  it('ignores the login route, which already produces a better record', async () => {
    // A wrong password is a 401 on `/admin/login`, and `admin.auth.error` has
    // already recorded it *with the attempted account*. Recording the status too
    // would double every failed attempt.
    const harness = accessHarness();
    const ctx = requestContext({ request: { path: '/admin/login' } });

    await harness.runRequest(ctx, () => {
      ctx.status = 401;
    });

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('ignores a successful request', async () => {
    const harness = accessHarness();
    const ctx = requestContext({ request: { path: '/admin/users' } });

    await harness.runRequest(ctx, () => {
      ctx.status = 200;
    });

    expect(harness.auditRows()).toHaveLength(0);
  });

  it('never turns a clean 403 into a 500', async () => {
    const harness = accessHarness();
    harness.services.audit.record = async () => {
      throw new Error('audit table unreachable');
    };

    const ctx = requestContext({ request: { path: '/admin/users' } });

    await expect(
      harness.runRequest(ctx, () => {
        ctx.status = 403;
      })
    ).resolves.toBeDefined();

    expect(ctx.status).toBe(403);
    expect(harness.logs.error.join('\n')).toContain('denied request');
  });

  it('registers no middleware when access.denied is switched off', () => {
    const harness = createFakeStrapi({
      schemas: allSchemas,
      pluginConfig: { securityEvents: ['login.failed'] },
    });

    harness.services.access.register();

    expect(harness.koaMiddlewares).toHaveLength(0);
  });
});

describe('logger forwarding', () => {
  it('mirrors a record as one line of structured JSON when enabled', async () => {
    const harness = harnessWith({ forwardToLogger: true, forwardLogLevel: 'info' });

    await harness.emit('admin.auth.error', { error: new Error('Invalid credentials') });

    const line = harness.logs.info.find((entry) => entry.includes('"type":"audit-log"'));
    expect(line).toBeDefined();

    const parsed = JSON.parse(line!);
    expect(parsed).toMatchObject({
      type: 'audit-log',
      action: 'login.failed',
      outcome: 'failure',
      contentType: 'admin::auth',
    });
  });

  it('stays silent by default', async () => {
    const harness = harnessWith();

    await harness.emit('admin.logout', { user: { id: 1 } });

    expect(harness.logs.info.some((entry) => entry.includes('"type":"audit-log"'))).toBe(false);
  });
});
