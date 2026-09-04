import { AsyncLocalStorage } from 'node:async_hooks';

import type { Core } from '@strapi/strapi';

import { REQUEST_ID_HEADERS } from '../constants';
import type { AuditContext, AuditSource } from '../types';

/**
 * Overrides for code that runs outside a request.
 *
 * A migration script or a cron task has no Koa context, so without this every
 * such write would land as `source: "system"` with no actor. `runAs` lets the
 * consuming application label its own background work without the plugin having
 * to guess, and without any caller-supplied value ever reaching an HTTP request
 * — this store is process-local and can only be written from server code.
 */
export interface SourceOverride {
  source: AuditSource;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}

const overrideStorage = new AsyncLocalStorage<SourceOverride>();

const EMPTY_CONTEXT: AuditContext = {
  source: 'system',
  userId: null,
  userEmail: null,
  userName: null,
  ipAddress: null,
  userAgent: null,
  requestId: null,
};

const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
};

/** Best available human label for an actor, in decreasing order of usefulness. */
const resolveUserName = (user: Record<string, unknown>): string | null => {
  const firstname = asString(user.firstname);
  const lastname = asString(user.lastname);
  if (firstname && lastname) return `${firstname} ${lastname}`;

  return asString(user.username) ?? firstname ?? lastname ?? asString(user.email);
};

/**
 * Derives who did what, from where.
 *
 * Everything comes from the server-side Koa context that Strapi keeps in
 * AsyncLocalStorage (`strapi.requestContext`). Nothing is read from the request
 * body or from a client-settable header other than the correlation id, which is
 * treated as an opaque label and never used for authorisation — a client that
 * lies about it can only confuse its own trace.
 */
const contextService = ({ strapi }: { strapi: Core.Strapi }) => {
  /**
   * Runs `callback` with an explicit source label.
   *
   * ```ts
   * const audit = strapi.plugin('audit-log').service('context');
   * await audit.runAs({ source: 'migration' }, () => importEverything());
   * ```
   *
   * The label applies to every audited write inside the callback, including
   * asynchronous ones, and is restored automatically when it returns.
   */
  const runAs = <T>(override: SourceOverride, callback: () => T): T =>
    overrideStorage.run(override, callback);

  const getRequestContext = (): Record<string, any> | undefined => {
    try {
      return strapi.requestContext?.get?.() as Record<string, any> | undefined;
    } catch {
      // `requestContext` is a plain AsyncLocalStorage wrapper and does not throw
      // in practice, but a partially-booted Strapi in a test harness might not
      // have it at all. Audit context is best-effort by design.
      return undefined;
    }
  };

  /**
   * Classifies the request.
   *
   * `state.auditSource` is checked first because Strapi's own EE audit log uses
   * that exact key for out-of-band sources (its MCP integration sets it), so
   * honouring it keeps the two logs telling the same story.
   */
  const resolveSource = (ctx: Record<string, any> | undefined): AuditSource => {
    const declared = asString(ctx?.state?.auditSource);
    if (declared) return declared as AuditSource;

    const routeType = asString(ctx?.state?.route?.info?.type);
    if (routeType === 'admin') return 'admin';
    if (routeType === 'content-api') return 'api';

    const strategyName = asString(ctx?.state?.auth?.strategy?.name);
    if (strategyName === 'admin') return 'admin';
    if (strategyName === 'api-token' || strategyName === 'users-permissions') return 'api';

    // A request context exists but matches no known shape — a custom route with
    // `auth: false`, typically. Recording `unknown` is more useful than silently
    // calling it `api`.
    return ctx ? 'unknown' : 'system';
  };

  const resolve = (): AuditContext => {
    const override = overrideStorage.getStore();
    const ctx = getRequestContext();

    if (!ctx) {
      if (!override) return EMPTY_CONTEXT;
      return {
        ...EMPTY_CONTEXT,
        source: override.source,
        userId: asString(override.userId),
        userEmail: asString(override.userEmail),
        userName: asString(override.userName),
      };
    }

    const user = (ctx.state?.user ?? null) as Record<string, unknown> | null;

    const headers = (ctx.request?.headers ?? ctx.req?.headers ?? {}) as Record<string, unknown>;
    const requestId =
      asString(ctx.state?.requestId) ??
      REQUEST_ID_HEADERS.map((header) => asString(headers[header])).find(Boolean) ??
      null;

    return {
      // An explicit override wins even inside a request: a controller that
      // deliberately labels its work knows more than the route type does.
      source: override?.source ?? resolveSource(ctx),

      userId: asString(override?.userId ?? user?.id),
      userEmail: asString(override?.userEmail ?? user?.email),
      userName: override?.userName !== undefined ? asString(override.userName) : user ? resolveUserName(user) : null,

      // `ctx.request.ip` honours Koa's `proxy` setting, so behind a correctly
      // configured load balancer this is the client address rather than the
      // proxy's. With `proxy` off it ignores `X-Forwarded-For` entirely, which
      // is the safe default — a spoofable header is worse than no address.
      ipAddress: asString(ctx.request?.ip ?? ctx.ip),
      userAgent: asString(headers['user-agent']),
      requestId,
    };
  };

  return { resolve, runAs };
};

export default contextService;
