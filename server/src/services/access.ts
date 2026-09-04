import type { Core } from '@strapi/strapi';

import { ACCESS_IGNORED_PATHS, DENIED_STATUSES, SUBJECTS } from '../constants';

type KoaContext = Record<string, any>;

/** Longest path recorded. A URL is attacker-controlled; the column is not unbounded. */
const MAX_PATH_LENGTH = 512;

const asString = (value: unknown, maxLength = 256): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text.slice(0, maxLength);
};

/**
 * Records requests Strapi refused: `401 Unauthorized` and `403 Forbidden`.
 *
 * This is the "unauthorized access / permission failures" line of a security
 * review, and it is the one part of the audit trail that cannot come from an
 * event, because Strapi emits none for a refusal. A denial is not a write, has
 * no entity and touches no content type — it exists only as an HTTP status.
 *
 * ## Why this middleware sits outermost, and how it gets there
 *
 * `strapi.server.use()` appends to the Koa stack, and Strapi's boot order is:
 *
 * ```
 *   register()            <- plugin register lifecycles run here
 *   bootstrap()
 *     server.initMiddlewares()   <- config/middlewares.ts is applied
 *     server.initRouting()       <- routes and their policies are mounted
 *     bootstrap lifecycles       <- plugin bootstrap runs here
 * ```
 *
 * Registered from the plugin's `register`, this lands ahead of every configured
 * middleware and ahead of the router — so by the time `await next()` returns,
 * `strapi::errors` has already turned any thrown `ForbiddenError` into a status
 * and `ctx.status` is final. Registered from `bootstrap` it would land *after*
 * the router, see nothing, and fail silently. That ordering is the entire reason
 * this service is wired up in `register.ts` rather than alongside the others in
 * `bootstrap.ts`.
 *
 * ## What is deliberately not recorded
 *
 * A failed login is a 401, and it already produces a far better record from
 * `admin.auth.error` — one that names the account that was tried. Recording the
 * status too would double every wrong-password attempt, so the login and
 * token-refresh paths are excluded by {@link ACCESS_IGNORED_PATHS}. 404s are
 * excluded as well: Strapi answers an unauthorised *content API* read with a
 * 404 rather than a 403 to avoid confirming that a document exists, and
 * recording every 404 to catch those would bury the log in typos and favicon
 * requests.
 */
const accessService = ({ strapi }: { strapi: Core.Strapi }) => {
  const plugin = () => strapi.plugin('audit-log');

  let registered = false;

  const isIgnoredPath = (path: string): boolean =>
    ACCESS_IGNORED_PATHS.some((pattern) => pattern.test(path));

  /**
   * Best label for whoever made the request.
   *
   * A 403 has an authenticated user and is the more interesting of the two — it
   * says a known account reached for something it may not have. A 401 usually
   * has nobody, and the address plus the path is all there is to record.
   */
  const actorOf = (ctx: KoaContext) => {
    const user = (ctx.state?.user ?? null) as Record<string, unknown> | null;
    if (!user) return { userId: null, userEmail: null, userName: null };

    const firstname = asString(user.firstname);
    const lastname = asString(user.lastname);

    return {
      userId: asString(user.id),
      userEmail: asString(user.email),
      userName:
        firstname && lastname
          ? `${firstname} ${lastname}`
          : asString(user.username) ?? firstname ?? lastname ?? asString(user.email),
    };
  };

  /** `admin` for an admin-API route, `api` for the content API, `unknown` for anything else. */
  const sourceOf = (ctx: KoaContext) => {
    const routeType = asString(ctx.state?.route?.info?.type);
    if (routeType === 'admin') return 'admin' as const;
    if (routeType === 'content-api') return 'api' as const;

    const strategy = asString(ctx.state?.auth?.strategy?.name);
    if (strategy === 'admin') return 'admin' as const;
    if (strategy === 'api-token' || strategy === 'users-permissions') return 'api' as const;

    // A refusal that never reached a route — an unauthenticated request to an
    // admin path, typically. The path in the metadata says what was reached for.
    return 'unknown' as const;
  };

  const recordDenial = async (ctx: KoaContext): Promise<void> => {
    const headers = (ctx.request?.headers ?? {}) as Record<string, unknown>;

    await plugin().service('audit').record({
      action: 'access.denied',
      contentType: SUBJECTS.access,
      contentTypeDisplayName: 'Access control',
      contentDocumentId: null,
      contentId: null,
      locale: null,
      changes: null,
      before: null,
      after: null,
      outcome: 'failure',
      metadata: {
        method: asString(ctx.request?.method, 16),
        path: asString(ctx.request?.path, MAX_PATH_LENGTH),
        statusCode: ctx.status,
        // Strapi's error handler puts a reason in the body. It is the difference
        // between "no session" and "your role lacks this permission", which is
        // the first thing anyone reading the row wants to know.
        reason: asString((ctx.body as Record<string, any>)?.error?.message) ?? null,
        routeType: asString(ctx.state?.route?.info?.type),
      },
      source: sourceOf(ctx),
      ...actorOf(ctx),
      ipAddress: asString(ctx.request?.ip ?? ctx.ip, 64),
      userAgent: asString(headers['user-agent'], 512),
      requestId: asString(ctx.state?.requestId ?? headers['x-request-id']),
    });
  };

  const createMiddleware = () => {
    return async (ctx: KoaContext, next: () => Promise<unknown>): Promise<void> => {
      await next();

      if (!DENIED_STATUSES.has(ctx.status)) return;

      const path = String(ctx.request?.path ?? '');
      if (isIgnoredPath(path)) return;

      if (!plugin().service('config').isAuditedSecurityAction('access.denied')) return;

      try {
        await recordDenial(ctx);
      } catch (error) {
        // The response has already been decided; the only thing throwing here
        // could change is turning a clean 403 into a 500.
        strapi.log.error(
          `[audit-log] failed to record a denied request: ${(error as Error)?.message ?? error}`
        );
      }
    };
  };

  /**
   * Adds the middleware to the Koa stack.
   *
   * Must be called from the plugin's `register` lifecycle — see the note on this
   * service. Guarded against a second call so a re-registration in the same
   * process cannot produce two records per denial.
   */
  const register = (): void => {
    if (registered) return;
    if (!plugin().service('config').isAuditedSecurityAction('access.denied')) return;

    strapi.server.use(createMiddleware() as never);
    registered = true;
  };

  return { createMiddleware, register, recordDenial, sourceOf, isIgnoredPath };
};

export default accessService;
