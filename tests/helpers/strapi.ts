/**
 * An in-memory stand-in for the pieces of Strapi this plugin touches.
 *
 * Deliberately not a mock-per-test: the interesting behaviour of an audit plugin
 * is the interaction between the Document Service middleware, the snapshot
 * query, the diff and the write, and asserting on that requires something the
 * whole chain can actually run against. What is faked is the boundary Strapi
 * owns — the model registry, `db.query`, `documents`, the request context — with
 * real behaviour for the parts the plugin depends on (populate narrowing,
 * publish/unpublish returning `{ documentId, entries }`, middleware ordering).
 *
 * Every query is recorded in `queryLog`, which is what lets the performance
 * tests assert that a two-field edit on a 173-widget page does not populate 173
 * widgets.
 */

import accessService from '../../server/src/services/access';
import auditService from '../../server/src/services/audit';
import configService from '../../server/src/services/config';
import contextService from '../../server/src/services/context';
import diffService from '../../server/src/services/diff';
import immutabilityService from '../../server/src/services/immutability';
import retentionService from '../../server/src/services/retention';
import securityService from '../../server/src/services/security';
import snapshotService from '../../server/src/services/snapshot';
import trackerService from '../../server/src/services/tracker';

export type Row = Record<string, any>;
export type Schema = Record<string, any>;

export interface QueryLogEntry {
  uid: string;
  method: string;
  where?: Record<string, any>;
  select?: string[];
  populate?: Record<string, any>;
}

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/** Supports the operator subset the plugin actually emits. */
const matchesCondition = (value: unknown, condition: unknown): boolean => {
  if (condition === null) return value === null || value === undefined;

  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    return Object.entries(condition as Record<string, unknown>).every(([operator, operand]) => {
      switch (operator) {
        case '$ne':
          return operand === null ? value !== null && value !== undefined : value !== operand;
        case '$in':
          return Array.isArray(operand) && operand.includes(value as never);
        case '$lt':
          return String(value) < String(operand);
        case '$lte':
          return String(value) <= String(operand);
        case '$gte':
          return String(value) >= String(operand);
        case '$gt':
          return String(value) > String(operand);
        case '$containsi':
          return String(value ?? '')
            .toLowerCase()
            .includes(String(operand).toLowerCase());
        default:
          return false;
      }
    });
  }

  return value === condition;
};

const matchesWhere = (row: Row, where: Record<string, any> | undefined): boolean => {
  if (!where) return true;

  return Object.entries(where).every(([key, condition]) => {
    if (key === '$or') {
      return (condition as Array<Record<string, any>>).some((clause) => matchesWhere(row, clause));
    }
    if (key === '$and') {
      return (condition as Array<Record<string, any>>).every((clause) => matchesWhere(row, clause));
    }
    return matchesCondition(row[key], condition);
  });
};

/**
 * Reduces a stored row to what a `select`/`populate` pair would have returned.
 *
 * This is the behaviour the plugin's performance claims rest on: a field that
 * was not asked for does not come back, so a test can prove the snapshot is
 * narrow simply by looking at what ends up in `before`.
 */
const project = (row: Row, select?: string[], populate?: Record<string, any>): Row => {
  if (!select && !populate) return clone(row);

  const result: Row = {};

  for (const key of select ?? []) {
    if (key in row) result[key] = clone(row[key]);
  }

  for (const [key, spec] of Object.entries(populate ?? {})) {
    if (!(key in row)) continue;

    const value = row[key];

    // A `{ select: [...] }` populate keeps only those fields of the related
    // record — the plugin uses it to reduce relations to identifying fields.
    const nestedSelect = spec && typeof spec === 'object' ? (spec as Row).select : undefined;

    if (Array.isArray(nestedSelect) && value) {
      const pick = (item: Row): Row => {
        const picked: Row = {};
        for (const field of nestedSelect) if (field in item) picked[field] = clone(item[field]);
        return picked;
      };
      result[key] = Array.isArray(value) ? value.map(pick) : pick(value);
      continue;
    }

    result[key] = clone(value);
  }

  return result;
};

export interface FakeStrapiOptions {
  schemas?: Record<string, Schema>;
  data?: Record<string, Row[]>;
  pluginConfig?: Record<string, unknown>;
  requestContext?: Record<string, any> | null;
}

