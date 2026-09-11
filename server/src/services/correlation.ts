import { randomUUID } from 'node:crypto';

import type { Core } from '@strapi/strapi';

import { REQUEST_ID_HEADERS, REQUEST_ID_RESPONSE_HEADER } from '../constants';

type KoaContext = Record<string, any>;

/** Longest inbound id honoured. A header is client-controlled; the column is not unbounded. */
const MAX_ID_LENGTH = 128;

/** Characters an inbound id may contain. Anything else is replaced, not trusted. */
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  return text.length === 0 ? null : text;
};

/**
 * Gives every request a correlation id.
 *
 * ASVS V7 wants each log event correlatable with the application and
 * infrastructure logs around it. The plugin already recorded `requestId` when
 * one arrived on a header, and the assessment found it null on ~90% of records —
 * because the admin panel sends no such header, and neither does anything else
 * unless a proxy in front of Strapi adds one. So nearly every record came in
 * without.
 *
 * This middleware closes that: an inbound id is honoured (a proxy or a tracing
 * system that already assigns one stays authoritative), and a missing one is
 * minted. Either way it goes on `ctx.state.requestId`, which is what
 * `context.ts`, `security.ts` and `access.ts` already read first, and it is
 * echoed back as `X-Request-Id` so the client — and the proxy's access log —
 * sees the same id the audit record carries. Correlation that only works from
 * the inside is not correlation.
 *
 * Registered from the plugin's `register` lifecycle, ahead of the access
 * middleware, for the same reason that one is: only there does it land in front
 * of the router. See `access.ts` for the boot-order note.
 *
 * Records written outside a request — bootstrap, cron, a migration — still have
 * no request id. There is no request to correlate them with.
 */
const correlationService = ({ strapi }: { strapi: Core.Strapi }) => {
  let registered = false;

  /** The inbound id, when there is one and it is shaped like an id. */
  const inboundId = (ctx: KoaContext): string | null => {
    const headers = (ctx.request?.headers ?? {}) as Record<string, unknown>;

    for (const header of REQUEST_ID_HEADERS) {
      const value = asString(headers[header]);
      if (!value) continue;

      // Honoured only when it looks like an id. A header that is really a
      // sentence, or carries characters that would need escaping downstream, is
      // replaced rather than stored — the id is an opaque label and a client that
      // sends a bad one only loses its own trace.
      if (value.length <= MAX_ID_LENGTH && SAFE_ID.test(value)) return value;
    }

    return null;
  };

  const createMiddleware = () => {
    return async (ctx: KoaContext, next: () => Promise<unknown>): Promise<void> => {
      const id = asString(ctx.state?.requestId) ?? inboundId(ctx) ?? randomUUID();

      ctx.state.requestId = id;

      try {
        ctx.set(REQUEST_ID_RESPONSE_HEADER, id);
      } catch {
        // A context without a settable response (a test double, typically).
        // The id is still on state, which is the part the audit trail needs.
      }

      await next();
    };
  };

  const register = (): void => {
    if (registered) return;
    if (!strapi.plugin('audit-log').service('config').resolve().correlationId) return;

    strapi.server.use(createMiddleware() as never);
    registered = true;
  };

  return { createMiddleware, register, inboundId };
};

export default correlationService;
