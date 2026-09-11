import type { Core } from '@strapi/strapi';

import type { AuditLogQuery } from '../types';

type KoaContext = {
  query: Record<string, unknown>;
  params: Record<string, string>;
  body: unknown;
  badRequest: (message: string) => unknown;
  notFound: (message?: string) => unknown;
};

/** Only these keys are read off the query string. Anything else is discarded. */
const ALLOWED_QUERY_KEYS = [
  'page',
  'pageSize',
  'sort',
  'action',
  'contentType',
  'userId',
  'locale',
  'source',
  'outcome',
  'contentDocumentId',
  'dateFrom',
  'dateTo',
  '_q',
] as const;

const MAX_STRING_FILTER_LENGTH = 256;

/**
 * Coerces one query-string value into a string or array of strings.
 *
 * Koa's query parser will happily hand back a nested object if a client sends
 * `?action[$gt]=x`, and passing that straight into a `where` clause is how a
 * filter parameter becomes an operator-injection vector. Objects are rejected
 * outright; only scalars and flat arrays of scalars survive.
 */
const asFilterValue = (value: unknown): string | string[] | undefined => {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    const items = value
      .filter((item) => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item).slice(0, MAX_STRING_FILTER_LENGTH));
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'object') return undefined;

  const text = String(value).slice(0, MAX_STRING_FILTER_LENGTH);
  return text.length > 0 ? text : undefined;
};

/** Parses and validates the `:id` path parameter. */
const parseId = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  // `Number('12abc')` is NaN but `parseInt` would return 12, so use the strict one.
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) return null;
  return id;
};

/**
 * Admin-only HTTP surface.
 *
 * Every route is registered with `type: 'admin'` and guarded by
 * `admin::isAuthenticatedAdmin` plus an explicit `admin::hasPermissions` check —
 * see `routes/admin.ts`. Nothing here re-implements authentication or
 * authorisation; the controller runs only once Strapi's own RBAC has said yes.
 *
 * There is deliberately no create, update or delete handler. Audit records are
 * written by the plugin and read by humans; nothing in between. Deletion was
 * removed in 1.2.0 — see `routes/admin.ts` for why.
 */
const auditLogController = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = (name: string) => strapi.plugin('audit-log').service(name);

  return {
    async find(ctx: KoaContext) {
      const query: AuditLogQuery = {};

      for (const key of ALLOWED_QUERY_KEYS) {
        const value = asFilterValue(ctx.query[key]);
        if (value === undefined) continue;

        if (key === 'page' || key === 'pageSize') {
          const parsed = Number(Array.isArray(value) ? value[0] : value);
          if (Number.isFinite(parsed)) query[key] = parsed;
          continue;
        }

        if (key === 'sort' || key === 'contentDocumentId' || key === 'dateFrom' || key === 'dateTo' || key === '_q') {
          query[key] = Array.isArray(value) ? value[0] : value;
          continue;
        }

        query[key] = value;
      }

      ctx.body = await service('audit').find(query);
    },

    async findOne(ctx: KoaContext) {
      const id = parseId(ctx.params.id);
      if (id === null) return ctx.badRequest('Invalid audit log id.');

      const log = await service('audit').findOne(id);
      if (!log) return ctx.notFound('Audit log not found.');

      ctx.body = { data: log };
    },

    /** Filter dropdown options, derived from the rows that actually exist. */
    async filters(ctx: KoaContext) {
      ctx.body = { data: await service('audit').getFilterOptions() };
    },

    /** The effective configuration, so the UI can hide controls for disabled features. */
    async config(ctx: KoaContext) {
      ctx.body = { data: service('config').getPublicConfig() };
    },

    /** Verifies the hash chain end to end. See `services/integrity.ts`. */
    async integrity(ctx: KoaContext) {
      ctx.body = { data: await service('integrity').verify() };
    },
  };
};

export default auditLogController;
