/**
 * Correlation ids on every request-borne record (ASVS V7.1.x).
 *
 * The assessment found `requestId` null on ~90% of records: the admin panel
 * sends no such header, so the plugin recorded one only when a proxy happened
 * to add it. The middleware under test mints one where none arrives and echoes
 * it back, so the id in the audit row is the id the client and the proxy both
 * saw.
 */

import { allSchemas } from './helpers/fixtures';
import { createFakeStrapi } from './helpers/strapi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const harnessWith = (pluginConfig: Record<string, unknown> = {}) => {
  const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig });
  harness.services.correlation.register();
  return harness;
};

const koaContext = (headers: Record<string, string> = {}) => {
  const response: Record<string, string> = {};
  return {
    request: { ip: '203.0.113.7', method: 'POST', path: '/admin/login', headers, body: {} },
    state: {} as Record<string, any>,
    status: 200,
    set: (name: string, value: string) => {
      response[name] = value;
    },
    response,
  };
};

describe('correlation middleware', () => {
  it('mints an id when none arrives, and echoes it back', async () => {
    const harness = harnessWith();
    const ctx = koaContext();

    await harness.runRequest(ctx);

    expect(ctx.state.requestId).toMatch(UUID);
    expect(ctx.response['X-Request-Id']).toBe(ctx.state.requestId);
  });

  it('honours an id a proxy or tracer already assigned', async () => {
    const harness = harnessWith();
    const ctx = koaContext({ 'x-request-id': 'edge-7f3a' });

    await harness.runRequest(ctx);

    expect(ctx.state.requestId).toBe('edge-7f3a');
    expect(ctx.response['X-Request-Id']).toBe('edge-7f3a');
  });

  it('checks the correlation headers in the documented order', async () => {
    const harness = harnessWith();
    const ctx = koaContext({ 'x-correlation-id': 'second', 'x-request-id': 'first' });

    await harness.runRequest(ctx);

    expect(ctx.state.requestId).toBe('first');
  });

  it('replaces an inbound id that is not shaped like one', async () => {
    // The header is client-controlled. Something that is really a sentence, or
    // carries characters that would need escaping downstream, is not trusted.
    const harness = harnessWith();
    const ctx = koaContext({ 'x-request-id': '<script>alert(1)</script>' });

    await harness.runRequest(ctx);

    expect(ctx.state.requestId).toMatch(UUID);
  });

  it('replaces an inbound id that is too long', async () => {
    const harness = harnessWith();
    const ctx = koaContext({ 'x-request-id': 'a'.repeat(129) });

    await harness.runRequest(ctx);

    expect(ctx.state.requestId).toMatch(UUID);
  });

  it('gives every request-borne security record the id', async () => {
    // The point of the exercise: a failed login now carries something a reader
    // can grep for in the proxy log and the application log alike.
    const harness = harnessWith();
    harness.services.security.register();
    const ctx = koaContext();

    await harness.runRequest(ctx, async () => {
      harness.setRequestContext(ctx);
      await harness.emit('admin.auth.error', { error: new Error('Invalid credentials') });
      ctx.status = 400;
    });

    const [row] = harness.auditRows();
    expect(row!.action).toBe('login.failed');
    expect(row!.requestId).toBe(ctx.state.requestId);
    expect(row!.requestId).toMatch(UUID);
  });

  it('gives a denied request the same id it echoed to the client', async () => {
    const harness = harnessWith();
    harness.services.access.register();
    // Not the login path — that one is deliberately excluded from access.denied
    // because login.failed already covers it.
    const ctx = koaContext();
    ctx.request.path = '/admin/users';

    await harness.runRequest(ctx, () => {
      ctx.status = 403;
    });

    const [row] = harness.auditRows();
    expect(row!.action).toBe('access.denied');
    expect(row!.requestId).toBe(ctx.response['X-Request-Id']);
  });

  it('registers nothing when switched off', () => {
    const harness = createFakeStrapi({ schemas: allSchemas, pluginConfig: { correlationId: false } });
    harness.services.correlation.register();
    expect(harness.koaMiddlewares).toHaveLength(0);
  });
});