export const createFakeStrapi = (options: FakeStrapiOptions = {}) => {
  const schemas: Record<string, Schema> = { ...(options.schemas ?? {}) };
  const tables: Record<string, Row[]> = {};
  const queryLog: QueryLogEntry[] = [];
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] };
  const cronJobs: Record<string, { task: () => Promise<void>; options: string }> = {};
  const documentMiddlewares: Array<(ctx: any, next: () => Promise<any>) => Promise<any>> = [];
  /** Koa middlewares registered through `strapi.server.use`, in registration order. */
  const koaMiddlewares: Array<(ctx: any, next: () => Promise<any>) => Promise<any>> = [];
  /** `eventHub` listeners, keyed by event name — the same shape Strapi's own hub keeps. */
  const eventListeners = new Map<string, Array<(...args: any[]) => Promise<void>>>();

  let nextId = 1;
  let requestContext: Record<string, any> | null = options.requestContext ?? null;

  for (const [uid, rows] of Object.entries(options.data ?? {})) {
    tables[uid] = rows.map((row) => ({ id: row.id ?? nextId++, ...row }));
  }

  const table = (uid: string): Row[] => {
    if (!tables[uid]) tables[uid] = [];
    return tables[uid] as Row[];
  };

  const query = (uid: string) => ({
    async findMany(params: Row = {}) {
      queryLog.push({ uid, method: 'findMany', where: params.where, select: params.select, populate: params.populate });
      return table(uid)
        .filter((row) => matchesWhere(row, params.where))
        .map((row) => project(row, params.select, params.populate));
    },

    async findOne(params: Row = {}) {
      queryLog.push({ uid, method: 'findOne', where: params.where, select: params.select, populate: params.populate });
      const row = table(uid).find((candidate) => matchesWhere(candidate, params.where));
      return row ? project(row, params.select, params.populate) : null;
    },

    async findPage(params: Row = {}) {
      queryLog.push({ uid, method: 'findPage', where: params.where });

      const matched = table(uid).filter((row) => matchesWhere(row, params.where));

      const [field, direction] = Object.entries(params.orderBy ?? { createdAt: 'desc' })[0] as [
        string,
        string,
      ];
      matched.sort((a, b) => {
        const left = String(a[field] ?? '');
        const right = String(b[field] ?? '');
        return direction === 'asc' ? left.localeCompare(right) : right.localeCompare(left);
      });

      const page = params.page ?? 1;
      const pageSize = params.pageSize ?? 20;
      const start = (page - 1) * pageSize;

      return {
        results: matched.slice(start, start + pageSize).map((row) => clone(row)),
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(matched.length / pageSize),
          total: matched.length,
        },
      };
    },

    async create(params: Row) {
      queryLog.push({ uid, method: 'create' });
      const row: Row = {
        id: nextId++,
        documentId: `doc-${nextId}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...clone(params.data),
      };
      table(uid).push(row);
      return clone(row);
    },

    async delete(params: Row) {
      queryLog.push({ uid, method: 'delete', where: params.where });
      const rows = table(uid);
      const index = rows.findIndex((row) => matchesWhere(row, params.where));
      if (index === -1) return null;
      const [removed] = rows.splice(index, 1);
      return clone(removed);
    },

    async deleteMany(params: Row = {}) {
      queryLog.push({ uid, method: 'deleteMany', where: params.where });
      const rows = table(uid);
      const keep = rows.filter((row) => !matchesWhere(row, params.where));
      const count = rows.length - keep.length;
      tables[uid] = keep;
      return { count };
    },

    async count(params: Row = {}) {
      return table(uid).filter((row) => matchesWhere(row, params.where)).length;
    },
  });

  const services: Record<string, any> = {};

  const strapi: Record<string, any> = {
    getModel: (uid: string) => {
      const schema = schemas[uid];
      if (!schema) throw new Error(`Model "${uid}" not found`);
      return schema;
    },

    contentType: (uid: string) => schemas[uid],

    /**
     * The content-type registry, as the filter-options builder reads it.
     *
     * Components live in `schemas` too but are not content types, so they are
     * filtered out here exactly as Strapi's own registry would.
     */
    get contentTypes() {
      return Object.fromEntries(
        Object.entries(schemas).filter(([, schema]) => schema?.modelType !== 'component')
      );
    },

    config: {
      get: (path: string, fallback?: unknown) =>
        path === 'plugin::audit-log' ? (options.pluginConfig ?? {}) : fallback,
    },

    db: {
      query,
      connection: () => {
        throw new Error('knex is not available in the test harness');
      },
      metadata: {
        get: (uid: string) => ({
          tableName: uid.replace(/[^a-z0-9]/gi, '_').toLowerCase(),
          attributes: Object.fromEntries(
            Object.keys(schemas[uid]?.attributes ?? {}).map((name) => [
              name,
              { columnName: name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) },
            ])
          ),
        }),
      },
    },

    documents: {
      use: (middleware: (ctx: any, next: () => Promise<any>) => Promise<any>) => {
        documentMiddlewares.push(middleware);
        return strapi.documents;
      },
    },

    requestContext: {
      get: () => requestContext ?? undefined,
    },

    /**
     * A faithful stand-in for Strapi's event hub, including the two properties
     * the security service depends on: `emit` *awaits* its listeners in
     * sequence, and `on` returns an unsubscribe function.
     */
    eventHub: {
      on: (event: string, listener: (...args: any[]) => Promise<void>) => {
        const listeners = eventListeners.get(event) ?? [];
        listeners.push(listener);
        eventListeners.set(event, listeners);
        return () => {
          const current = eventListeners.get(event) ?? [];
          const index = current.indexOf(listener);
          if (index >= 0) current.splice(index, 1);
        };
      },
      emit: async (event: string, ...args: any[]) => {
        for (const listener of eventListeners.get(event) ?? []) {
          await listener(...args);
        }
      },
    },

    server: {
      use: (middleware: (ctx: any, next: () => Promise<any>) => Promise<any>) => {
        koaMiddlewares.push(middleware);
        return strapi.server;
      },
    },

    cron: {
      add: (tasks: Record<string, { task: () => Promise<void>; options: string }>) => {
        Object.assign(cronJobs, tasks);
      },
      remove: (name: string) => {
        delete cronJobs[name];
      },
    },

    log: {
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
      error: (message: string) => logs.error.push(message),
      debug: (message: string) => logs.debug.push(message),
    },

    plugin: (_id: string) => ({
      service: (name: string) => services[name],
    }),

    service: (_uid: string) => ({
      actionProvider: { registerMany: async () => undefined },
    }),
  };

  // Services are created after `strapi` exists because each closes over it.
  services.config = configService({ strapi: strapi as never });
  services.diff = diffService({ strapi: strapi as never });
  services.context = contextService({ strapi: strapi as never });
  services.snapshot = snapshotService({ strapi: strapi as never });
  services.audit = auditService({ strapi: strapi as never });
  services.tracker = trackerService({ strapi: strapi as never });
  services.retention = retentionService({ strapi: strapi as never });
  services.immutability = immutabilityService({ strapi: strapi as never });
  services.security = securityService({ strapi: strapi as never });
  services.access = accessService({ strapi: strapi as never });

  /**
   * Runs an action through the registered Document Service middlewares, exactly
   * as Strapi's `middleware-manager` does — including the ordering that puts the
   * immutability guard ahead of the tracker.
   */
  const runDocumentAction = async (
    uid: string,
    action: string,
    params: Record<string, any>,
    handler: () => Promise<unknown>
  ): Promise<unknown> => {
    const ctx = { uid, action, params, contentType: schemas[uid] };

    let index = 0;
    const next = async (): Promise<unknown> => {
      if (index < documentMiddlewares.length) {
        const middleware = documentMiddlewares[index++];
        return middleware!(ctx, next);
      }
      return handler();
    };

    return next();
  };

  /**
   * Runs a request through the registered Koa middlewares.
   *
   * `handler` stands in for the router: it sets the final status and body, which
   * is what the access middleware inspects once `next()` unwinds back to it.
   */
  const runRequest = async (
    ctx: Record<string, any>,
    handler: () => void | Promise<void> = () => undefined
  ): Promise<Record<string, any>> => {
    let index = 0;
    const next = async (): Promise<unknown> => {
      if (index < koaMiddlewares.length) {
        const middleware = koaMiddlewares[index++];
        return middleware!(ctx, next);
      }
      return handler();
    };

    await next();
    return ctx;
  };

  return {
    strapi,
    services,
    koaMiddlewares,
    eventListeners,
    runRequest,
    emit: (event: string, ...args: any[]) => strapi.eventHub.emit(event, ...args),
    schemas,
    tables,
    table,
    queryLog,
    logs,
    cronJobs,
    runDocumentAction,
    auditRows: () => table('plugin::audit-log.audit-log'),
    setRequestContext: (ctx: Record<string, any> | null) => {
      requestContext = ctx;
    },
    addSchema: (uid: string, schema: Schema) => {
      schemas[uid] = schema;
    },
    seed: (uid: string, rows: Row[]) => {
      tables[uid] = rows.map((row) => ({ id: row.id ?? nextId++, ...row }));
    },
    /** Populate specs the harness saw for a given uid, for the efficiency tests. */
    populatesFor: (uid: string) =>
      queryLog.filter((entry) => entry.uid === uid && entry.populate).map((entry) => entry.populate!),
  };
};

export type FakeStrapi = ReturnType<typeof createFakeStrapi>;
